/**
 * Shared fixture catalog for real-world Anchor programs used by
 * realworld-cargo-coverage.test.ts and differential-auto-corpus.test.ts.
 *
 * NOT a .test.ts file — importing this from a test file does NOT pull
 * additional describe blocks into the test runner (which would re-run
 * the cargo-check sweep). Keep this file pure-data + the ensureFixture
 * helper; no top-level test registrations.
 */
import { existsSync, readFileSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../src/parser/project-source.js";

export const FIXTURE_DIR = join(import.meta.dir, "fixtures", "realworld");
// Per-repo shallow-clone cache — kept outside the repo tree.
// 7-day TTL applied at module load below; entries older than that get
// rmdir'd to avoid GB accumulation.
export const CACHE_ROOT = join(process.env.HOME ?? "/tmp", ".anvil-realworld-cache");
const CACHE_TTL_DAYS = 7;

// TTL sweep at module load.
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

export interface RealworldCase {
  id: string;
  url?: string;
  repo?: { url: string; lib: string };
  expected: "cargo-clean" | "validator-refuse" | "cargo-refuse";
  description: string;
}

function fixturePath(id: string): string {
  return join(FIXTURE_DIR, `${id}.rs`);
}

function repoSlug(url: string): string {
  const m = url.replace(/\.git$/, "").match(/github\.com\/([^/]+)\/([^/]+)/);
  return m ? `${m[1]}__${m[2]}` : url.replace(/[^A-Za-z0-9]/g, "_");
}

export function ensureFixture(c: RealworldCase): string | null {
  if (c.repo) {
    const slug = repoSlug(c.repo.url);
    const clonePath = join(CACHE_ROOT, slug);
    const libPath = join(clonePath, c.repo.lib);
    if (!existsSync(libPath)) {
      mkdirSync(CACHE_ROOT, { recursive: true });
      rmSync(clonePath, { recursive: true, force: true });
      const r = spawnSync(
        "git",
        ["clone", "--depth=1", "--filter=blob:none", c.repo.url, clonePath],
        { encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (r.status !== 0 || !existsSync(libPath)) {
        console.warn(`[realworld-fixtures] ${c.id}: clone failed or lib path missing (${libPath})`);
        return null;
      }
    }
    try {
      const entry = getProjectEntryPath(libPath);
      const files = collectProjectFilesFromEntry(libPath);
      return buildProjectSource(entry, files);
    } catch (err) {
      console.warn(`[realworld-fixtures] ${c.id}: project-source flatten failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

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

export const CASES: readonly RealworldCase[] = [
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
    description: "Vec<T> realloc",
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
    expected: "cargo-clean",
    description: "Anchor zero-copy AccountLoader",
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
    description: "Anchor's omnibus 67-ix smoke test",
  },
  {
    id: "close-account",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/close-account/anchor/programs/close-account/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "close-account flow",
  },
  {
    id: "account-data",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/account-data/anchor/programs/anchor-program-example/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "account-data with custom struct",
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
    expected: "cargo-clean",
    description: "cashier's check — full SPL transfer + PDA seeds",
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
    description: "carnival — multi-file with pub mod error/state/instructions",
  },
  {
    id: "transfer-tokens-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/transfer-tokens/anchor/programs/transfer-tokens/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "transfer-tokens — multi-file SPL transfer wrapper",
  },
  {
    id: "pda-rent-payer-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/pda-rent-payer/anchor/programs/anchor-program-example/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "pda-rent-payer (2 ix, PDA + system_program::create_account)",
  },
  {
    id: "counter-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/counter/anchor/programs/counter_anchor/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "counter (program-examples flavor, 2 ix)",
  },
  {
    id: "pda-derived-addresses-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/program-derived-addresses/anchor/programs/anchor-program-example/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "program-derived-addresses (2 ix, PDA init + read)",
  },
  {
    id: "checking-accounts-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/checking-accounts/anchor/programs/anchor-program-example/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "checking-accounts (single-ix manual account checks)",
  },
  {
    id: "t22-basics",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/token-2022/basics/anchor/programs/basics/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "Token-2022 basics — 5 ix wrappers via token_interface",
  },
  {
    id: "token-swap",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/token-swap/anchor/programs/token-swap/src/lib.rs",
    },
    expected: "validator-refuse",
    description: "token-swap — 22KB AMM (validator refuses .reload())",
  },
  {
    id: "t22-non-transferable",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/token-2022/non-transferable/anchor/programs/non-transferable/src/lib.rs",
    },
    expected: "validator-refuse",
    description: "T22 non-transferable extension — validator refuses unsupported shape",
  },
  {
    id: "nft-minter",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/nft-minter/anchor/programs/nft-minter/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "NFT minter — Metaplex create_metadata + create_master_edition (#45)",
  },
  {
    id: "rent-pe",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/rent/anchor/programs/rent-example/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "rent-example — Rent::get() + minimum_balance + create_system_account CPI",
  },
  {
    id: "token-fundraiser",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/token-fundraiser/anchor/programs/fundraiser/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "token-fundraiser — Anchor escrow w/ impl-method dispatch (4 ix)",
  },
  {
    id: "cpi-lever",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/cross-program-invocation/anchor/programs/lever/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "cpi-lever — boolean toggle + match arm msg!",
  },
  {
    id: "pda-mint-authority",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/pda-mint-authority/anchor/programs/token-minter/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "pda-mint-authority — PDA-owned mint + Metaplex create_metadata (#45)",
  },
  {
    id: "anchor-realloc",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/realloc/anchor/programs/anchor-realloc/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "anchor-realloc — realloc on String field (init + update)",
  },
  {
    id: "create-token",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/create-token/anchor/programs/create-token/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "create-token — Metaplex create_metadata_accounts_v3 (#45)",
  },
  {
    id: "transfer-sol",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/transfer-sol/anchor/programs/transfer-sol/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "transfer-sol — system_program::transfer CPI + direct lamport manipulation (2 ix)",
  },
  {
    id: "processing-instructions",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "basics/processing-instructions/anchor/programs/processing-instructions/src/lib.rs",
    },
    expected: "cargo-clean",
    description: "processing-instructions — msg!() with format args + conditional",
  },
  {
    id: "nft-operations",
    repo: {
      url: "https://github.com/solana-developers/program-examples",
      lib: "tokens/nft-operations/anchor/programs/mint-nft/src/lib.rs",
    },
    expected: "validator-refuse",
    description: "nft-operations — Metaplex builder shape (#49)",
  },
];
