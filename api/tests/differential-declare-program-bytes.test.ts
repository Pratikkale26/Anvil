/**
 * #2 / S4 — declare_program! CPI with a bytes / Vec<u8> arg, BYTE-EQUAL gated.
 * Compile-gates the `bytes` encoding (u32 LE length + raw bytes; the `&data`
 * Vec<u8>→&[u8] deref) on top of the correct-by-construction argument that it
 * shares the String mechanism. The caller CPIs blob_program::cpi::store(data:
 * Vec<u8>); the callee writes data.len() + the bytes into a Blob account, so a
 * mis-encoded length prefix or wrong bytes diverges.
 *
 * Self-contained: caller source + IDL committed/embedded, blob_program.so the
 * committed callee. Skips (loud) without the SBF toolchain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const BLOB_ID = "AaCAP5sUSQjMWq7faMqLF4YwDTVkfQQ8ZWw7AGYav6UL";
const CALLER_ID = "BLgoBBjvcMwjfqKtjdhtTQptgyvPps1h3srZkm9MjHpi";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(blob_program);
use blob_program::program::BlobProgram;
#[program]
pub mod blob_caller {
    use super::*;
    pub fn do_store(ctx: Context<DoStore>, data: Vec<u8>) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.blob_program.key(),
            blob_program::cpi::accounts::Store { blob: ctx.accounts.blob.to_account_info() },
        );
        blob_program::cpi::store(cpi_ctx, data)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct DoStore<'info> {
    #[account(mut)]
    pub blob: Account<'info, blob_program::accounts::Blob>,
    pub blob_program: Program<'info, BlobProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "blob_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "blob_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "blob-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "blob_program.so"));

function prepareCallerCrate(): string {
  const dir = "/tmp/anvil-blob-caller";
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/blob_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-bytes] SKIPPED — blob_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();
  const payload = [1, 2, 3, 4, 5, 6, 7];

  defineDifferential({
    fixtureName: "declare-program-bytes",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "blob_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { blob_program: idl },
    auxiliaryPrograms: [{ programId: BLOB_ID, soFilename: "blob_program.so" }],
    compareTxOutcomes: true,

    setup: async () => ({ payer: Keypair.generate(), blob: Keypair.generate() }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const blobId = new PublicKey(BLOB_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      // init Blob directly via blob_program (blob + payer sign the new account).
      const initIx = new TransactionInstruction({
        programId: blobId,
        keys: [
          { pubkey: ctx.blob.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_blob")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.blob);
        svm.sendTransaction(tx);
      }

      // do_store via the caller → CPIs store(data: Vec<u8>). Borsh bytes = u32
      // LE length + the raw bytes.
      const len = Buffer.alloc(4);
      len.writeUInt32LE(payload.length, 0);
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.blob.publicKey, isSigner: false, isWritable: true },
          { pubkey: blobId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("do_store"), len, Uint8Array.from(payload))),
      });
      {
        const tx = new Transaction().add(doIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx);
      }
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.blob.publicKey, label: "blob" }],
  });
}
