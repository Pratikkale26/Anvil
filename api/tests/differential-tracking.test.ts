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
    // Promoted 2026-05-05 — ceiling at 0 mismatches. The fixture was a
    // tracker of the path from "offer_pda byte-equal only" to "full
    // compare byte-equal." Got there via:
    //
    //   - offer_pda: A6 set_inner expansion (41da298, 2026-05-05)
    //   - vault_ata + maker_ata_a: Path 2 helper-fn inlining (4f43320)
    //     + N1 TokenInterface runtime-dispatch — both gaps closed in
    //     one shot when the dispatch flipped, because the SAME CPI
    //     emit produces both the vault-ATA write AND the maker-ATA
    //     debit identical to Anchor's reference.
    //
    // The binary fixture (differential-anchor-escrow-2025.test.ts) now
    // gates CI on the full compare. This entry stays at ceiling=0 as a
    // regression-guard — if a future commit re-introduces a divergence,
    // CI catches it here AND in the binary fixture.
    maxMismatches: 0,
    reason: "All three accounts byte-equal post-N1. Tracking entry stays as regression guard; promotion to MUST_PASS already happened in the binary fixture.",
  },
];

const anyExist = TRACKED.some((c) => existsSync(c.pathProbe));

// STRICT_FIXTURES converts a missing tracked fixture into a throw so CI
// surfaces it instead of reporting green. Hoisted above the anyExist branch so
// BOTH the per-fixture path-missing case (inside) AND the whole-suite-absent
// case (F6, the else branch) honor it — previously the else branch skipped
// green even under strict mode, so the entire byte-equal gate could verify
// NOTHING while showing green if the fixture repos never cloned in CI.
const STRICT_FIXTURES = process.env.ANVIL_TEST_STRICT_FIXTURES === "1";

if (anyExist) {
  // Auto-clone any tracked sources that aren't on disk yet — same affordance
  // as the binary fixtures so a fresh dev box doesn't silently skip.
  ensureEscrowCloned();

  describe("Differential tracking [non-blocking ceilings]", () => {
    for (const tc of TRACKED) {
      test(`${tc.id} (≤${tc.maxMismatches})`, async () => {
        if (!existsSync(tc.pathProbe)) {
          const msg = `[diff-tracking] ${tc.id}: path missing: ${tc.pathProbe}`;
          if (STRICT_FIXTURES) throw new Error(`${msg} — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
          console.warn(`${msg} — skipping`);
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
} else if (STRICT_FIXTURES) {
  // F6 — under strict mode (CI) a completely-absent fixture set is a HARD
  // FAILURE, not a green skip: the byte-equal regression gate must actually
  // run where it's relied upon. Locally (no strict flag) it still skips so a
  // fresh dev box without the cloned repos isn't blocked.
  describe("Differential tracking [STRICT — fixtures required]", () => {
    test("tracked byte-equal fixtures must be present under ANVIL_TEST_STRICT_FIXTURES=1", () => {
      throw new Error(
        "No tracked differential sources present, but ANVIL_TEST_STRICT_FIXTURES=1 requires them. " +
        "The byte-equal regression gate would otherwise skip green and verify nothing. " +
        "Ensure the fixture repos cloned (see ensureRepoCloned helpers in fixtures/).",
      );
    });
  });
} else {
  describe("Differential tracking [SKIPPED — no fixture sources cloned]", () => {
    test.skip(`No tracked sources present locally — see ensureRepoCloned helpers in fixtures/.`, () => {});
  });
}
