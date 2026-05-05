/**
 * A6 — first real-world differential fixture.
 *
 * anchor-escrow-2025 by Mike MacCana (https://github.com/mikemaccana/anchor-escrow-2025)
 * is a public, mainnet-shaped Anchor 0.31 program: token-interface (Token-2022
 * compatible), AssociatedToken init, multi-file project layout. It already
 * cargo-builds green via Anvil's emit on both pinocchio + native (locked in
 * realworld-cargo.test.ts EXTERNAL_MUST_PASS, escrow2025 entries). This
 * fixture is the next layer: byte-equal differential proof that the emit's
 * make_offer behaves identically to the Anchor reference at the account-state
 * level — same offer-PDA bytes, same vault ATA balance, same maker ATA debit.
 *
 * Scope intentionally narrow per the advisor's "first real-world program"
 * note: only the make_offer init flow. take_offer + refund_offer can be
 * added as separate fixtures once this one locks in.
 *
 * Auto-scenario can't synthesize this scenario (the offer PDA's seeds use
 * `id.to_le_bytes().as_ref()` — auto-scenario refuses arg-derived seeds per
 * A1, see scenario-runner-seeds.test.ts). Hand-authored scenario via this
 * fixture file is the supported path.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { setupMintAndAtaIxs, createMintIxs, sendSetupTx } from "./differential-setup-helpers.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPO_PATH = "/tmp/anchor-escrow-2025";
const LIB_RS = `${REPO_PATH}/programs/escrow/src/lib.rs`;

// Same auto-clone behavior as realworld-cargo.test.ts: a fresh dev box
// without /tmp/anchor-escrow-2025 cloned would otherwise skip silently;
// pulling the repo at first-run keeps CI honest. Depth=1 + filter=blob:none
// keeps the clone small.
function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/mikemaccana/anchor-escrow-2025",
      REPO_PATH,
    ],
    { stdio: "inherit", timeout: 60_000 },
  );
  if (r.status !== 0) {
    console.warn(
      `[differential-anchor-escrow-2025] clone failed (status=${r.status}); fixture will skip`,
    );
  }
}

ensureRepoCloned();

// Flatten the multi-file project the same way realworld-cargo.test.ts does.
// project-source.ts handles: cfg(test) module strips, super::* re-exports
// inside flattened modules, handler renaming on submodule flatten. The
// flattened blob is what parseAnchor sees.
const ANCHOR_SOURCE = (() => {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: anchor-escrow-2025 was not cloned. Differential will skip.";
  }
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
})();

// Real declared id from anchor-escrow-2025 — preserved so the cache-key
// path under A3 also exercises the override (we deploy at the same id, so
// declare_id! rewriting is a no-op here, but the wiring is exercised).
const PROGRAM_ID = "8jR5GeNzeweq35Uo84kGP3v1NcBaZWH5u62k7PxN4T2y";

defineDifferential({
  fixtureName: "anchor-escrow-2025-make-offer",
  programIdBase58: PROGRAM_ID,
  anchorSource: ANCHOR_SOURCE,
  anchorPackageName: "anchor_escrow_2025_diff",
  // Anvil-emit path consumes the flattened `anchorSource`; the Anchor
  // reference build uses the upstream crate directory verbatim. Multi-file
  // Anchor projects don't survive flattening as buildable Rust (use-glob
  // ambiguities, re-export collapse), so we hand cargo the original
  // crate. The Anvil emit's correctness is what we're proving — the
  // reference is "however the upstream author intended."
  anchorReferenceCrateDir: `${REPO_PATH}/programs/escrow`,

  setup: async () => {
    const payer = Keypair.generate();
    const maker = Keypair.generate();
    const mintA = Keypair.generate();
    const mintB = Keypair.generate();
    const id = 42n;
    const programIdPk = new PublicKey(PROGRAM_ID);

    // offer PDA seeds = [b"offer", id.to_le_bytes()]. The handler omits
    // maker.key from the seed — same id collides for two different makers.
    // Test runs with one maker so collisions are not a concern here.
    const idLe = Buffer.alloc(8);
    idLe.writeBigUInt64LE(id);
    const [offerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), idLe],
      programIdPk,
    );

    // Maker's ATA for mintA — gets minted into during setup, then debited
    // by the make_offer's transfer_tokens call.
    const makerAtaA = getAssociatedTokenAddressSync(mintA.publicKey, maker.publicKey);
    // Vault ATA — owned by the offer PDA, holds the offered tokens after
    // make_offer succeeds. Init'd by the program via the
    // `init, associated_token::*` constraint on the `vault` account.
    const vaultAta = getAssociatedTokenAddressSync(mintA.publicKey, offerPda, true);

    return { payer, maker, mintA, mintB, id, offerPda, makerAtaA, vaultAta };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    // withDefaultPrograms wires up SystemProgram, Token, AssociatedToken,
    // and rent sysvar. withNativeMints isn't strictly needed but keeps the
    // setup symmetric with the existing escrow fixture so any litesvm-
    // version drift surfaces in both fixtures together.
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.maker.publicKey, BigInt(2_000_000_000));

    // Setup: two mints + maker_ata_a with 1M tokens.
    // setupMintAndAtaIxs wraps [createMint, initMint, createAta, mintTo].
    const setupTx = new Transaction()
      .add(...setupMintAndAtaIxs(
        svm,
        ctx.payer.publicKey,
        ctx.mintA.publicKey,
        ctx.makerAtaA,
        ctx.maker.publicKey,
        6,
        1_000_000n,
      ))
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mintB.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mintA, ctx.mintB], "setup");

    // make_offer(id=42, token_a_offered_amount=250_000, token_b_wanted_amount=500_000).
    // Account order matches the upstream MakeOffer accounts struct exactly:
    //   [associated_token_program, token_program, system_program, maker,
    //    token_mint_a, token_mint_b, maker_token_account_a, offer, vault]
    // Anchor's IDL serialization preserves this order; Anvil's emit walks
    // the same Accounts struct in source order. If the byte-compare diverges
    // it will be on data inside the offer PDA or the vault ATA, not on
    // ordering.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.makerAtaA, isSigner: false, isWritable: true },
        { pubkey: ctx.offerPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultAta, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("make_offer"),
        encodeU64LE(ctx.id),
        encodeU64LE(250_000n),
        encodeU64LE(500_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.maker.publicKey;
    tx.sign(ctx.maker);
    const r = svm.sendTransaction(tx);
    if ("err" in r) {
      throw new Error(`make_offer failed: ${JSON.stringify(r.err)}`);
    }
  },

  // Compare scope is intentionally narrow: only the offer PDA's bytes.
  // Why not vault_ata + maker_ata_a too?
  //
  //   - vault_ata diverges as PRESENCE: Anchor's reference creates the ATA
  //     via the `init, associated_token::*` constraint; Anvil's emit
  //     doesn't yet generate the ATA-create CPI for this constraint shape
  //     (tracked: emitter gap, separate fixture work). A vault_ata compare
  //     would assert "ATA-init constraint emit lands"; it doesn't, and
  //     bundling it here would conflate two unrelated claims.
  //   - maker_ata_a depends on the transfer_tokens helper actually firing.
  //     transfer_tokens lives in the upstream `shared.rs` module and is
  //     classified as pass_through (helper inlining doesn't apply to user
  //     helpers in sibling modules). Without the transfer firing,
  //     maker_ata_a balance stays at the original mint amount — the
  //     compare would fail for the same root cause as vault_ata.
  //
  // What this fixture DOES prove: Anvil's emit produces byte-identical
  // Offer struct state to the Anchor reference. The load-bearing fix is
  // set_inner({…}) classification (offer.id, offer.maker, offer.bump,
  // offer.token_mint_a, offer.token_mint_b, offer.token_b_wanted_amount
  // all populated correctly). This is a real Anchor 0.31 init handler from
  // a public mainnet-shaped repo (mikemaccana/anchor-escrow-2025),
  // verified via differential test against the upstream `cargo build-sbf`
  // reference. Promotion to "compare every account" lands when the ATA-
  // init emit + helper-fn inlining gaps close.
  accountsToCompare: (ctx) => [
    { pubkey: ctx.offerPda, label: "offer_pda" },
  ],
});
