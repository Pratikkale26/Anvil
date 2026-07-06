/**
 * #44 byte-equal — state-compression (cNFT primitive) CPI via declare_program!.
 *
 * Proves that Anvil's declare_program! + IDL rewrite of an
 * `spl_account_compression::cpi::append(...)` call emits a CPI byte-identical
 * to what Anchor's own declare_program! macro generates — verified end-to-end
 * against the REAL mainnet spl-account-compression + spl-noop programs loaded
 * into LiteSVM.
 *
 * This closes the reopen-precondition documented for #44: the compression
 * family had no loadable `.so` fixture, so its byte-equal gate was unbuildable.
 * Both are now committed (dumped from mainnet), so the concurrent-Merkle-tree
 * account can be mutated by a real append and byte-compared.
 *
 * Setup: create + `init_empty_merkle_tree` (depth 3 / buffer 8) directly via
 * @solana/spl-account-compression — identical for both the Anchor-reference and
 * Anvil-emitted runs. Then the program-under-test appends one leaf via CPI. If
 * Anvil's emitted append instruction (discriminator, account order, [u8;32]
 * arg) diverged from Anchor's, the tree's changelog/root/sequence bytes would
 * differ and this gate would catch it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_SCRATCH } from "./scratch-root.ts";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";
// Package main is mis-pointed; import the real entry directly.
import {
  getConcurrentMerkleTreeAccountSize,
  createInitEmptyMerkleTreeInstruction,
} from "../node_modules/@solana/spl-account-compression/dist/cjs/src/index.js";

const CALLER_ID = "8ApKuJUB9aJkSznXacuAq1aDgUX16TciJuR2Y3a8ZSGg";
const COMPRESSION_ID = "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";
const NOOP_ID = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const MAX_DEPTH = 3;
const MAX_BUFFER = 8;

const CALLER_SRC = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "compression-append.rs"),
  "utf-8",
);
const IDL = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "spl-account-compression-idl.json"), "utf-8"),
);

const compressionSoPresent = existsSync(join(import.meta.dir, "fixtures", "programs", "spl_account_compression.so"));
const noopSoPresent = existsSync(join(import.meta.dir, "fixtures", "programs", "spl_noop.so"));

const CALLER_CARGO = `[package]
name = "compression_append"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "compression_append"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-compression-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/spl_account_compression.json"), JSON.stringify(IDL));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!compressionSoPresent || !noopSoPresent) {
  console.warn("[differential-compression-append] SKIPPED — spl_account_compression.so / spl_noop.so fixtures missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "compression-append",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "compression_append",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { spl_account_compression: IDL },
    auxiliaryPrograms: [
      { programId: COMPRESSION_ID, soFilename: "spl_account_compression.so" },
      { programId: NOOP_ID, soFilename: "spl_noop.so" },
    ],
    compareTxOutcomes: true,

    setup: async () => ({
      payer: Keypair.generate(),
      tree: Keypair.generate(),
      authority: Keypair.generate(),
    }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(5_000_000_000));

      const compressionId = new PublicKey(COMPRESSION_ID);
      const noopId = new PublicKey(NOOP_ID);
      const space = getConcurrentMerkleTreeAccountSize(MAX_DEPTH, MAX_BUFFER, 0);
      const rent = svm.minimumBalanceForRentExemption(BigInt(space));

      // Create + initialize an empty tree — identical for both runs, so the
      // pre-append state is byte-shared; only the append (under test) differs.
      const initIx = createInitEmptyMerkleTreeInstruction(
        { merkleTree: ctx.tree.publicKey, authority: ctx.authority.publicKey, noop: noopId },
        { maxDepth: MAX_DEPTH, maxBufferSize: MAX_BUFFER },
        compressionId,
      );
      const setupTx = new Transaction()
        .add(SystemProgram.createAccount({
          fromPubkey: ctx.payer.publicKey,
          newAccountPubkey: ctx.tree.publicKey,
          lamports: Number(rent),
          space,
          programId: compressionId,
        }))
        .add(initIx);
      setupTx.recentBlockhash = svm.latestBlockhash();
      setupTx.feePayer = ctx.payer.publicKey;
      setupTx.sign(ctx.payer, ctx.tree, ctx.authority);
      const r1 = svm.sendTransaction(setupTx);
      if (isTxFailure(r1)) throw new Error(`tree init failed: ${txFailureMessage(r1)}`);

      // Program-under-test: append one leaf via CPI.
      const leaf = new Uint8Array(32).fill(7);
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.tree.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: noopId, isSigner: false, isWritable: false },
          { pubkey: compressionId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("add_leaf"), leaf)),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer, ctx.authority);
      const r2 = svm.sendTransaction(tx);
      if (isTxFailure(r2)) throw new Error(`add_leaf failed: ${txFailureMessage(r2)}`);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [{ pubkey: ctx.tree.publicKey, label: "merkle_tree" }],
  });
}
