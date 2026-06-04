/**
 * #2 / S4 — declare_program! CPI with Vec<T> and fixed [u8; N] args, BYTE-EQUAL.
 * Borsh Vec<T> = u32 LE length + each element; [u8; N] = the N raw bytes (no
 * length). The caller CPIs coll_program::cpi::set_both(items: Vec<u64>, tag:
 * [u8; 4]); the callee writes items.len() + sum(items) + tag into a CollState
 * account, so a wrong length prefix, missing/extra element, or mis-copied array
 * diverges. The scenario passes items=[10,20,30], tag=[1,2,3,4].
 *
 * Self-contained: caller source + IDL committed/embedded, coll_program.so the
 * committed callee. Skips (loud) without the SBF toolchain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const COLL_ID = "5ZXGoD3pkRBNVNh2Tty9ZQTmRyiAUGzCBhSEpgrctyYA";
const CALLER_ID = "H81QEXBXDUfqiZpbW1PixgmriRwv4f1EcCtmjxZgoVuC";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(coll_program);
use coll_program::program::CollProgram;
#[program]
pub mod coll_caller {
    use super::*;
    pub fn do_both(ctx: Context<DoBoth>, items: Vec<u64>, tag: [u8; 4]) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.coll_program.key(),
            coll_program::cpi::accounts::SetBoth { state: ctx.accounts.state.to_account_info() },
        );
        coll_program::cpi::set_both(cpi_ctx, items, tag)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoBoth<'info> {
    #[account(mut)]
    pub state: Account<'info, coll_program::accounts::CollState>,
    pub coll_program: Program<'info, CollProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "coll_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "coll_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "coll-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "coll_program.so"));

function prepareCallerCrate(): string {
  const dir = "/tmp/anvil-coll-caller";
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/coll_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-collections] SKIPPED — coll_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();
  const items = [10n, 20n, 30n];
  const tag = [1, 2, 3, 4];

  defineDifferential({
    fixtureName: "declare-program-collections",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "coll_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { coll_program: idl },
    auxiliaryPrograms: [{ programId: COLL_ID, soFilename: "coll_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({ payer: Keypair.generate(), state: Keypair.generate() }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const collId = new PublicKey(COLL_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      // init CollState directly via coll_program (state + payer sign).
      const initIx = new TransactionInstruction({
        programId: collId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_coll")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.state);
        svm.sendTransaction(tx);
      }

      // do_both via the caller → CPIs set_both. Borsh: Vec<u64> = u32 len + each
      // u64 LE; [u8;4] = the raw 4 bytes.
      const vecLen = Buffer.alloc(4);
      vecLen.writeUInt32LE(items.length, 0);
      const data = concatBytes(
        anchorIxDiscriminator("do_both"),
        vecLen,
        ...items.map((n) => encodeU64LE(n)),
        Uint8Array.from(tag),
      );
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: false, isWritable: true },
          { pubkey: collId, isSigner: false, isWritable: false },
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

    accountsToCompare: (ctx) => [{ pubkey: ctx.state.publicKey, label: "coll_state" }],
  });
}
