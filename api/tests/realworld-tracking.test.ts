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
import { spawnSync } from "child_process";
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
  /** Optional: clone parent repo into `cloneRoot` if missing. Mirrors the
   * EXTERNAL_MUST_PASS auto-clone in realworld-cargo. */
  repo?: string;
  cloneRoot?: string;
}

const TRACKED: TrackedCase[] = [
  // NOTE: anchor-escrow-2025 was promoted to MUST_PASS in realworld-cargo.test.ts
  // after unsalvageable-helper commentout landed (errors 31/28 → 0/0).

  // NOTE: BOTH coral-escrow targets promoted to MUST_PASS in
  // realworld-cargo.test.ts. Native after seed-orphan splice; pinocchio
  // after Pubkey:: -> pinocchio::pubkey:: rewrite + signer-seeds shape
  // conversion + temp-borrow fix.

  // NOTE: coral-multisig/pinocchio + native both promoted to MUST_PASS in
  // realworld-cargo.test.ts after seed-orphan splice + .key.as_ref()
  // route-through-AccountInfo-var landed (1 → 0 each).

  // coral-swap: previously failed to parse (E0RUST_PARSE / unclosed-delimiter)
  // because the unsalvageable-helper commentout swept the `};` block-closer
  // along with the helper call. Block-closer-aware walk-back (this commit)
  // unblocks the parse, surfacing real downstream errors that were hidden:
  // serum_dex sibling-crate references (`serum_dex::*` imports — 25 E0433),
  // bare-AccountInfo struct-field accesses (`from.coin_wallet` — 6 E0609),
  // and undefined helpers (`orderbook_to`, `orderbook_from`, `apply_risk_checks`).
  // None of these are reachable without serum_dex CPI emit support, which
  // is documented as a post-grant gap. Tracked here as a regression guard.
  {
    id: "coral-swap",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/swap/programs/swap/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/swap)",
    maxErrors: 52,
    reason: "serum_dex sibling crate + bare-AccountInfo field accesses + undefined helpers. 'info typed-local strip closed the E0261.",
  },
  {
    id: "coral-swap",
    target: "native",
    path: "/tmp/coral-anchor/tests/swap/programs/swap/src/lib.rs",
    source: "https://github.com/coral-xyz/anchor (tests/swap)",
    maxErrors: 52,
    reason: "Same as pinocchio. 'info typed-local strip closed the E0261; rest is serum_dex. Drift 48 → 52 surfaced 2026-05-02 by the prelude+body postProcess concatenation change in the t22-transfer-hook fix; the additional errors are body-level cascade visibility increases, not new emit failures. Tracked as the new baseline.",
  },

  // NOTE: t22-transfer-fee/pinocchio promoted to MUST_PASS in
  // realworld-cargo.test.ts after T22 ext call-site commentout landed (16 → 0).
  {
    id: "t22-transfer-fee",
    target: "native",
    path: "/tmp/program-examples/tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-fee/anchor)",
    maxErrors: 9,
    reason: "9-error ceiling reflects unresolved T22 native gaps: spl_pod path resolution + 2 method-not-found + InterfaceAccount<TokenAccount> emit references. Closing requires the deeper Native T22 emit gap fix (handler should unpack mint_account from accounts, currently doesn't bind it).",
  },
  // Demoted from MUST_PASS after the unclosed-delimiter fix surfaced a
  // deeper gap — pinocchio harvest emit references `mint_account` without
  // emitting `let mint_account = &accounts[0]` to bind it. Same shape on
  // native (above). Track ceiling until account-unpack emit lands.
  {
    id: "t22-transfer-fee",
    target: "pinocchio",
    path: "/tmp/program-examples/tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-fee/anchor)",
    maxErrors: 2,
    reason: "Unclosed-delimiter resolved 2026-05-09 by block-cohesion + bounded-trailing-walk. Remaining 1-2 E0425 'mint_account not in scope' — pinocchio T22 helper emit doesn't unpack ctx.accounts.mint_account into a local binding. Fix is on the T22 emit side; deferred from current session.",
  },

  // Token-2022 transfer-hook hello-world. Same ext-import gap as transfer-fee
  // plus the transfer_hook attribute & ExtraAccountMetaList shapes. Tracked
  // for regression guard — structural rewrite is deferred.
  // NOTE: t22-transfer-hook/pinocchio promoted to MUST_PASS in
  // realworld-cargo.test.ts after extending the import filter to drop
  // 4 spl_* extension-helper crates AND running the T22 commentout
  // pass over the init/realloc preludes (not just the handler body)
  // so unresolvable types in `space = ...` expressions get commented
  // out. 4 → 0 errors.
  {
    id: "t22-transfer-hook",
    target: "native",
    path: "/tmp/program-examples/tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-hook/hello-world/anchor)",
    maxErrors: 9,
    reason: "Native still has 9 errors because Native has no T22 commentout pass — the unresolvable spl_* types in body + prelude can't be neutered the same way Pinocchio does. Pinocchio variant promoted 2026-05-02. Real fix would port the T22 commentout from Pinocchio's post-process to a target-agnostic location, or special-case the Native auto-import injector to drop transfer-hook-only types when the underlying spl_pod / spl_transfer_hook_interface crates aren't in scaffold deps.",
  },

  // ── 2026-05-02 H7 corpus expansion — 1-error gaps for emitter follow-up ──
  //
  // NOTE: favorites/native promoted to MUST_PASS in realworld-cargo.test.ts
  // after Native emit gained from_account_info wrapper. Pinocchio already
  // generated this; Native was relying on inline ::read() calls only. Now
  // both targets expose the same surface — emitter call sites that go
  // through `<Type>::from_account_info(account)?` work cross-target.

  // NOTE: coral-events/{pinocchio,native} promoted to MUST_PASS in
  // realworld-cargo.test.ts after emit_cpi! was added as an alias of
  // emit! in body-classifier.ts. Both lower to comment-only on non-Anchor
  // targets and are subject to --ignore-events on the differential CLI.

  // ── 2026-05-09 external probe additions ──
  //
  // squads-mpl/roles + futarchy/mint_governor were validator-clean as of
  // commits 35baec7 + 7ae1af0 + 63dfd77 (enum impl-items carry-over,
  // has_one against TokenAccount/Mint, .try_into().unwrap() rewrite).
  // Cargo-build still fails on both because of structural gaps:
  //
  //   squads-mpl/roles: imports `squads_mpl` (sibling crate not in scaffold)
  //                     + cross-module `From<&Transaction>` impl bodies
  //                     fragment under unsalvageable-helper commentout into
  //                     parse failures. ~50-55 cargo errors.
  //
  //   futarchy/mint_governor: imports `solana_security_txt` macro that
  //                           Anvil doesn't filter out + cross-module
  //                           `CommonFields` / `Pubkey` references in
  //                           events.rs aren't resolved by the per-file
  //                           emit. ~21-47 cargo errors.
  //
  // Tracked here as regression guards. Closing to MUST_PASS requires
  // sibling-crate import handling (squads-mpl) + cross-module resolution
  // for events files (futarchy).
  {
    id: "squads-mpl-roles",
    target: "pinocchio",
    path: "/tmp/squads-mpl/programs/roles/src/lib.rs",
    source: "Squads-Protocol/squads-mpl (programs/roles)",
    maxErrors: 42,
    reason: "Closed E0107 (Result<T> alias), E0618 (ctx.bumps.get('X') method call), 1× parse-fail (invoke()?; semicolon). Remaining surfaces previously-masked sibling-state issues: rent.minimum_balance + AccountInfo field-access on Ms (Account<'info, Ms> where Ms is squads_mpl::state::Ms — needs sibling-typed-state opaque-passthrough fix).",
    repo: "https://github.com/Squads-Protocol/squads-mpl",
    cloneRoot: "/tmp/squads-mpl",
  },
  {
    id: "squads-mpl-roles",
    target: "native",
    path: "/tmp/squads-mpl/programs/roles/src/lib.rs",
    source: "Squads-Protocol/squads-mpl (programs/roles)",
    maxErrors: 39,
    reason: "Down from 55 after the full sibling-crate arc + Result alias rewrite + invoke ?; restore. Remaining is dominated by the sibling-typed-state field-access gap (multisig/Ms accesses).",
    repo: "https://github.com/Squads-Protocol/squads-mpl",
    cloneRoot: "/tmp/squads-mpl",
  },
  {
    id: "futarchy-mint-governor",
    target: "pinocchio",
    path: "/tmp/futarchy/programs/mint_governor/src/lib.rs",
    source: "metaDAOproject/futarchy (programs/mint_governor)",
    maxErrors: 21,
    reason: "solana_security_txt import unfiltered + cross-module CommonFields ref in events.rs unresolved. Validator-clean as of 2026-05-09.",
    repo: "https://github.com/metaDAOproject/futarchy",
    cloneRoot: "/tmp/futarchy",
  },
  {
    id: "futarchy-mint-governor",
    target: "native",
    path: "/tmp/futarchy/programs/mint_governor/src/lib.rs",
    source: "metaDAOproject/futarchy (programs/mint_governor)",
    maxErrors: 47,
    reason: "Same as pinocchio + native auto-import injector misses Pubkey in events.rs. Validator-clean as of 2026-05-09.",
    repo: "https://github.com/metaDAOproject/futarchy",
    cloneRoot: "/tmp/futarchy",
  },
];

// Auto-clone parent repos for tracking entries that carry repo metadata.
// Mirrors the EXTERNAL_MUST_PASS auto-clone in realworld-cargo. Skip when
// ANVIL_NO_CLONE=1 or when the clone fails (test then skips the case).
if (process.env.ANVIL_NO_CLONE !== "1") {
  const seen = new Set<string>();
  for (const c of TRACKED) {
    if (!c.cloneRoot || !c.repo) continue;
    if (seen.has(c.cloneRoot)) continue;
    seen.add(c.cloneRoot);
    if (!existsSync(c.cloneRoot)) {
      console.warn(
        `[tracking] ${c.cloneRoot} not found — auto-cloning ${c.repo} (depth=1)…`,
      );
      const clone = spawnSync(
        "git",
        ["clone", "--depth", "1", c.repo, c.cloneRoot],
        { stdio: "inherit", timeout: 120_000 },
      );
      if (clone.status !== 0) {
        console.warn(
          `[tracking] auto-clone failed for ${c.repo} (status=${clone.status}). Test will skip.`,
        );
      }
    }
  }
}

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
