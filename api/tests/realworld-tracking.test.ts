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

  // coral-escrow: splitConstraintTokens now handles `<=` / `>=` operators
  // inside constraint values without inflating angle-depth, so each
  // `constraint = …` token in #[account(...)] is split correctly into its
  // own Constraint entry. Bare `constraint` / `close` identifiers no
  // longer leak into emit. Pin 15 → 11, native 10 → 6. Remaining gaps:
  // `seeds` scope, `to_account_info` method on bare AccountInfo, missing
  // `token_account_amount` helper for InterfaceAccount<TokenAccount>.
  {
    id: "coral-escrow",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/escrow)",
    maxErrors: 11,
    reason:
      "to_account_info on AccountInfo + missing token_account_amount + find_program_address on Pubkey array.",
  },
  {
    id: "coral-escrow",
    target: "native",
    path: "/tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/escrow)",
    maxErrors: 6,
    reason:
      "to_account_info on AccountInfo + missing token_account_amount + seeds scope.",
  },

  // coral-multisig: comparison-context-aware *X.key deref strip (this commit)
  // dropped pin 3 → 2 and native 4 → 3. The body-emitter post-process now
  // strips `*` on `*X.key[()]` when the comparison sibling is `&<expr>` or
  // when the LHS is a closure param yielded by Vec<Pubkey>::iter() (which is
  // `&Pubkey` by auto-borrow). Remaining errors are unrelated: `seeds` scope
  // (body emitter doesn't carry the source-side let seeds = …), &*transaction
  // deref of a Transaction value, transaction-not-mutable shadow.
  {
    id: "coral-multisig",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/multisig/programs/multisig/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/multisig)",
    maxErrors: 2,
    reason: "Missing seeds scope + transaction not declared mut.",
  },
  {
    id: "coral-multisig",
    target: "native",
    path: "/tmp/coral-anchor/tests/multisig/programs/multisig/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/multisig)",
    maxErrors: 3,
    reason: "Missing seeds scope + transaction deref + transaction not declared mut.",
  },

  // Token-2022 transfer-fee extension. Anchor program from program-examples
  // that uses `spl_token_2022::extension::transfer_fee::*`. Tracked here so
  // the ext-import-resolution gap doesn't silently regress. Most errors are
  // E0433 (module/crate not declared) — emitter doesn't surface the
  // spl_token_2022::extension::* import chain. Structural rewrite of the
  // transfer_fee_config CPI shape is a separate, deferred follow-up.
  {
    id: "t22-transfer-fee",
    target: "pinocchio",
    path: "/tmp/program-examples/tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-fee/anchor)",
    maxErrors: 16,
    reason: "spl_token_2022::extension::* imports not surfaced in emit.",
  },
  {
    id: "t22-transfer-fee",
    target: "native",
    path: "/tmp/program-examples/tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-fee/anchor)",
    maxErrors: 14,
    reason: "spl_token_2022::extension::* imports not surfaced in emit.",
  },

  // Token-2022 transfer-hook hello-world. Same ext-import gap as transfer-fee
  // plus the transfer_hook attribute & ExtraAccountMetaList shapes. Tracked
  // for regression guard — structural rewrite is deferred.
  {
    id: "t22-transfer-hook",
    target: "pinocchio",
    path: "/tmp/program-examples/tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-hook/hello-world/anchor)",
    maxErrors: 11,
    reason: "spl_token_2022::extension::transfer_hook + ExtraAccountMetaList unhandled.",
  },
  {
    id: "t22-transfer-hook",
    target: "native",
    path: "/tmp/program-examples/tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-hook/hello-world/anchor)",
    maxErrors: 10,
    reason: "spl_token_2022::extension::transfer_hook + ExtraAccountMetaList unhandled.",
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
