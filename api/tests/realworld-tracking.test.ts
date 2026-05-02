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
    maxErrors: 48,
    reason: "Same as pinocchio. 'info typed-local strip closed the E0261; rest is serum_dex.",
  },

  // NOTE: t22-transfer-fee/pinocchio promoted to MUST_PASS in
  // realworld-cargo.test.ts after T22 ext call-site commentout landed (16 → 0).
  {
    id: "t22-transfer-fee",
    target: "native",
    path: "/tmp/program-examples/tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-fee/anchor)",
    maxErrors: 6,
    reason: "Remaining: InterfaceAccount<TokenAccount> referenced in account structs + 2 E0599 method-not-found on AccountInfo. Extension types now auto-imported.",
  },

  // Token-2022 transfer-hook hello-world. Same ext-import gap as transfer-fee
  // plus the transfer_hook attribute & ExtraAccountMetaList shapes. Tracked
  // for regression guard — structural rewrite is deferred.
  {
    id: "t22-transfer-hook",
    target: "pinocchio",
    path: "/tmp/program-examples/tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-hook/hello-world/anchor)",
    maxErrors: 4,
    reason: "T22 extension call sites commented out in pinocchio post-process. 4 errors: 3 leaked `use spl_*::*` imports at module scope (spl_tlv_account_resolution / spl_transfer_hook_interface / spl_discriminator) that the import filter doesn't yet drop + 1 body-level type reference to `InitializeExtraAccountMetaList` from one of those filtered imports (initialize_extra_account_meta_list.rs:38). Triaged 2026-05-02 — confirmed not a regression from any recent change; the original 3-error ceiling was stale. Real fix would either (a) extend filter to drop the spl_* module imports + comment out body usages, or (b) drop the whole instruction (since it can't run without the underlying SPL crates anyway).",
  },
  {
    id: "t22-transfer-hook",
    target: "native",
    path: "/tmp/program-examples/tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    source: "solana-developers/program-examples (tokens/token-2022/transfer-hook/hello-world/anchor)",
    maxErrors: 9,
    reason: "Extension types auto-imported. 9 errors: 4 unresolved-crate imports (spl_pod, spl_tlv_account_resolution, spl_transfer_hook_interface, spl_discriminator) + 5 body-level cascade (InitializeExtraAccountMetaList × 2, TransferHookExtension, ID const, get_extension method on StateWithExtensions). Triaged 2026-05-02 — confirmed not a regression from any recent change; original 8 was stale. Same fix shape as pinocchio variant.",
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
