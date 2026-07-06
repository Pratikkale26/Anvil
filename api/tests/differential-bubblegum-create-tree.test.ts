/**
 * #44 byte-equal — Bubblegum (compressed-NFT) CPI via declare_program!.
 *
 * Proves Anvil's declare_program! + IDL rewrite of an
 * `mpl_bubblegum::cpi::create_tree(...)` call emits a CPI byte-identical to
 * Anchor's own declare_program! output — verified end-to-end against the REAL
 * mainnet mpl-bubblegum + spl-account-compression + spl-noop programs in
 * LiteSVM. create_tree initializes the tree-config PDA (and CPIs
 * spl-account-compression to init the concurrent Merkle tree), so it exercises
 * the full cNFT program stack.
 *
 * Setup: pre-allocate the concurrent Merkle tree account (depth 3 / buffer 8).
 * The program-under-test calls Bubblegum `create_tree` via CPI; we byte-compare
 * the resulting TreeConfig PDA. If Anvil's emitted create_tree instruction
 * (discriminator, 7-account order, u32/u32/Option<bool> args) diverged from
 * Anchor's, the TreeConfig bytes (tree_creator/delegate/capacity/flags) would
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
import {
  getConcurrentMerkleTreeAccountSize,
} from "../node_modules/@solana/spl-account-compression/dist/cjs/src/index.js";

const CALLER_ID = "2JuzxrX9LQh89wZgqkydKU7mzbdTeQhUMVfayTgXdhGE";
const BUBBLEGUM_ID = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const COMPRESSION_ID = "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";
const NOOP_ID = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const MAX_DEPTH = 3;
const MAX_BUFFER = 8;

const CALLER_SRC = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "bubblegum-create-tree.rs"),
  "utf-8",
);
const IDL = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "mpl-bubblegum-idl.json"), "utf-8"),
);

const allSoPresent = ["bubblegum.so", "spl_account_compression.so", "spl_noop.so"].every((f) =>
  existsSync(join(import.meta.dir, "fixtures", "programs", f)),
);

const CALLER_CARGO = `[package]
name = "bubblegum_create_tree"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "bubblegum_create_tree"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-bubblegum-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/mpl_bubblegum.json"), JSON.stringify(IDL));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!allSoPresent) {
  console.warn("[differential-bubblegum-create-tree] SKIPPED — bubblegum/compression/noop .so fixtures missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "bubblegum-create-tree",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "bubblegum_create_tree",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { mpl_bubblegum: IDL },
    auxiliaryPrograms: [
      { programId: BUBBLEGUM_ID, soFilename: "bubblegum.so" },
      { programId: COMPRESSION_ID, soFilename: "spl_account_compression.so" },
      { programId: NOOP_ID, soFilename: "spl_noop.so" },
    ],
    compareTxOutcomes: true,

    setup: async () => {
      const tree = Keypair.generate();
      // TreeConfig PDA = [merkle_tree] under the Bubblegum program.
      const [treeAuthority] = PublicKey.findProgramAddressSync(
        [tree.publicKey.toBuffer()],
        new PublicKey(BUBBLEGUM_ID),
      );
      return {
        payer: Keypair.generate(),
        treeCreator: Keypair.generate(),
        tree,
        treeAuthority,
      };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(5_000_000_000));

      const compressionId = new PublicKey(COMPRESSION_ID);
      const noopId = new PublicKey(NOOP_ID);
      const space = getConcurrentMerkleTreeAccountSize(MAX_DEPTH, MAX_BUFFER, 0);
      const rent = svm.minimumBalanceForRentExemption(BigInt(space));

      // Pre-allocate the tree account (owned by the compression program) — same
      // for both runs, so only the create_tree CPI (under test) differs.
      const setupTx = new Transaction().add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.tree.publicKey,
        lamports: Number(rent),
        space,
        programId: compressionId,
      }));
      setupTx.recentBlockhash = svm.latestBlockhash();
      setupTx.feePayer = ctx.payer.publicKey;
      setupTx.sign(ctx.payer, ctx.tree);
      const r1 = svm.sendTransaction(setupTx);
      if (isTxFailure(r1)) throw new Error(`tree alloc failed: ${txFailureMessage(r1)}`);

      // Program-under-test: create_tree via CPI.
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.treeAuthority, isSigner: false, isWritable: true },
          { pubkey: ctx.tree.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.treeCreator.publicKey, isSigner: true, isWritable: false },
          { pubkey: noopId, isSigner: false, isWritable: false },
          { pubkey: compressionId, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(BUBBLEGUM_ID), isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(
          anchorIxDiscriminator("make_tree"),
          new Uint8Array(new Uint32Array([MAX_DEPTH]).buffer),
          new Uint8Array(new Uint32Array([MAX_BUFFER]).buffer),
        )),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer, ctx.treeCreator);
      const r2 = svm.sendTransaction(tx);
      if (isTxFailure(r2)) throw new Error(`make_tree failed: ${txFailureMessage(r2)}`);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [{ pubkey: ctx.treeAuthority, label: "tree_config" }],
  });
}
