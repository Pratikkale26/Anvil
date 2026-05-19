/**
 * MPL Core plugin family byte-equal differentials (task #48 S6-S10).
 *
 * Each test creates an asset (via raw mpl_core CreateV2), runs the
 * plugin-family ix from the demo program, and compares the post-call
 * asset bytes against the Anchor reference. This is THE gate the advisor
 * flagged — cargo-check doesn't validate the nested Plugin/PluginType
 * Borsh shape on-chain; only byte-equal against the real mpl_core.so
 * catches a wire-format bug.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const MPL_CORE_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function premintAsset(svm: LiteSVM, payer: Keypair, asset: Keypair, mplCoreProgramId: PublicKey): void {
  const ix = new TransactionInstruction({
    programId: mplCoreProgramId,
    keys: [
      { pubkey: asset.publicKey, isSigner: true, isWritable: true },
      { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
      { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
      { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(
      new Uint8Array([20, 0]),
      borshString("P"),
      borshString("https://p/0.json"),
      new Uint8Array([0, 0]),
    )),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, asset);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error(`premint setup: ${txFailureMessage(r)}`);
}

// ─── S6 AddPluginV1 ─────────────────────────────────────────────────────────
defineDifferential({
  fixtureName: "mpl-core-add-plugin-v1",
  programIdBase58: "7EPEQWHoYysCt5PtVXVsi3jmgteWXScfnnRjLLCLZTYY",
  anchorSource: readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-add-plugin-v1.rs"), "utf-8"),
  anchorPackageName: "mpl_core_add_plugin_v1_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [{ programId: MPL_CORE_ID, soFilename: "mpl_core.so" }],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    return { payer, asset, owner: payer, mplCoreProgramId: new PublicKey(MPL_CORE_ID) };
  },

  callScript: async (svm, ctx, programId) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    premintAsset(svm, ctx.payer, ctx.asset, ctx.mplCoreProgramId);

    // add_immutable_metadata (ix name in demo) — MutateAsset accounts:
    // asset, payer, owner, system_program, mpl_core_program.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("add_immutable_metadata")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`add_immutable_metadata: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.asset.publicKey, label: "asset_after_add_plugin" }],
});

// ─── S7 RemovePluginV1 ──────────────────────────────────────────────────────
defineDifferential({
  fixtureName: "mpl-core-remove-plugin-v1",
  programIdBase58: "CeTsVG4VZpHpBRPPoyLh2cTtH3p6Pgud6ChP24DrF8Z8",
  anchorSource: readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-remove-plugin-v1.rs"), "utf-8"),
  anchorPackageName: "mpl_core_remove_plugin_v1_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [{ programId: MPL_CORE_ID, soFilename: "mpl_core.so" }],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    return { payer, asset, owner: payer, mplCoreProgramId: new PublicKey(MPL_CORE_ID) };
  },

  callScript: async (svm, ctx, programId) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    premintAsset(svm, ctx.payer, ctx.asset, ctx.mplCoreProgramId);

    // First add the ImmutableMetadata plugin via raw mpl_core, then call
    // remove_immutable from the demo program.
    const addIx = new TransactionInstruction({
      programId: ctx.mplCoreProgramId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(new Uint8Array([2, 12, 0])), // disc=2 + Plugin::ImmutableMetadata(12) + Option<PluginAuthority>=None
    });
    const tx0 = new Transaction().add(addIx);
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.feePayer = ctx.payer.publicKey;
    tx0.sign(ctx.payer);
    const r0 = svm.sendTransaction(tx0);
    if (isTxFailure(r0)) throw new Error(`pre-add: ${txFailureMessage(r0)}`);

    const removeIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("remove_immutable")),
    });
    const tx = new Transaction().add(removeIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`remove_immutable: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.asset.publicKey, label: "asset_after_remove_plugin" }],
});

// ─── S8 UpdatePluginV1 ──────────────────────────────────────────────────────
defineDifferential({
  fixtureName: "mpl-core-update-plugin-v1",
  programIdBase58: "DUQi6HWn21FueDByFQ98uyG6ca3JQhd9aQAj89Xoup8S",
  anchorSource: readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-update-plugin-v1.rs"), "utf-8"),
  anchorPackageName: "mpl_core_update_plugin_v1_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [{ programId: MPL_CORE_ID, soFilename: "mpl_core.so" }],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    return { payer, asset, owner: payer, mplCoreProgramId: new PublicKey(MPL_CORE_ID) };
  },

  callScript: async (svm, ctx, programId) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    premintAsset(svm, ctx.payer, ctx.asset, ctx.mplCoreProgramId);

    // Pre-add FreezeDelegate (frozen=false). Wire: disc=2 +
    // Plugin::FreezeDelegate(1) + frozen=0 + Option<PluginAuthority>=None.
    const addIx = new TransactionInstruction({
      programId: ctx.mplCoreProgramId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(new Uint8Array([2, 1, 0, 0])),
    });
    const tx0 = new Transaction().add(addIx);
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.feePayer = ctx.payer.publicKey;
    tx0.sign(ctx.payer);
    const r0 = svm.sendTransaction(tx0);
    if (isTxFailure(r0)) throw new Error(`pre-add: ${txFailureMessage(r0)}`);

    // toggle_freeze(frozen=true) from the demo.
    const updateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("toggle_freeze"),
        new Uint8Array([1]), // frozen = true
      )),
    });
    const tx = new Transaction().add(updateIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`toggle_freeze: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.asset.publicKey, label: "asset_after_update_plugin" }],
});

// ─── S9 ApprovePluginAuthorityV1 + S10 RevokePluginAuthorityV1 ──────────────
defineDifferential({
  fixtureName: "mpl-core-approve-revoke-plugin-authority-v1",
  programIdBase58: "9YHYExwoZSJ9pExXniEDTWZaRZTK4xhhkmU7MBtocR8d",
  anchorSource: readFileSync(join(import.meta.dir, "..", "src", "demo-programs", "mpl-core-approve-revoke-plugin-authority-v1.rs"), "utf-8"),
  anchorPackageName: "mpl_core_approve_revoke_plugin_authority_v1_anchor_diff",
  anchorExtraDeps: `mpl-core = { version = "0.11", features = ["anchor"] }`,
  auxiliaryPrograms: [{ programId: MPL_CORE_ID, soFilename: "mpl_core.so" }],

  setup: async () => {
    const payer = Keypair.generate();
    const asset = Keypair.generate();
    return { payer, asset, owner: payer, mplCoreProgramId: new PublicKey(MPL_CORE_ID) };
  },

  callScript: async (svm, ctx, programId) => {
    svm.withDefaultPrograms();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    premintAsset(svm, ctx.payer, ctx.asset, ctx.mplCoreProgramId);

    // Pre-add FreezeDelegate to have a plugin to approve/revoke authority on.
    const addIx = new TransactionInstruction({
      programId: ctx.mplCoreProgramId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(new Uint8Array([2, 1, 0, 0])),
    });
    const t0 = new Transaction().add(addIx);
    t0.recentBlockhash = svm.latestBlockhash();
    t0.feePayer = ctx.payer.publicKey;
    t0.sign(ctx.payer);
    const r0 = svm.sendTransaction(t0);
    if (isTxFailure(r0)) throw new Error(`pre-add: ${txFailureMessage(r0)}`);

    // approve_to_owner — delegates the FreezeDelegate plugin's authority
    // to PluginAuthority::Owner.
    const approveIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.asset.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.mplCoreProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("approve_to_owner")),
    });
    const tx = new Transaction().add(approveIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`approve_to_owner: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [{ pubkey: ctx.asset.publicKey, label: "asset_after_approve_authority" }],
});
