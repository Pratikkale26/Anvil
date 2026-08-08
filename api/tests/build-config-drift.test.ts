/**
 * #28 — Cargo.toml drift guard (the overflow-checks lesson).
 *
 * `/build` (build-runner.ts cargoTomlFor) and the differential/scaffold path
 * (project-scaffold.ts buildProjectScaffold) are SEPARATE Cargo.toml templates.
 * They silently diverged once: the scaffold had `overflow-checks = true`, the
 * /build templates did not — so the deployed /build API shipped programs that
 * WRAP on integer overflow where real Anchor reverts, and the differential
 * harness (which builds via the scaffold) never caught it.
 *
 * This asserts the correctness-critical `[profile.release]` setting
 * (overflow-checks) is present on BOTH paths for BOTH targets, so that exact
 * drift can't recur silently. (lto / codegen-units / opt-level are perf-only —
 * they don't change runtime account state — so they're intentionally NOT
 * required to match; only the money-safety setting is.)
 */
import { test, expect, describe } from "bun:test";
import { __internal } from "../src/build/build-runner.ts";
import {
  buildProjectScaffold,
  PINOCCHIO_OPTIONAL_DEPS,
  NATIVE_OPTIONAL_DEPS,
} from "../src/emitter/project-scaffold.ts";
const { cargoTomlFor } = __internal;
import { parseAnchor } from "../src/parser/anchor-parser.ts";

type Target = "pinocchio" | "native";

/** Trimmed dep lines (`crate = …`) inside a named TOML table. */
function depTable(toml: string, table = "[dependencies]"): string[] {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === table);
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[")) break; // next table
    if (!t || t.startsWith("#")) continue;
    if (t.includes("=")) out.push(t);
  }
  return out;
}

const supersetDeps = (target: Target) =>
  new Set(depTable(cargoTomlFor(target)));

function scaffoldCargoToml(ir: Parameters<typeof buildProjectScaffold>[0], target: Target): string {
  const scaffold = buildProjectScaffold(ir, target);
  return (
    scaffold.find((f) => f.path === "Cargo.toml" || f.path.endsWith("/Cargo.toml"))
      ?.content ?? ""
  );
}

const MAPS: Record<Target, Record<string, string>> = {
  pinocchio: PINOCCHIO_OPTIONAL_DEPS,
  native: NATIVE_OPTIONAL_DEPS,
};

/**
 * Optional-dep crates intentionally absent from the /build superset. The
 * differential injects these PER-PROGRAM (project-scaffold extractUsedCrates),
 * so they're proven to compile in isolation — but they're kept OUT of the
 * always-present /build union. Two categories:
 *   1. borsh-derive landmines / heavy version-sensitive SDKs (mpl-pinocchio,
 *      ark-*, governance, compression, zk-sdk) — would conflict or bloat.
 *   2. LEAF_DEFER — pure leaf / derive-macro crates (bs58, hex, blake3, base64,
 *      chrono, strum, serde). These DO compile in the union (verified via
 *      direct cargo), but putting them in the always-present superset makes
 *      every cold /build recompile them (+ their proc-macro deps: serde/strum
 *      pull heck/syn) just to close a gap that fails LOUDLY ("unresolved
 *      import"), not silently. Bad trade. Promotable to the superset later in a
 *      healthy build env once a cold-compile smoke can gate them in-suite.
 * Either way a /build for a program needing one fails LOUDLY, not silently, and
 * the differential still covers those programs. Each exclusion must have a
 * reason and must still be a live map entry (no stale exclusions).
 */
const LEAF_DEFER =
  "leaf/derive-macro crate the differential injects per-program; kept out of the always-present /build superset so a cold /build doesn't recompile it (+ proc-macro deps) merely to close a LOUD 'unresolved import' gap. Verified-compiling via direct cargo; promotable once a cold-compile smoke can gate it in-suite.";

