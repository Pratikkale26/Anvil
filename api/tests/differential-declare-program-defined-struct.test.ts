/**
 * #2 / S4 — declare_program! CPI with a DEFINED-STRUCT arg, BYTE-EQUAL gated.
 * The caller's instruction takes an external struct (`args:
 * proc_program::types::MyArgs`) and forwards it to
 * proc_program::cpi::process(args). This exercises EXTERNAL-TYPE GENERATION:
 * Anvil injects the `MyArgs` struct def (from the IDL `types`) so the caller can
 * deserialize the arg, rewrites the `proc_program::types::MyArgs` ref to the
 * bare name, and Borsh-encodes the struct's fields (in order) into the CPI data.
 * The callee writes a/b/label_len into a ProcState account; a wrong field order,
 * a mis-generated struct, or a mis-encoded field diverges.
 *
 * Self-contained: caller source + IDL committed/embedded, proc_program.so the
 * committed callee. Skips (loud) without the SBF toolchain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_SCRATCH } from "./scratch-root.ts";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROC_ID = "5LHAwewPdBHTTwLg91GAakUUn8SKJ11bj4qYr5LsTmc";
const CALLER_ID = "FVqg2o9uJaJa7Wn3SRDwWAkbsaR7q79maXNUfFoBo9BP";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(proc_program);
use proc_program::program::ProcProgram;
#[program]
pub mod proc_caller {
    use super::*;
    pub fn do_process(ctx: Context<DoProcess>, args: proc_program::types::MyArgs) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.proc_program.key(),
            proc_program::cpi::accounts::Process { state: ctx.accounts.state.to_account_info() },
        );
        proc_program::cpi::process(cpi_ctx, args)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoProcess<'info> {
    #[account(mut)]
    pub state: Account<'info, proc_program::accounts::ProcState>,
    pub proc_program: Program<'info, ProcProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "proc_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "proc_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "proc-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "proc_program.so"));

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-proc-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/proc_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-defined-struct] SKIPPED — proc_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-defined-struct",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "proc_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { proc_program: idl },
    auxiliaryPrograms: [{ programId: PROC_ID, soFilename: "proc_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({ payer: Keypair.generate(), state: Keypair.generate() }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const procId = new PublicKey(PROC_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      // init ProcState directly via proc_program (state + payer sign).
      const initIx = new TransactionInstruction({
        programId: procId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_proc")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.state);
        svm.sendTransaction(tx);
      }

      // do_process(MyArgs{a:7, b:9, label:"hi"}) via the caller → CPIs process.
      // Borsh struct = fields in order: u64 + u32 + String.
      const data = concatBytes(
        anchorIxDiscriminator("do_process"),
        encodeU64LE(7n),
        Uint8Array.from([9, 0, 0, 0]), // u32 LE = 9
        borshString("hi"),
      );
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: false, isWritable: true },
          { pubkey: procId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(data),
      });
      {
        const tx = new Transaction().add(doIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx);
      }
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.state.publicKey, label: "proc_state" }],
  });
}
