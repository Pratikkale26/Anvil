/**
 * #2 / S4 — declare_program! CPI with a COMPOSITE account param, BYTE-EQUAL.
 * From solana-foundation/anchor tests/declare-program: the caller CPIs
 * external::cpi::update_composite, whose `update` account is a nested
 * #[derive(Accounts)] struct (UpdateComposite { update: Update { authority,
 * my_account } }). Anvil flattens both the IDL's composite leaves and the
 * caller's nested CpiContext struct, recursively, so the on-chain account metas
 * + order match Anchor's flattened wire format. external.so (committed callee)
 * writes value through the composite into my_account.field; a wrong flatten
 * (dropped/reordered leaf, wrong flags) reverts or writes wrong → diverges.
 *
 * Self-contained: caller source + composite IDL committed/embedded, external.so
 * the committed callee. Skips (loud) without the SBF toolchain.
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
const CALLER_ID = "JAy4DEyqM3SYxSmJt9XiRUDCZLUwcwiXWpc4eWSHKvfE";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(external);
use external::program::External;
#[program]
pub mod composite_caller {
    use super::*;
    pub fn do_composite(ctx: Context<DoComposite>, value: u32) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.external_program.key(),
            external::cpi::accounts::UpdateComposite {
                update: external::cpi::accounts::Update {
                    authority: ctx.accounts.authority.to_account_info(),
                    my_account: ctx.accounts.my_account.to_account_info(),
                },
            },
        );
        external::cpi::update_composite(cpi_ctx, value)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoComposite<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub my_account: Account<'info, external::accounts::MyAccount>,
    pub external_program: Program<'info, External>,
}
`;

const CALLER_CARGO = `[package]
name = "composite_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "composite_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "external-composite-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "external.so"));

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-composite-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/external.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-composite] SKIPPED — external.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-composite",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "composite_caller",
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
      return { authority, myAccount, value: 77 };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const extId = new PublicKey(EXTERNAL_ID);
      svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

      // init my_account (PDA) via external (authority signs + pays).
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

      // do_composite via the caller → CPIs update_composite (composite account).
      const value = Buffer.alloc(4);
      value.writeUInt32LE(ctx.value, 0);
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: ctx.myAccount, isSigner: false, isWritable: true },
          { pubkey: extId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from(anchorIxDiscriminator("do_composite")), value]),
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
