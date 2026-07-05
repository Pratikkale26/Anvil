/**
 * #2 / S4 #9 — declare_program! CPI with bool + pubkey args, BYTE-EQUAL gated.
 *
 * Closes the last two ungated arg mechanisms. A caller CPIs
 * `config_program::cpi::set_config(cpi_ctx, flag: bool, admin: Pubkey)` — Borsh
 * bool (1 byte) + Pubkey (32 raw bytes), distinct from the String/int families
 * already gated. config_program.so (committed callee) writes both into a Config
 * account; the Anvil-emitted caller must produce byte-identical Config to the
 * Anchor-built caller, which only holds if the synthesized data encodes
 * `(flag) as u8` + `(admin).as_ref()` exactly (a wrong width/order diverges).
 *
 * Self-contained: caller source + IDL committed/embedded, config_program.so the
 * committed callee. Skips (loud) without the SBF toolchain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_SCRATCH } from "./scratch-root.ts";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const CONFIG_ID = "BNrrRhswrWYX97vfhtKPZ79kAWuMxTfczHxitYadzaV6";
const CALLER_ID = "8dZZVD8j8SfLk2ZDsQrevkR8eMjFeEGMoFUARizMnpqz";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(config_program);
use config_program::program::ConfigProgram;
#[program]
pub mod config_caller {
    use super::*;
    pub fn do_set(ctx: Context<DoSet>, flag: bool, admin: Pubkey) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.config_program.key(),
            config_program::cpi::accounts::SetConfig { config: ctx.accounts.config.to_account_info() },
        );
        config_program::cpi::set_config(cpi_ctx, flag, admin)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoSet<'info> {
    #[account(mut)]
    pub config: Account<'info, config_program::accounts::Config>,
    pub config_program: Program<'info, ConfigProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "config_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "config_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "config-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "config_program.so"));

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-config-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/config_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-config-bool-pubkey] SKIPPED — config_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-config-bool-pubkey",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "config_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { config_program: idl },
    auxiliaryPrograms: [{ programId: CONFIG_ID, soFilename: "config_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({
      payer: Keypair.generate(),
      config: Keypair.generate(),
      admin: Keypair.generate().publicKey,
      flag: true,
    }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const cfgId = new PublicKey(CONFIG_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      // init Config directly via config_program (config + payer sign the new account).
      const initIx = new TransactionInstruction({
        programId: cfgId,
        keys: [
          { pubkey: ctx.config.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_config")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.config);
        svm.sendTransaction(tx);
      }

      // do_set via the caller → CPIs set_config(flag, admin). data = disc +
      // Borsh bool (1 byte) + Pubkey (32 bytes).
      const data = Buffer.concat([
        Buffer.from(anchorIxDiscriminator("do_set")),
        Buffer.from([ctx.flag ? 1 : 0]),
        ctx.admin.toBuffer(),
      ]);
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.config.publicKey, isSigner: false, isWritable: true },
          { pubkey: cfgId, isSigner: false, isWritable: false },
        ],
        data,
      });
      {
        const tx = new Transaction().add(doIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx);
      }
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.config.publicKey, label: "config" }],
  });
}
