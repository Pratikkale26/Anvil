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
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname as nodeDirname } from "node:path";
import { LiteSVM } from "litesvm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

const CACHE_ROOT =
  process.env.ANVIL_DIFF_CACHE ??
  join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

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

export const TOOLCHAIN_OK = SBF_AVAILABLE && ANCHOR_AVAILABLE && SBF_TOOLCHAIN_OK;
export const TOOLCHAIN_REASON = !SBF_AVAILABLE
  ? "cargo-build-sbf missing"
  : !ANCHOR_AVAILABLE
    ? "anchor CLI missing"
    : !SBF_TOOLCHAIN_OK
      ? "SBF platform-tools < v1.52 (modern Anchor's deps need rustc 1.85)"
      : "ok";

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
   * Pin Clock::get().unix_timestamp before the first instruction.
   * Default: 1_700_000_000 (a fixed Unix timestamp in 2023). Programs
   * reading the clock see this exact value in both Anchor and Anvil
   * scenarios. Override per-fixture when the source's logic depends
   * on a specific timestamp (e.g. claim-after-cliff staking).
   */
  pinClockTimestamp?: number;
  /** Pin slot height before the first instruction. Default 1. */
  pinClockSlot?: number;
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
        const cacheDir = join(CACHE_ROOT, `${fixture.fixtureName}-${sourceHash}`);
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

        const anchorState = await runScenario(fixture, anchorSo, ctx, programId);
        const anvilState = await runScenario(fixture, anvilSo, ctx, programId);

        const accounts = fixture.accountsToCompare(ctx);
        const compareLamports = fixture.compareLamports ?? true;
        type Mismatch =
          | { kind: "data"; label: string; anchor: Buffer; anvil: Buffer }
          | { kind: "lamports"; label: string; anchor: bigint; anvil: bigint };
        let firstMismatch: Mismatch | null = null;

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
            firstMismatch ??= { kind: "data", label, anchor: Buffer.from(a), anvil: Buffer.from(v) };
          }
          if (compareLamports && aSnap.lamports !== vSnap.lamports) {
            firstMismatch ??= { kind: "lamports", label, anchor: aSnap.lamports, anvil: vSnap.lamports };
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
          } else {
            console.log(`\n[differential-${fixture.fixtureName}] LAMPORT MISMATCH on '${firstMismatch.label}':`);
            console.log(`  anchor lamports: ${firstMismatch.anchor}`);
            console.log(`  anvil  lamports: ${firstMismatch.anvil}`);
            console.log(`  delta:           ${firstMismatch.anvil - firstMismatch.anchor}`);
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
  const scratch = join(CACHE_ROOT, `_build_${fixture.fixtureName}_anchor`);
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
anchor-lang = "0.31"
${fixture.anchorExtraDeps ?? ""}
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
  const parsed = await parseAnchor(fixture.anchorSource);
  if (!parsed.ok) {
    throw new Error(`parseAnchor failed for ${fixture.fixtureName}: ${parsed.error}`);
  }
  const out = emitPinocchioFull(parsed.ir);
  const scaffoldMeta = buildProjectScaffold(parsed.ir, "pinocchio");
  const scratch = join(CACHE_ROOT, `_build_${fixture.fixtureName}_anvil`);
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
  | { kind: "lamports"; label: string; anchor: bigint; anvil: bigint };

export async function runDifferentialCompare<S extends DifferentialSetup>(
  fixture: DifferentialFixture<S>,
  anchorSo: Buffer,
  anvilSo: Buffer,
  programId: PublicKey,
  ctx: S,
): Promise<CompareMismatch | null> {
  const stripDisc = fixture.stripDiscriminator ?? true;
  const compareLamports = fixture.compareLamports ?? true;

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
  const scratch = join(CACHE_ROOT, `_build_${fixture.fixtureName}_anvil_custom`);
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
): Promise<Map<string, AccountSnapshot>> {
  const svm = new LiteSVM();
  svm.addProgram(programId, programSo);
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

function readSoFromDir(dir: string): Buffer {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".so"));
  if (entries.length === 0) throw new Error(`no .so found in ${dir}`);
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
