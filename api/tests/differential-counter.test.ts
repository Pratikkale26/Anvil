/**
 * Runtime-correctness differential: Anchor vs Anvil-Pinocchio.
 *
 * Cargo-green is necessary but not sufficient — emitted code that compiles
 * can still misbehave on-chain. This test takes the canonical demo
 * (counter.rs), builds two .so binaries:
 *
 *   1. The Anchor original  → cargo build-sbf
 *   2. Anvil → Pinocchio    → bun cli compile + cargo build-sbf
 *
 * Then loads both into litesvm with the SAME program ID, sends the same
 * Initialize + Increment instructions with the same input, reads the
 * Counter account, and asserts byte-equal state. If the Anvil-emitted
 * program drifts semantically from the Anchor original, this fires.
 *
 * One fixture is the credibility lever — it converts "transpiler" from
 * a claim into evidence. Expand the corpus over time.
 *
 * Skips loudly when the SBF toolchain isn't available (cargo-build-sbf,
 * anchor) instead of silently passing.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LiteSVM } from "litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";

// Shared program ID across both builds. Solana pubkey stability + the on-
// chain "owner" check both require the same ID.
const PROGRAM_ID = new PublicKey("Counter111111111111111111111111111111111111");

const SBF_AVAILABLE = (() => {
  const r = spawnSync("cargo-build-sbf", ["--version"], { stdio: "ignore", timeout: 5_000 });
  return r.status === 0;
})();

const ANCHOR_AVAILABLE = (() => {
  const r = spawnSync("anchor", ["--version"], { stdio: "ignore", timeout: 5_000 });
  return r.status === 0;
})();

/**
 * Probe the SBF rustc version. cargo-build-sbf in Solana CLI <= 2.0.x
 * bundles rustc 1.75 which cannot compile modern Anchor's transitive
 * dependency tree (notably block-buffer 0.12 which requires edition2024,
 * stabilized in Cargo 1.85). Solana CLI 2.1+ ships rustc 1.79+ which
 * works. Detect and skip with an actionable message rather than failing
 * with a wall of cargo errors.
 */
const SBF_RUSTC_OK = (() => {
  const r = spawnSync("cargo-build-sbf", ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (r.status !== 0) return false;
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  const m = out.match(/rustc\s+(\d+)\.(\d+)/);
  if (!m) return true; // unknown — let the build try
  const major = parseInt(m[1] ?? "0", 10);
  const minor = parseInt(m[2] ?? "0", 10);
  // Need >= 1.79 to handle modern Anchor's edition2024 transitive deps.
  return major > 1 || minor >= 79;
})();

const COUNTER_SRC = join(import.meta.dir, "..", "src", "demo-programs", "counter.rs");

const CACHE_ROOT = process.env.ANVIL_DIFF_CACHE ?? join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

if (!SBF_AVAILABLE || !ANCHOR_AVAILABLE || !SBF_RUSTC_OK) {
  const why = !SBF_AVAILABLE
    ? "cargo-build-sbf missing"
    : !ANCHOR_AVAILABLE
      ? "anchor CLI missing"
      : "SBF rustc < 1.79 (Solana CLI <= 2.0.x bundles rustc 1.75 which can't compile modern Anchor's edition2024 transitive deps — upgrade to Solana CLI 2.1+)";
  console.warn(
    `\n[differential-counter] SKIPPED — ${why}.\n` +
      `  cargo-build-sbf: ${SBF_AVAILABLE ? "found" : "MISSING"}\n` +
      `  anchor:          ${ANCHOR_AVAILABLE ? "found" : "MISSING"}\n` +
      `  SBF rustc >=1.79: ${SBF_RUSTC_OK ? "yes" : "NO"}\n` +
      `  Install/upgrade Solana CLI + Anchor to enable this runtime-correctness gate.\n`,
  );
  describe.skip(`Anchor vs Anvil-Pinocchio differential [SKIPPED — ${why}]`, () => {
    test.skip("see console warning", () => {});
  });
} else {
  describe("Anchor vs Anvil-Pinocchio runtime correctness (counter)", () => {
    test("initialize + increment produce byte-equal CounterAccount state", async () => {
      // Cache the two .so by source-content hash so re-runs reuse builds.
      const counterSource = readFileSync(COUNTER_SRC, "utf-8");
      const sourceHash = bytesToHex(sha256(new TextEncoder().encode(counterSource))).slice(0, 12);
      const cacheDir = join(CACHE_ROOT, sourceHash);
      mkdirSync(cacheDir, { recursive: true });
      const anchorSoPath = join(cacheDir, "counter_anchor.so");
      const anvilSoPath = join(cacheDir, "counter_anvil.so");

      if (!existsSync(anchorSoPath)) {
        await buildAnchorSo(counterSource, anchorSoPath);
      }
      if (!existsSync(anvilSoPath)) {
        await buildAnvilSo(counterSource, anvilSoPath);
      }

      // Run the same instruction sequence against both binaries and compare
      // the resulting Counter PDA state.
      const anchorState = await runScenario(readFileSync(anchorSoPath));
      const anvilState = await runScenario(readFileSync(anvilSoPath));

      expect(anvilState.equals(anchorState)).toBe(true);
    }, 600_000); // long timeout: first-run SBF builds take minutes
  });
}

async function buildAnchorSo(source: string, outPath: string): Promise<void> {
  // Standalone Anchor scaffold pinned to the same anchor-lang version
  // the demo source assumes. cargo build-sbf produces target/deploy/<name>.so.
  const scratch = join(CACHE_ROOT, "_anchor_build");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "src"), { recursive: true });
  writeFileSync(join(scratch, "Cargo.toml"), `[package]
name = "counter_anchor_diff"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "counter_anchor_diff"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
anchor-lang = "0.31"
`);
  writeFileSync(join(scratch, "src/lib.rs"), source);
  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(scratch, "Cargo.toml")], {
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, RUSTFLAGS: "" },
  });
  if (r.status !== 0) {
    throw new Error(`cargo build-sbf (Anchor) failed with status ${r.status}`);
  }
  const builtSo = join(scratch, "target/deploy/counter_anchor_diff.so");
  if (!existsSync(builtSo)) {
    throw new Error(`expected .so not produced at ${builtSo}`);
  }
  // Copy to cache.
  writeFileSync(outPath, readFileSync(builtSo));
}