const SUPERSET_EXCLUSIONS: Record<Target, Record<string, string>> = {
  pinocchio: {
    mpl_token_metadata:
      "borsh-derive interop landmine in the always-present pinocchio union (mpl 5.1 → solana-address → borsh 1.6 vs the pinocchio borsh-1.5 base) + heavy fetch. Differential injects it per-program (MPL byte-equal catalog passes); native /build carries it, pinocchio /build does not.",
    bs58: LEAF_DEFER,
    hex: LEAF_DEFER,
    blake3: LEAF_DEFER,
    strum: LEAF_DEFER,
    serde: LEAF_DEFER,
  },
  native: {
    spl_account_compression:
      "heavy SPL crate with its own solana-program-pinned dep tree; per-program-injected for the differential, kept out of the lean /build superset.",
    spl_concurrent_merkle_tree:
      "spl-account-compression sibling; per-program-injected, not in the lean /build superset.",
    spl_noop: "compression-family sibling; per-program-injected, not warmed in /build.",
    spl_governance:
      "heavy SPL governance program crate with a version-sensitive own dep tree; per-program-injected.",
    ephemeral_rollups_sdk:
      "MagicBlock ER SDK (backward-compat build): its own solana/magicblock-api dep tree is heavy and version-sensitive; per-program-injected via extractUsedCrates and proven compiling by cargo-compile-magicblock.test.ts, kept out of the always-present /build superset.",
    solana_zk_sdk: "zk crypto, heavy + toolchain-sensitive; per-program-injected, not in /build.",
    ark_bn254: "alt-bn128 pairing crypto, heavy + version-sensitive; per-program-injected.",
    ark_ff: "ark-* field crate; per-program-injected, not in the /build superset.",
    ark_serialize: "ark-* serialization crate; per-program-injected, not in the /build superset.",
    bs58: LEAF_DEFER,
    hex: LEAF_DEFER,
    chrono: LEAF_DEFER,
    blake3: LEAF_DEFER,
    base64: LEAF_DEFER,
  },
};

const MINIMAL = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod m { use super::*; pub fn go(_ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Go<'info> { pub signer: Signer<'info> }
`;

const hasOverflowChecks = (toml: string) =>
  /\[profile\.release\]/.test(toml) && /overflow-checks\s*=\s*true/.test(toml);

describe("#28 — Cargo.toml [profile.release] overflow-checks drift guard", () => {
  for (const target of ["pinocchio", "native"] as const) {
    test(`/build (build-runner) Cargo.toml has overflow-checks=true (${target})`, () => {
      expect(hasOverflowChecks(cargoTomlFor(target))).toBe(true);
    });

    test(`scaffold Cargo.toml has overflow-checks=true (${target})`, async () => {
      const r = await parseAnchor(MINIMAL);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const scaffold = buildProjectScaffold(r.ir, target);
      const toml = scaffold.find((f) => f.path === "Cargo.toml" || f.path.endsWith("/Cargo.toml"))?.content ?? "";
      expect(hasOverflowChecks(toml)).toBe(true);
    });
  }
});

/**
 * Dependency drift guard. The /build superset (build-runner cargoTomlFor) and
 * the differential/scaffold path (project-scaffold) declare deps separately, so
 * a program can be byte-equal in the differential yet fail /build (or carry a
 * different dep VERSION-STRING — the silent-divergence class, e.g. num_enum
 * with vs without default-features). This asserts every dep the scaffold can
 * emit is mirrored VERBATIM in the /build superset, or is a documented
 * exclusion. It does NOT force the heavy/landmine optional deps into the
 * always-present union (that's intentional — see SUPERSET_EXCLUSIONS).
 */
describe("#28 — Cargo.toml dependency drift guard", () => {
  for (const target of ["pinocchio", "native"] as const) {
    test(`scaffold BASE deps ⊆ /build superset, verbatim (${target})`, async () => {
      const r = await parseAnchor(MINIMAL); // no optional crates → base only
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const sup = supersetDeps(target);
      const missing = depTable(scaffoldCargoToml(r.ir, target)).filter((l) => !sup.has(l));
      expect(missing).toEqual([]);
    });

    test(`optional-dep map ⊆ /build superset (verbatim) or documented-excluded (${target})`, () => {
      const sup = supersetDeps(target);
      const unaccounted: string[] = [];
      for (const [crate, depLine] of Object.entries(MAPS[target])) {
        if (SUPERSET_EXCLUSIONS[target][crate]) continue; // documented gap
        if (!sup.has(depLine.trim())) unaccounted.push(`${crate}: ${depLine}`);
      }
      // Each entry must be EITHER verbatim in the superset OR explicitly
      // excluded — no silent middle ground (this is what catches a new map
      // dep, or a version-string that drifts out of lockstep).
      expect(unaccounted).toEqual([]);
    });

    test(`exclusions are live map entries with a documented reason (${target})`, () => {
      const stale = Object.keys(SUPERSET_EXCLUSIONS[target]).filter((c) => !(c in MAPS[target]));
      expect(stale).toEqual([]); // no exclusion for a crate the map no longer has
      const undocumented = Object.entries(SUPERSET_EXCLUSIONS[target])
        .filter(([, reason]) => reason.trim().length < 20)
        .map(([c]) => c);
      expect(undocumented).toEqual([]);
    });
  }
});
