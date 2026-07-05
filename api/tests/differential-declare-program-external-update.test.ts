/**
 * #2 / S4 follow-on — declare_program! cross-program CPI in Anchor's CANONICAL
 * form, BYTE-EQUAL gated. From solana-foundation/anchor tests/declare-program:
 * a caller invokes `external::cpi::update(cpi_ctx, value: u32)` — the QUALIFIED
 * path form (vs hand/lever's aliased `use ...::switch_power`) AND a NUMERIC u32
 * arg (vs the String in lever). Both are the real-world shapes the internet
 * sweep surfaced; this differential gates the rewrite extensions that handle
 * them (qualified-path resolution + integer Borsh encoding).
 *
 * external.so (callee, committed) owns a PDA `my_account { field: u32 }`. The
 * Anvil-emitted caller CPIs external::update(value) → my_account.field = value,
 * byte-identical to the Anchor-built caller. A wrong discriminator, swapped
 * account metas, or mis-encoded u32 would make the CPI revert or write the wrong
 * value → the compare DIVERGES.
 *
 * Self-contained: the caller source + trimmed external IDL are embedded /
 * committed; external.so is the committed callee. Skips (loud) without the SBF
 * toolchain.
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

const EXTERNAL_ID = "Externa111111111111111111111111111111111111";
const CALLER_ID = "Dec1areProgram11111111111111111111111111111";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(external);
use external::program::External;
#[program]
pub mod cpi_caller {
    use super::*;
    pub fn do_update(ctx: Context<DoUpdate>, value: u32) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.external_program.key(),
            external::cpi::accounts::Update {
                authority: ctx.accounts.authority.to_account_info(),
                my_account: ctx.accounts.my_account.to_account_info(),
            },
        );
        external::cpi::update(cpi_ctx, value)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoUpdate<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub my_account: Account<'info, external::accounts::MyAccount>,
    pub external_program: Program<'info, External>,
}
`;

const CALLER_CARGO = `[package]
name = "cpi_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "cpi_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "external-update-idl.json"), "utf-8"));
const externalSoPresent = existsSync(join(import.meta.dir, "fixtures", "programs", "external.so"));

// Prepare the standalone Anchor reference crate in /tmp (idls/external.json in
// the crate root → declare_program!(external) resolves it).
function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-declare-program-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/external.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!externalSoPresent) {
  console.warn("[differential-declare-program-external-update] SKIPPED — external.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-external-update",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "cpi_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { external: idl },
    auxiliaryPrograms: [{ programId: EXTERNAL_ID, soFilename: "external.so" }],
    compareTxOutcomes: true,

    setup: async () => {
      const authority = Keypair.generate();
      const [myAccount] = PublicKey.findProgramAddressSync(
        [authority.publicKey.toBytes()],
        new PublicKey(EXTERNAL_ID),
      );
      return { authority, myAccount, value: 42 };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const extId = new PublicKey(EXTERNAL_ID);
      svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

      // init my_account (PDA) directly via external (authority signs + pays).
      const initIx = new TransactionInstruction({
        programId: extId,
        keys: [
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.myAccount, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.authority.publicKey;
        tx.sign(ctx.authority);
        svm.sendTransaction(tx);
      }

      // do_update via the caller → CPIs external::update(value). Accounts:
      // authority (signer), my_account (mut), external_program.
      const value = Buffer.alloc(4);
      value.writeUInt32LE(ctx.value, 0);
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: ctx.myAccount, isSigner: false, isWritable: true },
          { pubkey: extId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from(anchorIxDiscriminator("do_update")), value]),
      });
      {
        const tx = new Transaction().add(doIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.authority.publicKey;
        tx.sign(ctx.authority);
        svm.sendTransaction(tx);
      }
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.myAccount, label: "my_account" }],
  });
}
