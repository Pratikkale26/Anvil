/**
 * #2 / S4 — declare_program! CPI with an Option<T> arg, BYTE-EQUAL gated.
 * Borsh Option = a 1-byte tag (0 None / 1 Some) + (if Some) the inner value. The
 * caller CPIs opt_program::cpi::set_maybe(value: Option<u64>); the callee writes
 * is_some + value into an OptState account, so a wrong tag or mis-encoded inner
 * diverges. The scenario passes Some(42) (exercises the tag + the inner u64).
 *
 * Self-contained: caller source + IDL committed/embedded, opt_program.so the
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

const OPT_ID = "5cNCJmMxUs7VHfnw85krhgM7jMPmMdbCbt95rxxvUmXf";
const CALLER_ID = "GV1uM8RP492MULSg3g7MbPMt5GMXWyKv2eWPgwzvSDDS";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(opt_program);
use opt_program::program::OptProgram;
#[program]
pub mod opt_caller {
    use super::*;
    pub fn do_maybe(ctx: Context<DoMaybe>, value: Option<u64>) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.opt_program.key(),
            opt_program::cpi::accounts::SetMaybe { state: ctx.accounts.state.to_account_info() },
        );
        opt_program::cpi::set_maybe(cpi_ctx, value)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoMaybe<'info> {
    #[account(mut)]
    pub state: Account<'info, opt_program::accounts::OptState>,
    pub opt_program: Program<'info, OptProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "opt_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "opt_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opt-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "opt_program.so"));

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-opt-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/opt_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-option] SKIPPED — opt_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-option",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "opt_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { opt_program: idl },
    auxiliaryPrograms: [{ programId: OPT_ID, soFilename: "opt_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({ payer: Keypair.generate(), state: Keypair.generate() }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const optId = new PublicKey(OPT_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      // init OptState directly via opt_program (state + payer sign the new account).
      const initIx = new TransactionInstruction({
        programId: optId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_opt")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.state);
        svm.sendTransaction(tx);
      }

      // do_maybe(Some(42)) via the caller → CPIs set_maybe. Borsh Option =
      // tag (1 = Some) + u64 LE.
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: false, isWritable: true },
          { pubkey: optId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("do_maybe"), Uint8Array.from([1]), encodeU64LE(42n))),
      });
      {
        const tx = new Transaction().add(doIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx);
      }
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.state.publicKey, label: "opt_state" }],
  });
}
