/**
 * Differential tracking-ceiling layer (M3).
 *
 * Sister file to the binary differential-* fixtures. Those gate CI: every
 * fixture MUST byte-equal across its narrow `accountsToCompare`. This file
 * does NOT gate CI: it runs the SAME real-world fixtures with the FULL
 * "every touched account" compare list, counts mismatches, and asserts
 * `mismatches.length <= recorded ceiling`. The ceiling shrinks as deferred
 * emit gaps close; CI catches the day a fix lands by reporting
 * "now BYTE_EQUAL — promote to MUST_PASS."
 *
 * Mirrors the pattern from realworld-tracking.test.ts (cargo) at the
 * byte-equal compare layer instead of cargo-error layer. Without this,
 * known divergences (anchor-escrow-2025's vault_ata + maker_ata_a) sit
 * invisible in code comments while the underlying fixes happen out-of-
 * band; the day one of those gaps closes, the ceiling catches it as a
 * "now-passing" signal instead of staying buried.
 *
 * Each entry's `maxMismatches` is a recorded ceiling (current count, no
 * slack). Tightening = promote. Loosening = explain why in the entry's
 * `reason` field.
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAnchorSoForFixture,
  buildAnvilSoFromFiles,
  runDifferentialCompareAll,
  Keypair,
  PublicKey,
  type DifferentialFixture,
  type CompareMismatch,
} from "./differential-harness.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";
import {
  REPO_PATH as ESCROW_REPO,
  LIB_RS as ESCROW_LIB_RS,
  CRATE_DIR as ESCROW_CRATE,
  PROGRAM_ID as ESCROW_PROGRAM_ID,
  ensureRepoCloned as ensureEscrowCloned,
  loadAnchorSource as loadEscrowSource,
  setupMakeOffer,
  callMakeOffer,
  fullAccountsToCompare as escrowFullAccounts,
  type MakeOfferCtx,
} from "./fixtures/anchor-escrow-2025-fixture.ts";

interface TrackedDifferential<S extends Record<string, unknown>> {
  id: string;
  /** Defines the full-scope fixture (every account the scenario touches). */
  fixture: DifferentialFixture<S>;
  /** Where the upstream source must exist for this case to run. */
  pathProbe: string;
  /** Source URL for human reproducibility. */
  source: string;
  /** Highest acceptable mismatch count from runDifferentialCompareAll. */
  maxMismatches: number;
  /** Why this case has divergences today; update as gaps close. */
  reason: string;
}

const ESCROW_FIXTURE: DifferentialFixture<MakeOfferCtx> = {
  fixtureName: "anchor-escrow-2025-make-offer-tracked",
  programIdBase58: ESCROW_PROGRAM_ID,
  anchorSource: loadEscrowSource(),
  anchorPackageName: "anchor_escrow_2025_tracked",
  anchorReferenceCrateDir: ESCROW_CRATE,
  setup: setupMakeOffer,
  callScript: callMakeOffer,
  accountsToCompare: escrowFullAccounts,
};

const TRACKED: Array<TrackedDifferential<MakeOfferCtx>> = [
  {
    id: "anchor-escrow-2025/make_offer (full)",
    fixture: ESCROW_FIXTURE,
    pathProbe: ESCROW_LIB_RS,
    source: "https://github.com/mikemaccana/anchor-escrow-2025",
    // Today's known divergences (recorded 2026-05-05):
    //   1. vault_ata — PRESENCE mismatch. Anvil doesn't emit the ATA-create
    //      CPI for the `init, associated_token::*` constraint shape; vault
    //      account never gets created on the Anvil side.
    //   2. maker_ata_a — DATA mismatch. The upstream `transfer_tokens`
    //      helper in handlers/shared.rs wraps `transfer_checked(...)` and
    //      is classified as pass_through (user-helper SPL-CPI inlining is
    //      Path 2 deferred work). Maker's pre-transfer balance is unchanged
    //      on the Anvil side; debited on the Anchor side.
    //
    // offer_pda is byte-equal post-A6 (set_inner expansion lands the
    // struct fields). When either Path 2 (helper-inline) or the ATA-init
    // constraint emit closes, ceiling drops; promote when it hits 0.
    maxMismatches: 2,
    reason: "vault_ata presence (ATA-init constraint emit gap) + maker_ata_a data (helper-fn inline gap, Path 2). offer_pda byte-equals.",
  },
];

