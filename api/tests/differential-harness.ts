/**
 * Generic differential test harness — Anchor vs Anvil-Pinocchio runtime equality.
 *
 * Cargo-green is necessary but not sufficient. This harness takes any Anchor
 * program + a call script, builds both an Anchor .so and an Anvil-emitted
 * Pinocchio .so, runs the SAME instruction sequence against both in litesvm
 * with the SAME keypairs, then byte-compares the resulting account state.
 * If the emit drifts semantically, this fires.
 *
 * Per-fixture files become ~30-50 lines: define `setup`, `callScript`,
 * `accountsToCompare`, hand off to defineDifferential. The harness owns
 * toolchain detection (skips loudly when SBF toolchain or anchor CLI is
 * missing), build caching by source-hash, scratch-dir hygiene, and the
 * compare/diff reporting.
 *
 * Fixtures live as standalone test files (api/tests/differential-X.test.ts)
 * so each one shows up independently in CI and can be skipped without
 * affecting siblings.
 */
import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname as nodeDirname, basename } from "node:path";
import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

const CACHE_ROOT =
  process.env.ANVIL_DIFF_CACHE ??
  join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

/**
 * Hash of the parser + emitter + IR-schema source trees, computed at module
 * load. Folded into the per-fixture cache directory name so the cached
 * Anvil .so is invalidated whenever the code that produces it changes.
 *
 * Background: the harness's `buildAnvilSo` parses + emits at run time from
 * `fixture.anchorSource`. The cache hash used to cover only the source
 * blob — so a parser change (e.g. set_inner expansion in A6) didn't
 * invalidate the cached .so, the test ran the OLD emit's bytes against
 * the NEW reference, and the byte-equal verdict was misleading until the
 * cache was hand-cleared. This fix removes the manual step.
 *
 * `buildBothSos` (in api/src/build/differential-build.ts, the production
 * /build/differential path) is NOT affected: that path receives the
 * already-emitted files in its request body and hashes their content.
 * Parser/emitter changes show up there as different file content → fresh
 * hash. Only the test harness needed this.
 *
 * The walk is depth-first across .ts files in src/parser, src/emitter, and
 * src/ir/schema.ts. Costs ~50ms at module load; bounds the bug "I forgot to
 * clear the cache after editing the parser" perfectly.
 */
/**
 * Evict per-fixture cache directories older than CACHE_TTL_DAYS at module
 * load. Without this, parser-version churn (every parser/emitter edit
 * spawns a new ANVIL_CODE_VERSION → fresh cache dir, old ones stay
 * forever) accumulates over months. ~150-300 KB per .so × N fixtures × M
 * code versions adds up to GBs over a year.
 *
 * Deletion is best-effort: a stale dir we can't remove (perms, in-use)
 * is logged once and skipped. Won't fail test boot. Only sweeps the
 * top-level CACHE_ROOT children — doesn't recurse, so nested temp
 * scratch dirs (`_build_*_anchor`, `_build_*_anvil_custom`) get caught
 * by the same age check at their top-level entry.
 */
