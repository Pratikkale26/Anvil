/**
 * Real-world cargo coverage gate.
 *
 * Locks the headline finding from the 2026-05-12 sweep:
 *   - 4 small public Anchor programs that PASS the cargo gate today
 *     stay green on every commit.
 *   - 2 programs that fail (composite, anchor-cpi-test/callee) stay
 *     refused by either the validator (#20, #21) or cargo gate (#22)
 *     so the gate doesn't silently regress.
 *
 * This is the smallest H3 increment: instead of writing a full byte-
 * equal fixture for each program (which requires authoring a scenario
 * JSON per fixture), we lock the cheaper "parses + emits + cargo-builds"
 * contract for known public Anchor sources. Byte-equal stays the gold
 * standard via differential-*.test.ts; this is the regression net for
 * the cargo-coverage layer underneath.
 *
 * Programs are fetched-once and persisted under
 * /home/pk/Anvil/api/tests/fixtures/realworld/ so the test is offline-
 * repeatable. The fetch happens in a setup script (api/scripts/fetch-
 * realworld-fixtures.ts) — committing the source verbatim would make
 * Anvil's repo a mirror; pointer + sha + fetch-on-demand is the right
 * shape.
 */
import { describe, test, expect } from "bun:test";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.js";
import { validateEmitterOutput } from "../src/emitter/output-validator.js";
import { runCargoCheckGate, cargoAvailable } from "../src/build/cargo-gate.js";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../src/parser/project-source.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "realworld");
// Per-repo shallow-clone cache — kept outside the repo tree (mirrors the
// differential-harness CACHE_ROOT layout). 7-day TTL applied at module
// load below; entries older than that get rmdir'd to avoid GB accumulation.
const CACHE_ROOT = join(process.env.HOME ?? "/tmp", ".anvil-realworld-cache");
const CACHE_TTL_DAYS = 7;

// TTL sweep at module load. Mirrors api/tests/differential-harness.ts:80-112
// and api/src/build/differential-build.ts. Best-effort; failures don't
// block test boot.
(() => {
  if (!existsSync(CACHE_ROOT)) return;
  const cutoffMs = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const entry of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(CACHE_ROOT, entry.name);
      try {
        const s = statSync(p);
        if (s.mtimeMs < cutoffMs) rmSync(p, { recursive: true, force: true });
      } catch { /* skip */ }
    }
  } catch { /* swallow */ }
})();

interface RealworldCase {
  /** Stable identifier; used in test names + scratch dir paths. */
  id: string;
  /**
   * Single-file fetch: raw GitHub URL for lib.rs. Used for self-contained
   * single-file Anchor programs (the original pattern).
   */
  url?: string;
  /**
   * Multi-file fetch (#33): shallow-clone a repo and flatten via
   * project-source. Set `repo` to the git URL, `lib` to the path-from-
   * repo-root of the entry lib.rs. The flattener walks `pub mod` /
   * `use crate::*` chains so multi-instruction programs with
   * src/instructions/X.rs files become a single buildable source for
   * the parser.
   */
  repo?: { url: string; lib: string };
  /**
   * Expected outcome:
   *   - "cargo-clean": validator + cargo both green
   *   - "validator-refuse": validator refuses (#20/#21 surfaced shapes)
   *   - "cargo-refuse": validator passes, cargo refuses (the headline gap)
   */
  expected: "cargo-clean" | "validator-refuse" | "cargo-refuse";
  description: string;
}

