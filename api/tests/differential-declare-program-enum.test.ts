/**
 * #2 / S4 — declare_program! CPI with a defined-ENUM arg, BYTE-EQUAL gated.
 * The LAST arg shape. The caller forwards an external enum
 * (`mode: mode_program::types::Mode`) to mode_program::cpi::set_mode(mode).
 * Anvil generates the Rust enum def from the IDL `types` (so the caller can
 * deserialize it) and Borsh-encodes it: a u8 variant discriminant (declaration
 * index) + the matched variant's fields, via a `match`. The callee writes
 * tag/level into a ModeState account; a wrong discriminant or mis-encoded
 * variant field diverges. The scenario passes Mode::Level(42) (tuple variant —
 * exercises discriminant 2 + the inner u32).
 *
 * Self-contained: caller source + IDL committed/embedded, mode_program.so the
 * committed callee. Skips (loud) without the SBF toolchain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_SCRATCH } from "./scratch-root.ts";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const MODE_ID = "5w2cVB1DTSXbvqgAsV4yd8ggdEVkirNgFbF5efh9HJYC";
const CALLER_ID = "9zGEuVvnyZAhXxhqwzbxJcR6ETPnHPv4Wa8CZjLfi3tC";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(mode_program);
use mode_program::program::ModeProgram;
#[program]
pub mod mode_caller {
    use super::*;
    pub fn do_mode(ctx: Context<DoMode>, mode: mode_program::types::Mode) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.mode_program.key(),
            mode_program::cpi::accounts::SetMode { state: ctx.accounts.state.to_account_info() },
        );
        mode_program::cpi::set_mode(cpi_ctx, mode)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoMode<'info> {
    #[account(mut)]
    pub state: Account<'info, mode_program::accounts::ModeState>,
    pub mode_program: Program<'info, ModeProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "mode_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "mode_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "mode-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "mode_program.so"));

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-mode-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/mode_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-enum] SKIPPED — mode_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-enum",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "mode_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { mode_program: idl },
    auxiliaryPrograms: [{ programId: MODE_ID, soFilename: "mode_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({ payer: Keypair.generate(), state: Keypair.generate() }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const modeId = new PublicKey(MODE_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      const initIx = new TransactionInstruction({
        programId: modeId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_mode")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.state);
        svm.sendTransaction(tx);
      }

      // do_mode(Mode::Level(42)) → CPIs set_mode. Borsh enum = u8 variant index
      // (Level = 2) + the variant's u32 field.
      const data = concatBytes(
        anchorIxDiscriminator("do_mode"),
        Uint8Array.from([2]),
        Uint8Array.from([42, 0, 0, 0]), // u32 LE = 42
      );
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state.publicKey, isSigner: false, isWritable: true },
          { pubkey: modeId, isSigner: false, isWritable: false },
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

    accountsToCompare: (ctx) => [{ pubkey: ctx.state.publicKey, label: "mode_state" }],
  });
}