async function buildAnvilSo(source: string, outPath: string): Promise<void> {
  // Pipe through the actual emitter pipeline — no shortcuts.
  const parsed = await parseAnchor(source);
  if (!parsed.ok) throw new Error(`parseAnchor failed: ${parsed.error}`);
  const out = emitPinocchioFull(parsed.ir);
  // project-scaffold writes a complete cargo-buildable layout.
  const scaffold = buildProjectScaffold("pinocchio", parsed.ir, out);
  const scratch = join(CACHE_ROOT, "_anvil_build");
  rmSync(scratch, { recursive: true, force: true });
  for (const f of scaffold.files) {
    const p = join(scratch, f.path);
    mkdirSync(dirOf(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(scratch, "Cargo.toml")], {
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, RUSTFLAGS: "" },
  });
  if (r.status !== 0) {
    throw new Error(`cargo build-sbf (Anvil) failed with status ${r.status}`);
  }
  // The crate name in scaffold's Cargo.toml drives the .so filename.
  const targetDir = join(scratch, "target/deploy");
  const so = readSoFromDir(targetDir);
  writeFileSync(outPath, so);
}

function readSoFromDir(dir: string): Buffer {
  const fs = require("node:fs") as typeof import("node:fs");
  const entries = fs.readdirSync(dir).filter((f: string) => f.endsWith(".so"));
  if (entries.length === 0) throw new Error(`no .so found in ${dir}`);
  return fs.readFileSync(join(dir, entries[0]!));
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Scenario both programs run identically.
 * 1. initialize(start_value=10) on the counter PDA.
 * 2. increment(amount=5).
 * Returns the final raw account data of the counter PDA (skip 8-byte
 * Anchor discriminator on the Anchor side; Pinocchio side has no
 * discriminator so we strip a synthetic 8 bytes if present to align).
 */
async function runScenario(programSo: Buffer): Promise<Buffer> {
  const svm = new LiteSVM();
  svm.addProgram(PROGRAM_ID, programSo);

  const authority = Keypair.generate();
  // Fund the payer. litesvm's airdrop returns void; we just need lamports.
  svm.airdrop(authority.publicKey, BigInt(1_000_000_000));

  const [counterPda, _bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), authority.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  // Anchor instruction discriminator: first 8 bytes of sha256("global:<name>").
  // Pinocchio will look for the same discriminator IF Anvil's emit follows
  // Anchor's convention (it does — that's what makes the swap drop-in).
  const initializeIx: TransactionInstruction = makeIx(
    PROGRAM_ID,
    discriminator("initialize"),
    encodeU64(10n), // start_value=10
    [
      meta(counterPda, false, true),
      meta(authority.publicKey, true, true),
      meta(SystemProgram.programId, false, false),
    ],
  );
  const incrementIx: TransactionInstruction = makeIx(
    PROGRAM_ID,
    discriminator("increment"),
    encodeU64(5n), // amount=5
    [
      meta(counterPda, false, true),
      meta(authority.publicKey, true, false),
    ],
  );

  for (const ix of [initializeIx, incrementIx]) {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = authority.publicKey;
    tx.sign(authority);
    const r = svm.sendTransaction(tx);
    if ("err" in r) throw new Error(`tx failed: ${JSON.stringify(r.err)}`);
  }

  const acct = svm.getAccount(counterPda);
  if (!acct) throw new Error("counter account missing after run");
  // Strip 8-byte discriminator from both sides for byte-equal compare.
  return Buffer.from(acct.data.slice(8));
}

function discriminator(ixName: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${ixName}`)).slice(0, 8);
}

function encodeU64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  return out;
}

function makeIx(
  programId: PublicKey,
  disc: Uint8Array,
  data: Uint8Array,
  accounts: AccountMeta[],
): TransactionInstruction {
  const buf = new Uint8Array(disc.length + data.length);
  buf.set(disc, 0);
  buf.set(data, disc.length);
  return new TransactionInstruction({
    programId,
    keys: accounts,
    data: Buffer.from(buf),
  });
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}