const CACHE_TTL_DAYS = (() => {
  const raw = process.env.ANVIL_DIFF_CACHE_TTL_DAYS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();

(() => {
  if (CACHE_TTL_DAYS === 0) return; // Operator opt-out via env=0.
  if (!existsSync(CACHE_ROOT)) return;
  const cutoffMs = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let evicted = 0;
  let skipped = 0;
  try {
    for (const entry of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(CACHE_ROOT, entry.name);
      try {
        const s = statSync(p);
        if (s.mtimeMs < cutoffMs) {
          rmSync(p, { recursive: true, force: true });
          evicted++;
        }
      } catch {
        skipped++;
      }
    }
    if (evicted > 0) {
      console.log(`[diff-cache] evicted ${evicted} dir(s) older than ${CACHE_TTL_DAYS}d from ${CACHE_ROOT}${skipped ? ` (${skipped} skipped)` : ""}`);
    }
  } catch (err) {
    console.warn(`[diff-cache] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

const ANVIL_CODE_VERSION = (() => {
  const targets = [
    join(import.meta.dir, "..", "src", "parser"),
    join(import.meta.dir, "..", "src", "emitter"),
    join(import.meta.dir, "..", "src", "ir", "schema.ts"),
  ];
  const h = createHash("sha256");
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    const s = statSync(p);
    if (s.isFile()) {
      if (p.endsWith(".ts")) h.update(readFileSync(p));
      return;
    }
    for (const e of readdirSync(p, { withFileTypes: true })) {
      walk(join(p, e.name));
    }
  };
  for (const t of targets) walk(t);
  return h.digest("hex").slice(0, 8);
})();

// Toolchain probes — same gates as the original counter test. Skipping with
// a loud warning is preferred over silently passing; CI on a host without
// the SBF toolchain still reports the skip in the test output.
const SBF_AVAILABLE = (() => {
  const r = spawnSync("cargo-build-sbf", ["--version"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return r.status === 0;
})();

const ANCHOR_AVAILABLE = (() => {
  const r = spawnSync("anchor", ["--version"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return r.status === 0;
})();

const SBF_TOOLCHAIN_OK = (() => {
  const r = spawnSync("cargo-build-sbf", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (r.status !== 0) return false;
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  const rustcMatch = out.match(/rustc\s+(\d+)\.(\d+)/);
  if (rustcMatch) {
    const major = parseInt(rustcMatch[1] ?? "0", 10);
    const minor = parseInt(rustcMatch[2] ?? "0", 10);
    return major > 1 || minor >= 85;
  }
  const platformMatch = out.match(/platform-tools\s+v(\d+)\.(\d+)/);
  if (platformMatch) {
    const major = parseInt(platformMatch[1] ?? "0", 10);
    const minor = parseInt(platformMatch[2] ?? "0", 10);
    return major > 1 || minor >= 52;
  }
  return true;
})();

/**
 * Per-process scratch-dir suffix. Finding #46 — when multiple `bun test`
 * invocations target the same fixture concurrently (e.g. a hung test +
 * a manual retry, or parallel agent rebuilds), they all reach
 * `_build_<fixtureName>_anchor` / `_anvil` / `_anvil_custom` and race on
 * the rmSync + writeFileSync + cargo target dir. Symptoms: "No such file
 * or directory" mid-compile, half-written Cargo.toml, intermittent
 * status=null exits.
 *
 * Suffixing each scratch dir with `process.pid` isolates each bun-test
 * run completely. The .so is still cached at the SHARED `cacheDir`
 * (which keys off source hash + code version), so subsequent calls
 * across processes reuse the cached .so without rebuilding. Only the
 * cold-build path costs extra disk for orphan scratch dirs — the
 * existing CACHE_TTL_DAYS eviction sweeps those clean.
 *
 * Exported for the rare in-process helper that wants its own scratch
 * dir following the same convention.
 */
export const SCRATCH_PID_SUFFIX = `_p${process.pid}`;

export const TOOLCHAIN_OK = SBF_AVAILABLE && ANCHOR_AVAILABLE && SBF_TOOLCHAIN_OK;
export const TOOLCHAIN_REASON = !SBF_AVAILABLE
  ? "cargo-build-sbf missing"
  : !ANCHOR_AVAILABLE
    ? "anchor CLI missing"
    : !SBF_TOOLCHAIN_OK
      ? "SBF platform-tools < v1.52 (modern Anchor's deps need rustc 1.85)"
      : "ok";

/**
 * Validate a hand-crafted test PROGRAM_ID at module import time.
 *
 * Base58 alphabet excludes `0`, `O`, `I`, `l` — and decoded bytes must be
 * exactly 32. Fixtures that ship hand-crafted IDs (instead of upstream
 * declare_id! values) repeatedly bit on these constraints during the
 * 2026-05-22 / 2026-05-23 byte-equal authoring arcs — silent at fixture
 * load, only surfacing when `new PublicKey()` rejected the string at
 * `defineDifferential` time, deep into a test run.
 *
 * Use:
 *   export const PROGRAM_ID = mkTestProgramId("MyPgmExmps111111111111111111111111111111111");
 *
 * On failure throws with the input string + the specific reason
 * (invalid char OR wrong byte length) so the fixture author can fix it
 * before any test runs. Returns the validated string on success so the
 * fixture's PROGRAM_ID export keeps its plain-string type.
 *
 * NOT enforced retroactively — existing fixtures stay on raw string
 * literals + ad-hoc `new PublicKey(...).toBytes().length` checks. This
 * is for NEW fixtures going forward.
 */
export function mkTestProgramId(s: string): string {
  // 32 bytes base58-encodes to between 43 and 44 chars (typically 44 for
  // the all-1-padded test IDs we use). Catch obvious wrong lengths early.
  if (s.length < 32 || s.length > 44) {
    throw new Error(
      `mkTestProgramId: '${s}' length ${s.length} — base58-encoded 32 bytes is 43-44 chars`,
    );
  }
  // Base58 alphabet (Bitcoin): excludes 0, O, I, l. Quick filter so the
  // PublicKey decode error message is replaced with something actionable.
  const bad = /[0OIl]/.exec(s);
  if (bad) {
    throw new Error(
      `mkTestProgramId: '${s}' contains invalid base58 char '${bad[0]}' at position ${bad.index} — alphabet excludes 0, O, I, l`,
    );
  }
  // Final authority — the actual PublicKey decoder. Catches non-base58
  // chars outside the explicit blocklist + any decode-length mismatch.
  let pk: PublicKey;
  try {
    pk = new PublicKey(s);
  } catch (e) {
    throw new Error(
      `mkTestProgramId: '${s}' failed PublicKey decode: ${(e as Error).message}`,
    );
  }
  if (pk.toBytes().length !== 32) {
    throw new Error(
      `mkTestProgramId: '${s}' decoded to ${pk.toBytes().length} bytes; need exactly 32`,
    );
  }
  return s;
}

/**
 * Caller-controlled state shared between Anchor and Anvil scenarios.
 * Whatever the setup function returns is passed to callScript and
 * accountsToCompare so the same keypairs/PDAs are used in both runs.
 */
export type DifferentialSetup = Record<string, unknown> & {
  /** At minimum, the setup should expose at least one signer. */
  authority?: Keypair;
};

export interface DifferentialFixture<S extends DifferentialSetup = DifferentialSetup> {
  /** Used in describe() label, cache directory, and scratch package name. */
  fixtureName: string;
  /** Pre-chosen base58 program ID. Same ID is used for both .so binaries. */
  programIdBase58: string;
  /** Raw Anchor Rust source — typically read from src/demo-programs/X.rs. */
  anchorSource: string;
  /**
   * Cargo package name for the standalone Anchor build crate.
   * Must be unique across fixtures (so cargo cache + .so filename don't collide).
   */
  anchorPackageName: string;
  /**
   * Extra `[dependencies]` lines appended to the Anchor build's Cargo.toml.
   * Use for fixtures that need anchor-spl, etc. The base anchor-lang dep
   * is always added.
   */
  anchorExtraDeps?: string;
  /**
   * Optional anchor-lang features to enable (in addition to the defaults).
   * Common case: `["init-if-needed"]` for fixtures using the init_if_needed
   * constraint, which requires this feature opt-in by Anchor convention
   * (re-init attack mitigation acknowledgement).
   *
   * Finding #47 — SIBLING-STRUCT FEATURE BLEED. The reference Anchor
   * crate must compile end-to-end even when the test only invokes ONE
   * instruction. If a SIBLING #[derive(Accounts)] struct in the same
   * lib.rs uses `init_if_needed` (or any other feature-gated constraint)
   * — even on an instruction your test never calls — the whole crate
   * needs `anchorLangFeatures: ["init-if-needed"]` for the macro
   * expansion of THAT sibling to produce a valid Bumps impl. Without it
   * you get `error[E0277]: SiblingStruct: Bumps is not satisfied` from
   * the sibling, miles away from the instruction you care about.
   *
   * Bit during this session: pda-mint-authority + transfer-tokens +
   * spl-token-minter all needed init-if-needed flagged even though the
   * targeted ix didn't use it. Check siblings before assuming the
   * primary ix's constraints are enough.
   */
  anchorLangFeatures?: string[];
  /**
   * Anchor version override for the matrix run. Defaults to "0.31" (the
   * baseline differential corpus version). Setting this swaps the
   * scaffold Cargo.toml's `anchor-lang` + `anchor-spl` pins to the
   * specified semver. Used by the P4.x version-matrix arc (task #28).
   *
   * The matrix run is driven by env var `ANVIL_ANCHOR_VERSION` — fixtures
   * that opt into per-version testing read this and pass it as
   * anchorVersionOverride. The default keeps single-version behavior.
   */
  anchorVersionOverride?: string;
  /**
   * One-time setup before both scenarios. Generates shared keypairs,
   * derives PDAs, etc. Called exactly once per test invocation.
   */
  setup: () => Promise<S>;
  /**
   * Runs the instruction sequence against the given LiteSVM (which already
   * has the program deployed at programId). MUST be deterministic — any
   * randomness here breaks byte-equality between the two scenarios.
   */
  callScript: (svm: LiteSVM, ctx: S, programId: PublicKey) => Promise<void>;
  /**
   * Accounts whose post-scenario state should byte-compare equal between
   * Anchor and Anvil runs. Typically PDAs whose data layout is the
   * authoritative correctness signal.
   */
  accountsToCompare: (ctx: S) => Array<{ pubkey: PublicKey; label: string }>;
  /**
   * If true (default), strip the 8-byte Anchor discriminator from each
   * compared account before comparing. Set false for accounts that don't
   * carry one (e.g. raw lamport-only PDAs).
   */
  stripDiscriminator?: boolean;
  /**
   * Per-account byte ranges to mask out before comparison (offset/length
   * in the post-discriminator-strip buffer). Useful when emitted code
   * intentionally diverges on a specific field — e.g. a bump cache. Use
   * sparingly; every mask is correctness lost.
   */
  ignoreRanges?: Record<string, Array<{ offset: number; length: number }>>;
  /**
   * If true (default), also compare account lamports across scenarios.
   * Catches divergences where the data byte-equals but the lamport
   * accounting differs (e.g. vault holding SOL, rent-exempt minimums).
   * Set false for accounts where lamports are expected to vary
   * (e.g. fee-payer with arbitrary residual after txs).
   */
  compareLamports?: boolean;
  /**
   * If true (default), also compare account owner across scenarios.
   * An account whose data + lamports byte-equal can still be silently
   * wrong if Anvil's emit transferred ownership to a different program
   * (e.g. forgot to assign back to the program after CPI). Without
   * comparing owner, that class of divergence passes the gate. Set
   * false only when the fixture intentionally hands ownership to a
   * different program mid-scenario AND the divergence is benign.
   */
  compareOwner?: boolean;
  /**
   * Which Anvil target to build the differential .so against. Default
   * pinocchio (the production target). Set "native" for fixtures that
   * exercise emit shapes Pinocchio doesn't support yet (e.g. realloc —
   * Pinocchio's AccountInfo doesn't expose realloc in the stable API).
   */
  anvilTarget?: "pinocchio" | "native";
  /**
   * If true, ALSO byte-compare event log payloads (sol_log_data lines
   * surfaced as `Program data: <base64>` in transaction logs). Default
   * false for back-compat — most fixtures don't emit events. Set true
   * for fixtures that exercise emit!() / emit_cpi!() so the gate
   * verifies events are byte-identical to Anchor's macro expansion.
   */
  compareEventLogs?: boolean;
  /**
   * If true, ALSO byte-compare set_return_data() output across runs.
   * The fifth opt-in surface. set_return_data is the cross-program
   * return-value channel; if Anchor's program returns `Result<T>` (or
   * explicitly calls set_return_data) and Anvil's emit drops or
   * re-shapes the payload, callers reading via get_return_data see
   * different bytes — this catches that. Default false; turning it on
   * for ix returning unit is harmless (both runs see no return data).
   */
  compareReturnData?: boolean;
  /**
   * If true, ALSO byte-compare user-emitted `msg!()` text logs. The
   * sixth opt-in surface. We drop the framing/CU lines that diverge
   * by design (Pinocchio uses fewer compute units, Anchor adds
   * "Program log: Instruction:" automatically), keeping only the
   * lines a program author wrote via msg!(). Catches msg!() drift
   * (a program logging different state under the same inputs).
   * Default false — most fixtures don't rely on msg!() parity.
   */
  compareMsgLogs?: boolean;
  /**
   * Revert-parity (B5). If true, capture each tx's outcome (ok vs revert) in
   * scenario order and assert Anchor + Anvil AGREE. Catches Anvil accepting a
   * tx Anchor rejects (or vice versa) when the (non-)write touches no compared
   * account, and asserts agreement instead of trivially passing on two empty
   * post-revert snapshots. Outcome only — NOT error codes (Anvil maps Anchor
   * errors to generic ProgramError, so codes diverge by design). The fixture's
   * callScript MUST tolerate the failing tx (not throw) so the scenario reaches
   * the compare.
   */
  compareTxOutcomes?: boolean;
  /**
   * Pin Clock::get().unix_timestamp before the first instruction.
   * Default: 1_700_000_000 (a fixed Unix timestamp in 2023). Programs
   * reading the clock see this exact value in both Anchor and Anvil
   * scenarios. Override per-fixture when the source's logic depends
   * on a specific timestamp (e.g. claim-after-cliff staking).
   */
  pinClockTimestamp?: number;
  /** Pin slot height before the first instruction. Default 1. */
  pinClockSlot?: number;
  /**
   * Optional path to an existing Anchor crate (the directory containing
   * Cargo.toml + src/) to build the reference .so from. When set, the
   * harness `cargo build-sbf`s that directory verbatim instead of writing
   * `anchorSource` into a scratch lib.rs.
   *
   * Required for real-world multi-file Anchor projects where the flattened
   * source isn't directly buildable (anchor-escrow-2025, anchor's own
   * test crates). The Anvil emit path still consumes `anchorSource` (the
   * flattened blob) — only the reference build switches to the directory
   * path. anchorPackageName / anchorExtraDeps / anchorLangFeatures are
   * IGNORED when this is set; the upstream Cargo.toml owns those.
   */
  anchorReferenceCrateDir?: string;
  /**
   * Auxiliary on-chain programs the scenario CPIs into. Loaded into the
   * LiteSVM via `svm.addProgram` BEFORE the fixture's callScript runs, in
   * BOTH Anchor and Anvil scenarios. The .so file lives under
   * `tests/fixtures/programs/<soFilename>` (same path scenario-runner.ts
   * uses for the HTTP-driven path).
   *
   * Example for an MPL Token Metadata differential:
   *   auxiliaryPrograms: [{
   *     programId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
   *     soFilename: "mpl_token_metadata.so",
   *   }]
   *
   * When the .so file is missing the harness throws — silent-skip would
   * trivially-pass the differential (both sides would fail the CPI
   * identically) and that's the exact false-positive class the byte-equal
   * gate is meant to prevent.
   */
  auxiliaryPrograms?: Array<{ programId: string; soFilename: string }>;
  /**
   * #2 / S4 — raw Anchor IDL JSON for crates the program imports via
   * declare_program!(X), keyed by crate name (e.g. { lever: <idl.json> }).
   * Passed to parseAnchor so the Anvil side can rewrite `<crate>::cpi::<fn>`
   * CPIs into the generic-CPI invoke shape. The Anchor reference build still
   * resolves the IDL from its own crate dir (anchorReferenceCrateDir/idls/).
   */
  externalIdls?: Record<string, unknown>;
}

/** Single account snapshot — captured post-scenario for byte-compare. */
interface AccountSnapshot {
  data: Buffer;
  lamports: bigint;
  owner: string;
}

/**
 * Top-level: defines a describe() block with a single test that runs the
 * fixture. Skips with a loud warning if the SBF/anchor toolchain isn't
 * available. Call once per file at module scope.
 */
export function defineDifferential<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
): void {
  const programId = new PublicKey(fixture.programIdBase58);
  const stripDisc = fixture.stripDiscriminator ?? true;

  if (!TOOLCHAIN_OK) {
    console.warn(
      `\n[differential-${fixture.fixtureName}] SKIPPED — ${TOOLCHAIN_REASON}.\n` +
        `  cargo-build-sbf:        ${SBF_AVAILABLE ? "found" : "MISSING"}\n` +
        `  anchor:                 ${ANCHOR_AVAILABLE ? "found" : "MISSING"}\n` +
        `  platform-tools v1.52+:  ${SBF_TOOLCHAIN_OK ? "yes" : "NO"}\n` +
        `  To enable: 'sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.13/install)"'.\n`,
    );
    describe.skip(
      `Anchor vs Anvil-Pinocchio differential [${fixture.fixtureName}] [SKIPPED — ${TOOLCHAIN_REASON}]`,
      () => {
        test.skip("see console warning", () => {});
      },
    );
    return;
  }

  describe(`Anchor vs Anvil-Pinocchio runtime correctness (${fixture.fixtureName})`, () => {
    test(
      "produces byte-equal account state",
      async () => {
        const sourceHash = bytesToHex(
          sha256(new TextEncoder().encode(fixture.anchorSource)),
        ).slice(0, 12);
        // Cache dir partitions on (source, parser+emitter+schema). Edits
        // to any of those produce a new ANVIL_CODE_VERSION → fresh build.
        // Stale dirs from prior code versions accumulate at CACHE_ROOT;
        // operators wanting them gone can `find ~/.anvil-diff-cache -mtime
        // +7 -type d -empty -delete` (no in-process eviction here — tests
        // shouldn't pay for that on every run).
        // anvilTarget MUST be in the cache key. Pinocchio and Native produce
        // structurally different .so binaries from the same Anchor source;
        // pre-fix the key omitted target so two fixtures sharing source +
        // ANVIL_CODE_VERSION but differing in target would cache-hit on
        // each other's .so. Silent false-pass class. Default "pinocchio"
        // keeps the cache directory name backward-compatible for fixtures
        // that don't override.
        const targetSuffix = fixture.anvilTarget && fixture.anvilTarget !== "pinocchio"
          ? `-${fixture.anvilTarget}`
          : "";
        const cacheDir = join(CACHE_ROOT, `${fixture.fixtureName}-${sourceHash}-${ANVIL_CODE_VERSION}${targetSuffix}`);
        mkdirSync(cacheDir, { recursive: true });
        const anchorSoPath = join(cacheDir, `${fixture.fixtureName}_anchor.so`);
        const anvilSoPath = join(cacheDir, `${fixture.fixtureName}_anvil.so`);

        if (!existsSync(anchorSoPath)) {
          await buildAnchorSo(fixture, anchorSoPath);
        }
        if (!existsSync(anvilSoPath)) {
          await buildAnvilSo(fixture, anvilSoPath);
        }

        const anchorSo = readFileSync(anchorSoPath);
        const anvilSo = readFileSync(anvilSoPath);

        // Setup runs ONCE — both scenarios share the same keypairs/PDAs.
        const ctx = await fixture.setup();

        const compareEventLogs = fixture.compareEventLogs ?? false;
        const compareReturnData = fixture.compareReturnData ?? false;
        const compareMsgLogs = fixture.compareMsgLogs ?? false;
        const anchorEventLogs: string[] = [];
        const anvilEventLogs: string[] = [];
        const anchorReturnData: Array<string | null> = [];
        const anvilReturnData: Array<string | null> = [];
        const anchorMsgLogs: string[] = [];
        const anvilMsgLogs: string[] = [];
        const compareTxOutcomes = fixture.compareTxOutcomes ?? false;
        const anchorTxOutcomes: Array<"ok" | "revert"> = [];
        const anvilTxOutcomes: Array<"ok" | "revert"> = [];
        const anchorState = await runScenario(
          fixture, anchorSo, ctx, programId,
          compareEventLogs ? anchorEventLogs : undefined,
          compareReturnData ? anchorReturnData : undefined,
          compareMsgLogs ? anchorMsgLogs : undefined,
          compareTxOutcomes ? anchorTxOutcomes : undefined,
        );
        const anvilState = await runScenario(
          fixture, anvilSo, ctx, programId,
          compareEventLogs ? anvilEventLogs : undefined,
          compareReturnData ? anvilReturnData : undefined,
          compareMsgLogs ? anvilMsgLogs : undefined,
          compareTxOutcomes ? anvilTxOutcomes : undefined,
        );

        const accounts = fixture.accountsToCompare(ctx);
        const compareLamports = fixture.compareLamports ?? true;
        const compareOwner = fixture.compareOwner ?? true;
        type Mismatch =
          | { kind: "data"; label: string; anchor: Buffer; anvil: Buffer }
          | { kind: "lamports"; label: string; anchor: bigint; anvil: bigint }
          | { kind: "owner"; label: string; anchor: string; anvil: string }
          | { kind: "presence"; label: string; anchorPresent: boolean; anvilPresent: boolean }
          | { kind: "events"; anchor: string[]; anvil: string[] }
          | { kind: "returnData"; anchor: Array<string | null>; anvil: Array<string | null> }
          | { kind: "msgLogs"; anchor: string[]; anvil: string[] }
          | { kind: "txOutcomes"; anchor: Array<"ok" | "revert">; anvil: Array<"ok" | "revert"> };
        let firstMismatch: Mismatch | null = null;

        for (const { pubkey, label } of accounts) {
          const aSnap = anchorState.get(pubkey.toBase58());
          const vSnap = anvilState.get(pubkey.toBase58());
          // Both missing = byte-equal (both runs closed/garbage-collected
          // the account). Useful for `close = X` constraint fixtures where
          // the account is fully reaped after the close instruction.
          if (!aSnap && !vSnap) continue;
          // One missing, one present = divergence — surface it as a
          // presence mismatch so the test fails loudly with a clear cause.
          if (!aSnap || !vSnap) {
            firstMismatch ??= {
              kind: "presence",
              label,
              anchorPresent: !!aSnap,
              anvilPresent: !!vSnap,
            };
            continue;
          }

          let a = aSnap.data;
          let v = vSnap.data;
          if (stripDisc) {
            a = a.length >= 8 ? a.subarray(8) : a;
            v = v.length >= 8 ? v.subarray(8) : v;
          }
          const masks = fixture.ignoreRanges?.[label];
          if (masks && masks.length > 0) {
            a = applyMask(a, masks);
            v = applyMask(v, masks);
          }
          if (!a.equals(v)) {
            firstMismatch ??= { kind: "data", label, anchor: Buffer.from(a), anvil: Buffer.from(v) };
          }
          if (compareLamports && aSnap.lamports !== vSnap.lamports) {
            firstMismatch ??= { kind: "lamports", label, anchor: aSnap.lamports, anvil: vSnap.lamports };
          }
          if (compareOwner && aSnap.owner !== vSnap.owner) {
            firstMismatch ??= { kind: "owner", label, anchor: aSnap.owner, anvil: vSnap.owner };
          }
        }

        // Event log compare. Each `Program data: <base64>` line is one
        // sol_log_data invocation. Order-significant: Anchor + Anvil
        // must emit the same events in the same order. Mismatch shows
        // the full lists side-by-side so a divergence (different
        // discriminator, different payload, missing event) is obvious.
        if (compareEventLogs) {
          if (anchorEventLogs.length !== anvilEventLogs.length ||
              anchorEventLogs.some((l, i) => l !== anvilEventLogs[i])) {
            firstMismatch ??= { kind: "events", anchor: anchorEventLogs, anvil: anvilEventLogs };
          }
        }

        // set_return_data compare. The cross-program return-value
        // channel — callers reading via get_return_data observe these
        // bytes. A handler returning Result<()> produces no return
        // data (null in the collector); Result<T> for non-unit T (or
        // an explicit set_return_data() call) produces base64'd bytes.
        // Order-significant: one entry per tx in scenario order.
        if (compareReturnData) {
          if (anchorReturnData.length !== anvilReturnData.length ||
              anchorReturnData.some((d, i) => d !== anvilReturnData[i])) {
            firstMismatch ??= { kind: "returnData", anchor: anchorReturnData, anvil: anvilReturnData };
          }
        }

        // User-emitted msg!() compare. Already-stripped of Anchor
        // framing (Instruction:/AnchorError) and Pinocchio CU/program-
        // header lines, so what remains is what a program author
        // wrote. Order-significant; a divergence means one runtime
        // logged something the other didn't.
        if (compareMsgLogs) {
          if (anchorMsgLogs.length !== anvilMsgLogs.length ||
              anchorMsgLogs.some((l, i) => l !== anvilMsgLogs[i])) {
            firstMismatch ??= { kind: "msgLogs", anchor: anchorMsgLogs, anvil: anvilMsgLogs };
          }
        }

        // Revert-parity (B5). Order-significant: Anchor + Anvil must agree on
        // success-vs-revert at each tx. Outcome only (codes diverge by design).
        if (compareTxOutcomes) {
          if (anchorTxOutcomes.length !== anvilTxOutcomes.length ||
              anchorTxOutcomes.some((o, i) => o !== anvilTxOutcomes[i])) {
            firstMismatch ??= { kind: "txOutcomes", anchor: anchorTxOutcomes, anvil: anvilTxOutcomes };
          }
        }

        if (firstMismatch) {
          if (firstMismatch.kind === "data") {
            console.log(`\n[differential-${fixture.fixtureName}] DATA MISMATCH on '${firstMismatch.label}':`);
            console.log(`  anchor (len=${firstMismatch.anchor.length}):`,
              firstMismatch.anchor.toString("hex").match(/.{1,16}/g)?.slice(0, 8));
            console.log(`  anvil  (len=${firstMismatch.anvil.length}):`,
              firstMismatch.anvil.toString("hex").match(/.{1,16}/g)?.slice(0, 8));
            const minLen = Math.min(firstMismatch.anchor.length, firstMismatch.anvil.length);
            let diffOffset = minLen;
            for (let i = 0; i < minLen; i++) {
              if (firstMismatch.anchor[i] !== firstMismatch.anvil[i]) { diffOffset = i; break; }
            }
            console.log(`  first diff at byte ${diffOffset} of ${minLen}`);
          } else if (firstMismatch.kind === "lamports") {
            console.log(`\n[differential-${fixture.fixtureName}] LAMPORT MISMATCH on '${firstMismatch.label}':`);
            console.log(`  anchor lamports: ${firstMismatch.anchor}`);
            console.log(`  anvil  lamports: ${firstMismatch.anvil}`);
            console.log(`  delta:           ${firstMismatch.anvil - firstMismatch.anchor}`);
          } else if (firstMismatch.kind === "owner") {
            console.log(`\n[differential-${fixture.fixtureName}] OWNER MISMATCH on '${firstMismatch.label}':`);
            console.log(`  anchor owner: ${firstMismatch.anchor}`);
            console.log(`  anvil  owner: ${firstMismatch.anvil}`);
            console.log(`  one side reassigned the account; the other did not.`);
          } else if (firstMismatch.kind === "events") {
            console.log(`\n[differential-${fixture.fixtureName}] EVENT LOG MISMATCH:`);
            console.log(`  anchor (${firstMismatch.anchor.length} events):`);
            for (const l of firstMismatch.anchor) console.log(`    ${l}`);
            console.log(`  anvil  (${firstMismatch.anvil.length} events):`);
            for (const l of firstMismatch.anvil) console.log(`    ${l}`);
          } else if (firstMismatch.kind === "returnData") {
            console.log(`\n[differential-${fixture.fixtureName}] RETURN DATA MISMATCH:`);
            console.log(`  anchor (${firstMismatch.anchor.length} txs):`);
            for (const d of firstMismatch.anchor) console.log(`    ${d ?? "<no return data>"}`);
            console.log(`  anvil  (${firstMismatch.anvil.length} txs):`);
            for (const d of firstMismatch.anvil) console.log(`    ${d ?? "<no return data>"}`);
            console.log(`  one runtime called set_return_data (or returned Result<T> non-unit); the other didn't, or the bytes differ.`);
          } else if (firstMismatch.kind === "msgLogs") {
            console.log(`\n[differential-${fixture.fixtureName}] MSG LOG MISMATCH:`);
            console.log(`  anchor (${firstMismatch.anchor.length} lines):`);
            for (const l of firstMismatch.anchor) console.log(`    ${l}`);
            console.log(`  anvil  (${firstMismatch.anvil.length} lines):`);
            for (const l of firstMismatch.anvil) console.log(`    ${l}`);
            console.log(`  user-emitted msg!() text diverges (Anchor framing already stripped).`);
          } else if (firstMismatch.kind === "presence") {
            console.log(`\n[differential-${fixture.fixtureName}] PRESENCE MISMATCH on '${firstMismatch.label}':`);
            console.log(`  anchor present: ${firstMismatch.anchorPresent}`);
            console.log(`  anvil  present: ${firstMismatch.anvilPresent}`);
            console.log(`  one side closed/reaped the account; the other left it live.`);
          } else if (firstMismatch.kind === "txOutcomes") {
            console.log(`\n[differential-${fixture.fixtureName}] TX OUTCOME MISMATCH (revert-parity):`);
            console.log(`  anchor (${firstMismatch.anchor.length} txs): ${firstMismatch.anchor.join(", ") || "<none>"}`);
            console.log(`  anvil  (${firstMismatch.anvil.length} txs): ${firstMismatch.anvil.join(", ") || "<none>"}`);
            console.log(`  one runtime reverted where the other succeeded (or a different number of txs ran).`);
          }
        }
        expect(firstMismatch).toBeNull();
      },
      600_000,
    );
  });
}

async function buildAnchorSo<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  outPath: string,
): Promise<void> {
  // Real-world multi-file project path: build the upstream crate verbatim.
  // The flattened `anchorSource` blob is good for parser ingestion but
  // doesn't always cargo-build (use globs are merged across modules,
  // re-exports collapse, conflicting type names surface as ambiguity).
  // Hand-written single-file fixtures take the legacy path below.
  if (fixture.anchorReferenceCrateDir) {
    const r = spawnSync(
      "cargo-build-sbf",
      ["--manifest-path", join(fixture.anchorReferenceCrateDir, "Cargo.toml")],
      { stdio: "inherit", timeout: 600_000, env: { ...process.env, RUSTFLAGS: "" } },
    );
    if (r.status !== 0) {
      throw new Error(
        `cargo build-sbf (Anchor reference crate at ${fixture.anchorReferenceCrateDir}, ${fixture.fixtureName}) failed with status ${r.status}`,
      );
    }
    // Multi-program workspaces (most real Anchor projects) emit the .so to
    // the WORKSPACE root's target/deploy, not the per-crate directory.
    // Walk up until we find the target/deploy with .so files. Fall back to
    // the per-crate path so single-crate projects still work.
    const candidates = [
      join(fixture.anchorReferenceCrateDir, "target/deploy"),
      join(fixture.anchorReferenceCrateDir, "../../target/deploy"),
      join(fixture.anchorReferenceCrateDir, "../target/deploy"),
    ];
    // The program crate's dir basename is the package name (programs/<name>),
    // so the built artifact is `<name>.so` — select it from a shared workspace
    // target/deploy rather than whichever .so sorts first.
    const programName = basename(fixture.anchorReferenceCrateDir);
    let so: Buffer | null = null;
    for (const c of candidates) {
      if (!existsSync(c)) continue;
      try {
        so = readSoFromDir(c, programName);
        break;
      } catch { /* keep looking */ }
    }
    if (!so) {
      throw new Error(
        `cargo build-sbf reported success but no .so found under any of: ${candidates.join(", ")}`,
      );
    }
    writeFileSync(outPath, so);
    return;
  }

  const scratch = join(CACHE_ROOT, `_build_${fixture.fixtureName}_anchor${SCRATCH_PID_SUFFIX}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "src"), { recursive: true });
  const cargoToml = `[package]
name = "${fixture.anchorPackageName}"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "${fixture.anchorPackageName}"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
${fixture.anchorLangFeatures && fixture.anchorLangFeatures.length > 0
  ? `anchor-lang = { version = "${fixture.anchorVersionOverride ?? "0.31"}", features = ["${fixture.anchorLangFeatures.join('", "')}"] }`
  : `anchor-lang = "${fixture.anchorVersionOverride ?? "0.31"}"`}
${fixture.anchorExtraDeps ?? ""}

[profile.release]
overflow-checks = true
`;
  writeFileSync(join(scratch, "Cargo.toml"), cargoToml);
  writeFileSync(join(scratch, "src/lib.rs"), fixture.anchorSource);
  const r = spawnSync(
    "cargo-build-sbf",
    ["--manifest-path", join(scratch, "Cargo.toml")],
    { stdio: "inherit", timeout: 600_000, env: { ...process.env, RUSTFLAGS: "" } },
  );
  if (r.status !== 0) {
    throw new Error(`cargo build-sbf (Anchor, ${fixture.fixtureName}) failed with status ${r.status}`);
  }
  const builtSo = join(scratch, "target/deploy", `${fixture.anchorPackageName}.so`);
  if (!existsSync(builtSo)) {
    throw new Error(`expected .so not produced at ${builtSo}`);
  }
  writeFileSync(outPath, readFileSync(builtSo));
}

async function buildAnvilSo<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  outPath: string,
): Promise<void> {
  const parsed = await parseAnchor(
    fixture.anchorSource,
    fixture.externalIdls ? { externalIdls: fixture.externalIdls } : undefined,
  );
  if (!parsed.ok) {
    throw new Error(`parseAnchor failed for ${fixture.fixtureName}: ${parsed.error}`);
  }
  const target = fixture.anvilTarget ?? "pinocchio";
  const out = target === "native" ? emitNativeFull(parsed.ir) : emitPinocchioFull(parsed.ir);
  const scaffoldMeta = buildProjectScaffold(parsed.ir, target);
  const scratch = join(CACHE_ROOT, `_build_${fixture.fixtureName}_anvil${SCRATCH_PID_SUFFIX}`);
  rmSync(scratch, { recursive: true, force: true });
  for (const f of scaffoldMeta) {
    const p = join(scratch, f.path);
    mkdirSync(nodeDirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  for (const f of out.files) {
    const p = join(scratch, "src", f.path);
    mkdirSync(nodeDirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  const r = spawnSync(
    "cargo-build-sbf",
    ["--manifest-path", join(scratch, "Cargo.toml")],
    { stdio: "inherit", timeout: 600_000, env: { ...process.env, RUSTFLAGS: "" } },
  );
  if (r.status !== 0) {
    throw new Error(`cargo build-sbf (Anvil, ${fixture.fixtureName}) failed with status ${r.status}`);
  }
  const targetDir = join(scratch, "target/deploy");
  const so = readSoFromDir(targetDir);
  writeFileSync(outPath, so);
}

/**
 * Programmatic byte-equal compare for callers outside the Bun test runner
 * (e.g. the AI-under-differential gate in differential-with-ai.test.ts).
 * Takes pre-built .so binaries, runs the fixture's call script in two
 * fresh LiteSVM scenarios, and returns the first mismatch (or null on
 * full equality). Mirrors the assertion path inside `defineDifferential`
 * but as a pure function so it can compose into other tests.
 */
export type CompareMismatch =
  | { kind: "data"; label: string; anchor: Buffer; anvil: Buffer; firstDiffByte: number }
  | { kind: "lamports"; label: string; anchor: bigint; anvil: bigint }
  | { kind: "owner"; label: string; anchor: string; anvil: string }
  | { kind: "presence"; label: string; anchorPresent: boolean; anvilPresent: boolean };

/**
 * Like `runDifferentialCompare` but collects EVERY mismatch instead of
 * returning on the first. Used by the tracked-ceiling differential layer
 * (M3): a fixture's `accountsToCompare` is widened to "every account the
 * scenario touches," each per-account divergence becomes one entry, and
 * the test asserts `mismatches.length <= ceiling`. This mirrors the
 * cargo-tracking pattern from realworld-tracking.test.ts (max errors)
 * but at the byte-equal compare layer.
 *
 * Presence-mismatch (one side has the account, the other doesn't) is
 * surfaced as its own kind here — the single-mismatch sibling throws on
 * post-scenario absence, but tracked ceilings WANT to count "absent on
 * one side" as a divergence rather than crashing.
 */
export async function runDifferentialCompareAll<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  anchorSo: Buffer,
  anvilSo: Buffer,
  programId: PublicKey,
  ctx: S,
): Promise<CompareMismatch[]> {
  const stripDisc = fixture.stripDiscriminator ?? true;
  const compareLamports = fixture.compareLamports ?? true;
  const compareOwner = fixture.compareOwner ?? true;

  const anchorState = await runScenario(fixture, anchorSo, ctx, programId);
  const anvilState = await runScenario(fixture, anvilSo, ctx, programId);

  const mismatches: CompareMismatch[] = [];
  const accounts = fixture.accountsToCompare(ctx);
  for (const { pubkey, label } of accounts) {
    const aSnap = anchorState.get(pubkey.toBase58());
    const vSnap = anvilState.get(pubkey.toBase58());

    // Both absent = byte-equal (both runs closed/garbage-collected).
    if (!aSnap && !vSnap) continue;
    // One present, one absent = presence divergence; record + advance to
    // next account (no further compares possible on the missing side).
    if (!aSnap || !vSnap) {
      mismatches.push({ kind: "presence", label, anchorPresent: !!aSnap, anvilPresent: !!vSnap });
      continue;
    }

    let a = aSnap.data;
    let v = vSnap.data;
    if (stripDisc) {
      a = a.length >= 8 ? a.subarray(8) : a;
      v = v.length >= 8 ? v.subarray(8) : v;
    }
    const masks = fixture.ignoreRanges?.[label];
    if (masks && masks.length > 0) {
      a = applyMask(a, masks);
      v = applyMask(v, masks);
    }
    if (!a.equals(v)) {
      const minLen = Math.min(a.length, v.length);
      let diffOffset = minLen;
      for (let i = 0; i < minLen; i++) {
        if (a[i] !== v[i]) { diffOffset = i; break; }
      }
      mismatches.push({ kind: "data", label, anchor: Buffer.from(a), anvil: Buffer.from(v), firstDiffByte: diffOffset });
      // Don't `continue` — even with a data mismatch, lamports/owner can
      // diverge separately and the tracker should record both.
    }
    if (compareLamports && aSnap.lamports !== vSnap.lamports) {
      mismatches.push({ kind: "lamports", label, anchor: aSnap.lamports, anvil: vSnap.lamports });
    }
    if (compareOwner && aSnap.owner !== vSnap.owner) {
      mismatches.push({ kind: "owner", label, anchor: aSnap.owner, anvil: vSnap.owner });
    }
  }
  return mismatches;
}

export async function runDifferentialCompare<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  anchorSo: Buffer,
  anvilSo: Buffer,
  programId: PublicKey,
  ctx: S,
): Promise<CompareMismatch | null> {
  const stripDisc = fixture.stripDiscriminator ?? true;
  const compareLamports = fixture.compareLamports ?? true;
  const compareOwner = fixture.compareOwner ?? true;

  const anchorState = await runScenario(fixture, anchorSo, ctx, programId);
  const anvilState = await runScenario(fixture, anvilSo, ctx, programId);

  const accounts = fixture.accountsToCompare(ctx);
  for (const { pubkey, label } of accounts) {
    const aSnap = anchorState.get(pubkey.toBase58());
    const vSnap = anvilState.get(pubkey.toBase58());
    if (!aSnap) throw new Error(`anchor: account ${label} (${pubkey.toBase58()}) missing post-scenario`);
    if (!vSnap) throw new Error(`anvil: account ${label} (${pubkey.toBase58()}) missing post-scenario`);

    let a = aSnap.data;
    let v = vSnap.data;
    if (stripDisc) {
      a = a.length >= 8 ? a.subarray(8) : a;
      v = v.length >= 8 ? v.subarray(8) : v;
    }
    const masks = fixture.ignoreRanges?.[label];
    if (masks && masks.length > 0) {
      a = applyMask(a, masks);
      v = applyMask(v, masks);
    }
    if (!a.equals(v)) {
      const minLen = Math.min(a.length, v.length);
      let diffOffset = minLen;
      for (let i = 0; i < minLen; i++) {
        if (a[i] !== v[i]) { diffOffset = i; break; }
      }
      return { kind: "data", label, anchor: Buffer.from(a), anvil: Buffer.from(v), firstDiffByte: diffOffset };
    }
    if (compareLamports && aSnap.lamports !== vSnap.lamports) {
      return { kind: "lamports", label, anchor: aSnap.lamports, anvil: vSnap.lamports };
    }
    if (compareOwner && aSnap.owner !== vSnap.owner) {
      return { kind: "owner", label, anchor: aSnap.owner, anvil: vSnap.owner };
    }
  }
  return null;
}

/**
 * Build helpers exposed for the AI-under-differential test path. Default
 * fixture flow caches both .so by source-hash; the AI path needs to build
 * the Anvil .so from CUSTOM (post-AI-patch) source, so it gets its own
 * fresh build call without the cache.
 */
export async function buildAnchorSoForFixture<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  outPath: string,
): Promise<void> {
  return buildAnchorSo(fixture, outPath);
}

export async function buildAnvilSoFromFiles(
  fixture: { fixtureName: string },
  emittedScaffold: Array<{ path: string; content: string }>,
  emittedSrc: Array<{ path: string; content: string }>,
  outPath: string,
): Promise<void> {
  const scratch = join(CACHE_ROOT, `_build_${fixture.fixtureName}_anvil_custom${SCRATCH_PID_SUFFIX}`);
  rmSync(scratch, { recursive: true, force: true });
  for (const f of emittedScaffold) {
    const p = join(scratch, f.path);
    mkdirSync(nodeDirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  for (const f of emittedSrc) {
    const p = join(scratch, "src", f.path);
    mkdirSync(nodeDirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  const r = spawnSync(
    "cargo-build-sbf",
    ["--manifest-path", join(scratch, "Cargo.toml")],
    { stdio: "inherit", timeout: 600_000, env: { ...process.env, RUSTFLAGS: "" } },
  );
  if (r.status !== 0) {
    throw new Error(`cargo build-sbf (Anvil custom, ${fixture.fixtureName}) failed with status ${r.status}`);
  }
  const so = readSoFromDir(join(scratch, "target/deploy"));
  writeFileSync(outPath, so);
}

async function runScenario<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  programSo: Buffer,
  ctx: S,
  programId: PublicKey,
  collectedEventLogs?: string[],
  collectedReturnData?: Array<string | null>,
  collectedMsgLogs?: string[],
  collectedTxOutcomes?: Array<"ok" | "revert">,
): Promise<Map<string, AccountSnapshot>> {
  const svm = new LiteSVM();
  svm.addProgram(programId, programSo);
  if (fixture.auxiliaryPrograms) {
    const auxDir = join(import.meta.dir, "fixtures", "programs");
    for (const aux of fixture.auxiliaryPrograms) {
      const soPath = join(auxDir, aux.soFilename);
      if (!existsSync(soPath)) {
        throw new Error(
          `auxiliary program .so missing: ${soPath}. ` +
          `Dump it via 'solana program dump ${aux.programId} ${aux.soFilename} -u <rpc>' ` +
          `and place under tests/fixtures/programs/.`,
        );
      }
      svm.addProgram(new PublicKey(aux.programId), readFileSync(soPath));
    }
  }
  // Pin clock + slot so both Anchor and Anvil scenarios see identical
  // sysvar values. Without this, programs reading Clock::get() see
  // different timestamps across the two runs and produce divergent
  // state even when the emit is correct. The pinned values are
  // deterministic per-fixture (default 1700000000s + slot 1) so cached
  // SBF builds + repeated runs produce stable byte-comparisons.
  if (typeof (svm as { warpToTimestamp?: unknown }).warpToTimestamp === "function") {
    try {
      (svm as { warpToTimestamp: (ts: bigint) => unknown })
        .warpToTimestamp(BigInt(fixture.pinClockTimestamp ?? 1_700_000_000));
    } catch { /* best-effort; fall through to natural clock */ }
  }
  if (typeof (svm as { warpToSlot?: unknown }).warpToSlot === "function") {
    try {
      (svm as { warpToSlot: (s: bigint) => unknown })
        .warpToSlot(BigInt(fixture.pinClockSlot ?? 1));
    } catch { /* same */ }
  }
  // Optional log + return-data capture. When ANY of compareEventLogs /
  // compareMsgLogs / compareReturnData is set on the fixture, we wrap
  // svm.sendTransaction so every tx flows through one extraction pass.
  // Each surface is captured into its own collector; defineDifferential
  // decides per-surface whether to actually compare. Surfaces are
  // captured from the standard tx-metadata API (logs() + returnData())
  // — no LiteSVM internals leaked.
  const needsTxCapture = !!collectedEventLogs || !!collectedReturnData || !!collectedMsgLogs || !!collectedTxOutcomes;
  if (needsTxCapture) {
    const origSend = svm.sendTransaction.bind(svm);
    (svm as unknown as { sendTransaction: (tx: unknown) => unknown }).sendTransaction = (tx: unknown) => {
      const r = origSend(tx as never);
      try {
        const ctorName = (r as { constructor?: { name?: string } })?.constructor?.name ?? "";
        let logs: string[] = [];
        let returnData: { data: () => Uint8Array; programId?: () => unknown } | null = null;
        if (ctorName === "TransactionMetadata") {
          const md = r as {
            logs?: () => string[];
            returnData?: () => { data: () => Uint8Array; programId?: () => unknown } | null;
          };
          logs = typeof md.logs === "function" ? md.logs() : [];
          returnData = typeof md.returnData === "function" ? md.returnData() ?? null : null;
        } else if (ctorName === "FailedTransactionMetadata") {
          const meta = (r as { meta?: () => { logs: () => string[] } }).meta?.();
          logs = meta?.logs?.() ?? [];
        }
        if (collectedTxOutcomes) {
          // Revert-parity (B5): record outcome per tx in scenario order.
          // Outcome only — NOT the error code (Anvil maps Anchor errors to
          // generic ProgramError, so codes diverge by design).
          collectedTxOutcomes.push(ctorName === "FailedTransactionMetadata" ? "revert" : "ok");
        }
        for (const l of logs) {
          if (collectedEventLogs && l.startsWith("Program data: ")) {
            collectedEventLogs.push(l);
          }
          if (collectedMsgLogs && l.startsWith("Program log: ")) {
            // Filter Anchor framing so user-emitted msg!() text is what
            // we compare. Pinocchio doesn't emit "Instruction:" header
            // or "AnchorError occurred." framing automatically; without
            // these filters Anchor + Anvil would diverge on framing
            // alone, regardless of user intent.
            const body = l.slice("Program log: ".length);
            if (body.startsWith("Instruction: ")) continue;
            if (body.startsWith("AnchorError occurred")) continue;
            if (body === "Left:" || body === "Right:") continue;
            collectedMsgLogs.push(l);
          }
        }
        if (collectedReturnData) {
          if (returnData) {
            const bytes = returnData.data();
            // base64 the bytes so the collected string is hashable +
            // diffable. base64 is reversible and identity-preserving.
            collectedReturnData.push(Buffer.from(bytes).toString("base64"));
          } else {
            collectedReturnData.push(null);
          }
        }
      } catch { /* best-effort */ }
      return r;
    };
  }

  await fixture.callScript(svm, ctx, programId);
  // Snapshot every account named in accountsToCompare. Use a Map so the
  // caller can index by base58 — comparing across scenarios.
  const snap = new Map<string, AccountSnapshot>();
  for (const { pubkey } of fixture.accountsToCompare(ctx)) {
    const acct = svm.getAccount(pubkey);
    if (acct) {
      snap.set(pubkey.toBase58(), {
        data: Buffer.from(acct.data),
        lamports: BigInt(acct.lamports),
        owner: new PublicKey(acct.owner).toBase58(),
      });
    }
  }
  return snap;
}

function readSoFromDir(dir: string, preferredName?: string): Buffer {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".so"));
  if (entries.length === 0) throw new Error(`no .so found in ${dir}`);
  // Multi-program workspaces (e.g. coral's cpi-returns: callee + malicious)
  // emit several .so to a SHARED target/deploy. Picking entries[0] (first
  // alphabetically) silently served a SIBLING program's .so — e.g. `callee.so`
  // for the malicious fixture, whose declare_id! then mismatches the deployed
  // program id at runtime (DeclaredProgramIdMismatch). Select the .so matching
  // this fixture's program (Anchor names it `<package>.so`, hyphens → '_') when
  // a preferred name is given; fall back to the first for single-crate builds.
  if (preferredName) {
    const want = `${preferredName.replace(/-/g, "_")}.so`;
    if (entries.includes(want)) return readFileSync(join(dir, want));
  }
  return readFileSync(join(dir, entries[0]!));
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function applyMask(buf: Buffer, masks: Array<{ offset: number; length: number }>): Buffer {
  const out = Buffer.from(buf);
  for (const { offset, length } of masks) {
    if (offset + length > out.length) continue;
    out.fill(0, offset, offset + length);
  }
  return out;
}

// ── Helpers for writing call scripts ─────────────────────────────────────────

/**
 * Compute the 8-byte Anchor instruction discriminator: first 8 bytes of
 * sha256("global:<ix_name>"). Anvil-Pinocchio emits the same convention,
 * which is what makes the swap drop-in.
 */
export function anchorIxDiscriminator(ixName: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${ixName}`)).slice(0, 8);
}

/** Encode a u64 as 8 little-endian bytes — Anchor + Borsh standard. */
export function encodeU64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  return out;
}

/** Encode an i64 as 8 little-endian bytes (two's complement). */
export function encodeI64LE(n: bigint): Uint8Array {
  const u = n < 0n ? (1n << 64n) + n : n;
  return encodeU64LE(u);
}

/** Concatenate raw byte buffers. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

// ── Re-exports for callers writing fixture call scripts ──────────────────────
export { Keypair, PublicKey };
export { LiteSVM };
export { sha256 } from "@noble/hashes/sha2.js";