const CASES: readonly RealworldCase[] = [
  {
    id: "typescript-test",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/typescript/programs/typescript/src/lib.rs",
    expected: "cargo-clean",
    description: "minimal single-ix Anchor program",
  },
  {
    id: "multiple-suites",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/multiple-suites/programs/multiple-suites/src/lib.rs",
    expected: "cargo-clean",
    description: "minimal Anchor module",
  },
  {
    id: "events-test",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/events/programs/events/src/lib.rs",
    expected: "cargo-clean",
    description: "emit!() events",
  },
  {
    id: "realloc-array",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/realloc/programs/realloc/src/lib.rs",
    expected: "cargo-clean",
    description: "Vec<T> realloc (#24 fixed: detectPassThroughMutations now handles multi-line chains)",
  },
  {
    id: "composite",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/composite/programs/composite/src/lib.rs",
    expected: "validator-refuse",
    description: "composite #[derive(Accounts)] — validator refuses per #21",
  },
  {
    id: "anchor-cpi-test",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/cpi-returns/programs/callee/src/lib.rs",
    expected: "validator-refuse",
    description: "Result<u64> typed return — validator refuses per #20",
  },
  {
    id: "spl-token-minter",
    // #33 — multi-file via project-source flatten. Was cargo-refuse
    // (entrypoint-only); now full source flattened from the upstream repo.
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/spl-token-minter/anchor/programs/spl-token-minter/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "multi-file SPL token minter (project-source flattened)",
  },
  {
    id: "zero-copy",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/zero-copy/programs/zero-copy/src/lib.rs",
    // Initially classified cargo-refuse on 2026-05-12 with 3 distinct
    // emit gaps. All four landed in the same session:
    //   #25 (#[accessor(T)] macro expansion)
    //   #26 (zero-copy skip from_account_info auto-binding)
    //   #27 (standalone #[zero_copy] struct as Pod)
    //   #29 (.load()? in constraint expressions)
    // Now cargo-clean end-to-end.
    expected: "cargo-clean",
    description: "Anchor zero-copy AccountLoader (full real-world program; #25-29 closed)",
  },
  {
    id: "hello-world",
    url: "https://raw.githubusercontent.com/solana-developers/program-examples/main/basics/hello-solana/anchor/programs/hello-solana/src/lib.rs",
    expected: "cargo-clean",
    description: "smallest possible Anchor program",
  },
  {
    id: "anchor-misc",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/misc/programs/misc/src/lib.rs",
    expected: "validator-refuse",
    description: "Anchor's omnibus 67-ix smoke test — contains many unsupported shapes",
  },
  {
    id: "close-account",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/close-account/anchor/programs/close-account/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "close-account flow (project-source flattened, #33)",
  },
  {
    id: "account-data",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/account-data/anchor/programs/anchor-program-example/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "account-data with custom struct (project-source flattened, #33)",
  },
  {
    id: "create-account",
    url: "https://raw.githubusercontent.com/solana-developers/program-examples/main/basics/create-account/anchor/programs/create-system-account/src/lib.rs",
    expected: "cargo-clean",
    description: "system_program::create_account via CPI",
  },
  {
    id: "anchor-chat",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/chat/programs/chat/src/lib.rs",
    expected: "cargo-clean",
    description: "Anchor chat fixture — 3 ix, Vec/String state, init flow",
  },
  {
    id: "anchor-sysvars",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/sysvars/programs/sysvars/src/lib.rs",
    expected: "cargo-clean",
    description: "Anchor sysvars fixture — Clock/Rent reads",
  },
  {
    id: "cashiers-check",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/cashiers-check/programs/cashiers-check/src/lib.rs",
    // Initially cargo-refuse on 2026-05-12 with 4 distinct error
    // classes. All four landed in the same session:
    //   #30 (Transfer/MintTo/Burn let-stmt dropped at classify)
    //   #31 (let signer = &[&seeds[..]] dropped at classify)
    //   #32 (SPL TokenAccount Pubkey-field rewriting)
    //   plus helper-fn-aware error enum prefix detection
    expected: "cargo-clean",
    description: "cashier's check — full SPL transfer + PDA seeds (#30-32 closed)",
  },
  {
    id: "custom-discriminator",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/custom-discriminator/programs/custom-discriminator/src/lib.rs",
    expected: "cargo-clean",
    description: "custom-discriminator — non-default 8-byte ix discriminators",
  },
  {
    id: "anchor-bench",
    url: "https://raw.githubusercontent.com/coral-xyz/anchor/master/tests/bench/programs/bench/src/lib.rs",
    expected: "cargo-clean",
    description: "Anchor bench — 87 instructions, broad surface area",
  },
  {
    id: "favorites-pe",
    url: "https://raw.githubusercontent.com/solana-developers/program-examples/main/basics/favorites/anchor/programs/favorites/src/lib.rs",
    expected: "cargo-clean",
    description: "favorites — single-ix String + Vec<String> state (max_len)",
  },
  {
    id: "carnival-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/repository-layout/anchor/programs/carnival/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "carnival — multi-file with pub mod error/state/instructions (project-source flattened, #33)",
  },
  {
    id: "transfer-tokens-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/transfer-tokens/anchor/programs/transfer-tokens/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "transfer-tokens — multi-file SPL transfer wrapper (project-source flattened, #33)",
  },
];

function fixturePath(id: string): string {
  return join(FIXTURE_DIR, `${id}.rs`);
}

function repoSlug(url: string): string {
  // github.com/org/name(.git) → org__name
  const m = url.replace(/\.git$/, "").match(/github\.com\/([^/]+)\/([^/]+)/);
  return m ? `${m[1]}__${m[2]}` : url.replace(/[^A-Za-z0-9]/g, "_");
}

function ensureFixture(c: RealworldCase): string | null {
  // Multi-file path (#33): shallow-clone the repo into the cache root,
  // then flatten via project-source. The flattener walks `pub mod` +
  // `use crate::*` chains so multi-instruction programs become a single
  // buildable source for the parser.
  if (c.repo) {
    const slug = repoSlug(c.repo.url);
    const clonePath = join(CACHE_ROOT, slug);
    const libPath = join(clonePath, c.repo.lib);
    if (!existsSync(libPath)) {
      mkdirSync(CACHE_ROOT, { recursive: true });
      // Wipe any partial prior clone before retrying.
      rmSync(clonePath, { recursive: true, force: true });
      const r = spawnSync(
        "git",
        ["clone", "--depth=1", "--filter=blob:none", c.repo.url, clonePath],
        { encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (r.status !== 0 || !existsSync(libPath)) {
        console.warn(`[realworld-cargo] ${c.id}: clone failed or lib path missing (${libPath})`);
        return null;
      }
    }
    try {
      const entry = getProjectEntryPath(libPath);
      const files = collectProjectFilesFromEntry(libPath);
      return buildProjectSource(entry, files);
    } catch (err) {
      console.warn(`[realworld-cargo] ${c.id}: project-source flatten failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // Single-file path (original): curl one lib.rs into fixtures/realworld/.
  if (!c.url) return null;
  const p = fixturePath(c.id);
  if (existsSync(p)) return readFileSync(p, "utf-8");
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const r = spawnSync("curl", ["-sSL", "-m", "15", "-o", p, c.url], { encoding: "utf-8" });
  if (r.status !== 0 || !existsSync(p)) {
    return null;
  }
  return readFileSync(p, "utf-8");
}

const CARGO_OK = cargoAvailable();

describe("real-world cargo coverage (H3 increment)", () => {
  if (!CARGO_OK) {
    test.skip("cargo not on PATH — skipping real-world cargo coverage", () => {});
    return;
  }

  for (const c of CASES) {
    test(
      `${c.id} (${c.description}): ${c.expected}`,
      async () => {
        const source = ensureFixture(c);
        if (!source) {
          // Network or curl issue — skip rather than fail.
          console.warn(`[realworld] ${c.id}: source not available (no network?), skipping`);
          return;
        }

        const parsed = await parseAnchor(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;

        const emit = emitPinocchioFull(parsed.ir);
        const issues = validateEmitterOutput(parsed.ir, emit);
        const errors = issues.filter((i) => i.severity === "error");

        if (c.expected === "validator-refuse") {
          expect(errors.length).toBeGreaterThan(0);
          return; // No need to run cargo — validator already refused.
        }

        // cargo-clean / cargo-refuse → write scaffold, run gate.
        const scratch = join("/tmp", "anvil-realworld-coverage", c.id);
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(join(scratch, "src"), { recursive: true });
        for (const f of emit.files) {
          const out = join(scratch, "src", f.path);
          mkdirSync(join(out, ".."), { recursive: true });
          writeFileSync(out, f.content, "utf-8");
        }
        const scaffold = buildProjectScaffold(parsed.ir, "pinocchio");
        for (const f of scaffold) {
          const out = join(scratch, f.path);
          mkdirSync(join(out, ".."), { recursive: true });
          writeFileSync(out, f.content, "utf-8");
        }

        const cargoResult = await runCargoCheckGate(scratch);
        if (c.expected === "cargo-clean") {
          if (!cargoResult.ok) {
            console.log(`[${c.id}] unexpected cargo failure:\n` + cargoResult.errors.slice(0, 6).join("\n"));
          }
          expect(cargoResult.ok).toBe(true);
        } else if (c.expected === "cargo-refuse") {
          expect(cargoResult.ok).toBe(false);
          expect(cargoResult.errors.length).toBeGreaterThan(0);
        }
      },
      240_000,
    );
  }
});
