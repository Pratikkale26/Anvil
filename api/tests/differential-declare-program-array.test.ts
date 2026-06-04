/**
 * #2 / S4 — declare_program! CPI with a non-u8 fixed array arg, BYTE-EQUAL.
 * Borsh [T; N] = the N elements in order, NO length prefix. The caller CPIs
 * arr_program::cpi::set_vals(vals: [u64; 3]); Anvil iterates the array by value
 * and encodes each element. The callee writes vals into an ArrState account, so
 * a missing/extra element or wrong per-element encoding diverges. This closes
 * the last declare_program! arg shape (literal 100%).
 *
 * Self-contained: caller source + IDL committed/embedded, arr_program.so the
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

const ARR_ID = "6kfQAHSuJPdXcSzo8SDyL6cHPkt8kp1dxtbRZm43MxJd";
const CALLER_ID = "EDHhAqawHLXkn5G9sQmDMZH2iduPC7q6YPAYckTj6p3H";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(arr_program);
use arr_program::program::ArrProgram;
#[program]
pub mod arr_caller {
    use super::*;
    pub fn do_vals(ctx: Context<DoVals>, vals: [u64; 3]) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.arr_program.key(),
            arr_program::cpi::accounts::SetVals { state: ctx.accounts.state.to_account_info() },
        );
        arr_program::cpi::set_vals(cpi_ctx, vals)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoVals<'info> {
    #[account(mut)]
    pub state: Account<'info, arr_program::accounts::ArrState>,
    pub arr_program: Program<'info, ArrProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "arr_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "arr_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "arr-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "arr_program.so"));

function prepareCallerCrate(): string {
  const dir = "/tmp/anvil-arr-caller";
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/arr_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-array] SKIPPED — arr_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();
  const vals = [100n, 200n, 300n];

  defineDifferential({
    fixtureName: "declare-program-array",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "arr_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { arr_program: idl },
    auxiliaryPrograms: [{ programId: ARR_ID, soFilename: "arr_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({ payer: Keypair.generate(), state: Keypair.generate() }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const arrId = new PublicKey(ARR_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      const initIx = new TransactionInstruction({
        programId: arrId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_arr")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.state);
        svm.sendTransaction(tx);
      }

      // do_vals([100,200,300]) → CPIs set_vals. Borsh [u64;3] = 3 u64 LE, no length.
      const data = concatBytes(anchorIxDiscriminator("do_vals"), ...vals.map((n) => encodeU64LE(n)));
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: false, isWritable: true },
          { pubkey: arrId, isSigner: false, isWritable: false },
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

    accountsToCompare: (ctx) => [{ pubkey: ctx.state.publicKey, label: "arr_state" }],
  });
}
