/**
 * Real-world Anchor cargo-build TRACKING (out-of-corpus, non-blocking).
 *
 * Sister file to realworld-cargo.test.ts. That file gates CI: every case
 * MUST cargo-build green. This file does NOT gate CI: it records the
 * deterministic-emitter baseline for programs we haven't unblocked yet,
 * and asserts only that the error count doesn't regress beyond a recorded
 * ceiling. Once a tracking case becomes green, promote it to MUST_PASS in
 * realworld-cargo.test.ts and remove it here.
 *
 * Why this exists:
 *
 * The out-of-corpus probe (2026-04-25) surfaced four programs that each
 * trip a known emitter gap (impl-method inlining, sibling-program CPIs,
 * zero-copy). Without a tracking layer, the only way to notice that a
 * commit *worsens* one of these is to manually re-run the probe; with it,
 * each fixture asserts a `errors <= MAX` ceiling and CI catches regressions
 * the moment they land.
 *
 * Each entry's `maxErrors` is a recorded ceiling (current count + small
 * slack), not an aspiration. Tightening the ceiling as fixes land is
 * encouraged. Loosening it requires a comment explaining why.
 *
 * Source URLs are kept in code comments for reproducibility — the corpus
 * has to be cloned externally; if the path doesn't exist the case skips.
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { runBuild } from "../src/build/build-runner.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../src/parser/project-source.ts";

type Target = "pinocchio" | "native";

interface TrackedCase {
  id: string;
  target: Target;
  /** Absolute path to the fixture's `src/lib.rs`. */
  path: string;
  /** Source URL for human reproducibility. */
  source: string;
  /**
   * Highest acceptable cargo error count. Increasing requires a comment
   * explaining the regression cause. Decreasing should accompany the fix
   * commit that lowered it.
   */
  maxErrors: number;
  /** Why this case fails today. Update as the underlying gap moves. */
  reason: string;
}

const TRACKED: TrackedCase[] = [
  // NOTE: anchor-escrow-2025 was promoted to MUST_PASS in realworld-cargo.test.ts
  // after unsalvageable-helper commentout landed (errors 31/28 → 0/0).

  // coral-escrow: From-trait `ctx.accounts.into()` inlining (this commit) folds
  // the From<&mut InitializeEscrow> for CpiContext<SetAuthority> body into the
  // call site, routing init_escrow's set_authority through cpi_spl_set_authority
  // instead of pass_through. Pin 17 → 15, native 13 → 10. Remaining errors are
  // constraint-parser noise (`constraint = …, close = …` literals from
  // #[account(...)] parse) and #[account] meta-attr propagation gaps.
  {
    id: "coral-escrow",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/escrow)",
    maxErrors: 15,
    reason:
      "Constraint-parser noise + downstream emit gaps. From-trait CPI inlining landed for the CpiContext factory shape.",
  },
  {
    id: "coral-escrow",
    target: "native",
    path: "/tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/escrow)",
    maxErrors: 10,
    reason:
      "Constraint-parser noise + downstream emit gaps. Same root causes as pinocchio.",
  },

  // coral-multisig: pinocchio post-process now comments out `solana_program::
  // program::invoke{,_signed}` direct calls and the typed `let X: Instruction`
  // setup that feeds them, dropping pin 7 → 3. Remaining: `seeds` scope (the
  // body-emitter rewrites `ctx.accounts.multisig` to a local `multisig` but
  // misses the `let seeds = …` line that still uses the old name) + two
  // &Pubkey vs Pubkey comparison E0277s in the .iter().any() chain, both
  // body-emitter level fixes (#3 in this session's batch).
  {
    id: "coral-multisig",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/multisig/programs/multisig/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/multisig)",
    maxErrors: 3,
    reason: "Body-emitter quirks: &Pubkey/Pubkey comparison, missing seeds scope.",
  },
  {
    id: "coral-multisig",
    target: "native",
    path: "/tmp/coral-anchor/tests/multisig/programs/multisig/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/multisig)",
    maxErrors: 4,
    reason: "Body-emitter quirks: &Pubkey/Pubkey comparison, missing seeds scope, &*transaction deref.",
  },
];

const anyExist = TRACKED.some((c) => existsSync(c.path));

if (anyExist) {
  describe("Real-world Anchor cargo-build tracking [non-blocking ceilings]", () => {
    for (const c of TRACKED) {
      test(`${c.id} / ${c.target} (≤${c.maxErrors})`, async () => {
        if (!existsSync(c.path)) {
          console.warn(`[tracking] ${c.id}/${c.target}: skipped — path missing: ${c.path}`);
          return;
        }
        const files = collectProjectFilesFromEntry(c.path);
        const source = buildProjectSource(getProjectEntryPath(c.path), files);
        const parsed = await parseAnchor(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const out = c.target === "native"
          ? emitNativeFull(parsed.ir)
          : emitPinocchioFull(parsed.ir);
        const r = await runBuild(
          c.target,
          out.files.map((f) => ({ path: f.path, content: f.content })),
          parsed.ir.name,
        );
        const errs = r.errors.length;
        if (errs > c.maxErrors) {
          throw new Error(
            `${c.id}/${c.target} regressed: ${errs} errors (ceiling ${c.maxErrors}). Reason: ${c.reason}`,
          );
        }
        if (r.ok) {
          console.warn(
            `[tracking] ${c.id}/${c.target} now BUILDS GREEN — promote to realworld-cargo.test.ts MUST_PASS.`,
          );
        }
      }, 120_000);
    }
  });
} else {
  describe("Real-world Anchor tracking [SKIPPED — no fixture paths exist]", () => {
    test.skip(`No tracking fixtures present locally — clone the source repos to enable.`, () => {});
  });
}