const anyExist = TRACKED.some((c) => existsSync(c.pathProbe));

if (anyExist) {
  // Auto-clone any tracked sources that aren't on disk yet — same affordance
  // as the binary fixtures so a fresh dev box doesn't silently skip.
  ensureEscrowCloned();

  describe("Differential tracking [non-blocking ceilings]", () => {
    for (const tc of TRACKED) {
      test(`${tc.id} (≤${tc.maxMismatches})`, async () => {
        if (!existsSync(tc.pathProbe)) {
          console.warn(`[diff-tracking] ${tc.id}: skipped — path missing: ${tc.pathProbe}`);
          return;
        }
        const programId = new PublicKey(tc.fixture.programIdBase58);

        // Cache mirrors the binary fixture's path so cold builds aren't
        // doubled. Both `anchor-escrow-2025-make-offer` (binary) and
        // `anchor-escrow-2025-make-offer-tracked` (this) share .so
        // because the source / programId / scaffold are identical; just
        // namespace under fixtureName. Don't overlap their cache dirs.
        const HOME = process.env.HOME ?? "/tmp";
        const cacheRoot = process.env.ANVIL_DIFF_CACHE ?? join(HOME, ".anvil-diff-cache");
        const cacheDir = join(cacheRoot, `${tc.fixture.fixtureName}-tracked`);
        mkdirSync(cacheDir, { recursive: true });
        const anchorSoPath = join(cacheDir, `${tc.fixture.fixtureName}_anchor.so`);
        const anvilSoPath = join(cacheDir, `${tc.fixture.fixtureName}_anvil.so`);

        if (!existsSync(anchorSoPath)) {
          await buildAnchorSoForFixture(tc.fixture, anchorSoPath);
        }
        if (!existsSync(anvilSoPath)) {
          // Build the Anvil .so via the same parse → emit → scaffold flow
          // the binary fixture uses. defineDifferential does this internally;
          // re-create it here because we're not going through that path.
          const parsed = await parseAnchor(tc.fixture.anchorSource);
          if (!parsed.ok) {
            throw new Error(`parseAnchor failed: ${parsed.error}`);
          }
          const out = emitPinocchioFull(parsed.ir);
          const scaffold = buildProjectScaffold(parsed.ir, "pinocchio");
          await buildAnvilSoFromFiles(
            { fixtureName: tc.fixture.fixtureName },
            scaffold,
            out.files,
            anvilSoPath,
          );
        }

        const anchorSo = readFileSync(anchorSoPath);
        const anvilSo = readFileSync(anvilSoPath);
        const ctx = await tc.fixture.setup();

        const mismatches: CompareMismatch[] = await runDifferentialCompareAll(
          tc.fixture, anchorSo, anvilSo, programId, ctx,
        );

        // Surface the breakdown so a developer reading test output can see
        // which accounts diverged + how, without re-running with verbose.
        for (const m of mismatches) {
          console.log(`[diff-tracking] ${tc.id}: ${m.kind} on '${m.label}'`);
        }

        if (mismatches.length > tc.maxMismatches) {
          throw new Error(
            `${tc.id} regressed: ${mismatches.length} mismatches (ceiling ${tc.maxMismatches}). ` +
            `Reason: ${tc.reason}\nBreakdown:\n` +
            mismatches.map((m) => `  - ${m.kind} on '${m.label}'`).join("\n"),
          );
        }
        if (mismatches.length === 0) {
          console.warn(
            `[diff-tracking] ${tc.id} now BYTE_EQUAL across full compare — promote to MUST_PASS in differential-* fixture.`,
          );
        } else if (mismatches.length < tc.maxMismatches) {
          console.warn(
            `[diff-tracking] ${tc.id} has ${mismatches.length} mismatches (ceiling ${tc.maxMismatches}). ` +
            `Tighten ceiling on the next commit that closes another gap.`,
          );
        }
        // The ceiling is met or exceeded by exact match — pass.
        expect(mismatches.length).toBeLessThanOrEqual(tc.maxMismatches);
      }, 600_000);
    }
  });
} else {
  describe("Differential tracking [SKIPPED — no fixture sources cloned]", () => {
    test.skip(`No tracked sources present locally — see ensureRepoCloned helpers in fixtures/.`, () => {});
  });
}
