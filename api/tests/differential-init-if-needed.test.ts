/**
 * init_if_needed differential.
 *
 * Exercises Anchor's `init_if_needed` constraint: same accounts, called
 * twice — first call inits the PDA, second call mutates the existing
 * state. The emitter has to generate a runtime branch (account empty?
 * init : read) instead of unconditional default-init that would silently
 * overwrite the first call's state.
 *
 * Without the runtime branch, the second call would reset visit_count
 * back to 1 instead of incrementing to 2, producing a state divergence
 * the byte-equal compare catches loudly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "init-if-needed.rs");
const PROGRAM_ID = "initifneeded1111111111111111111111111111111";

defineDifferential({
  fixtureName: "init-if-needed",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "init_if_needed_anchor_diff",
  // The init_if_needed constraint is gated behind a feature flag in
  // anchor-lang 0.31 — the macro panics with E0599/E0277 cascades
  // without it. The Anvil emit doesn't need the flag because we lower
  // the constraint into an explicit if-empty-init-else-read branch.
  anchorLangFeatures: ["init-if-needed"],

  setup: async () => {
    const user = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [profilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), user.publicKey.toBuffer()],
      programId,
    );
    return { user, profilePda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.user.publicKey, BigInt(1_000_000_000));

    // Source reads Clock::get() — no instruction args. Discriminator only.
    const visitIx = () =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.profilePda, isSigner: false, isWritable: true },
          { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("visit")),
      });

    // Two visits: first inits, second exercises the init_if_needed branch.
    // If the runtime branch is missing, the second call default-inits and
    // resets visit_count back to 1 → byte-mismatch on the post-state.
    //
    // Between calls we expire the blockhash so the second tx isn't deduped
    // as AlreadyProcessed (TransactionError 6) — LiteSVM doesn't auto-
    // advance slots between sendTransaction calls.
    for (let i = 0; i < 2; i++) {
      if (i > 0) {
        const expire = (svm as unknown as { expireBlockhash?: () => void }).expireBlockhash;
        if (typeof expire === "function") expire.call(svm);
      }
      const tx = new Transaction().add(visitIx());
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.user.publicKey;
      tx.sign(ctx.user);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`tx failed (iter ${i}): ${JSON.stringify(r.err)}`);
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.profilePda, label: "profile_pda" },
  ],
});
