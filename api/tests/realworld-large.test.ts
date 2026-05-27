/**
 * Real-world LARGE program coverage — Marinade / Drift / Solend / etc.
 *
 * The existing realworld-cargo.test.ts pins the solana-developers/
 * program-examples corpus (43 small fixtures) as the cargo-green
 * regression layer. This file extends coverage to programs from the
 * top-50 production Solana ecosystem — programs we don't control,
 * with patterns the small corpus doesn't exercise.
 *
 * Gate: parser pass + emit pass + validator-error count under a
 * tracked ceiling. Cargo-build is intentionally NOT in scope here
 * because: (a) compiling Marinade / Drift takes 10+ minutes each
 * with 5 GB of dep cache, (b) some have private deps, (c) parser
 * pass is the highest-leverage signal that we handle the SHAPE.
 *
 * Each entry is pinned to a commit hash so upstream changes don't
 * silently regress us. The auto-clone step skips with a loud warning
 * if `git` isn't available; missing corpus = test skip, not failure.
 *
 * Tracking ceiling pattern matches realworld-tracking.test.ts:
 *   - parser must pass (hard fail)
 *   - validator error count <= ceiling (hard fail above)
 *   - ceiling is the CURRENT count + 0 — ratchet down as fixes land
 *
 * The actual ceilings are calibrated empirically on first run; an
 * initial probe sets the per-program baseline. The values below are
 * conservative starting points; bun test reports any over-ceiling
 * regression but doesn't fail green-improvement.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { buildProjectSource } from "../src/parser/project-source.ts";

const CACHE_ROOT =
  process.env.ANVIL_LARGE_REPOS_DIR ??
  join(process.env.HOME ?? "/tmp", ".anvil-large-repos");

interface Fixture {
  /** Display ID — used in describe label and cache subdir. */
  id: string;
  /** Public clone URL. */
  repo: string;
  /** Pinned commit hash for reproducibility. */
  commit: string;
  /** Path inside the repo to the Anchor program's lib.rs. */
  libPath: string;
  /** Tracking ceilings per target. Lower = better; ratchet down on improvements. */
  ceiling: { pinocchio: number; native: number };
}

// Initial entries chosen to exercise patterns the small corpus doesn't:
//   - marinade-finance: large state structs + significant CPI surface
//   - phoenix: orderbook DEX-pattern code (Anchor + native mix)
//   - solend: lending math + multi-account constraints
// Drift v2 + Jito are intentionally omitted in the first pass — Drift's
// program is split across many crates and Jito's tip distributor is
// non-Anchor. Add in a follow-up.
const LARGE_FIXTURES: Fixture[] = [
  {
    id: "marinade-liquid-staking",
    repo: "https://github.com/marinade-finance/liquid-staking-program.git",
    commit: "447f9607a8c755cab9f9dfaf03a7e0e8ce41335e",
    libPath: "programs/marinade-finance/src/lib.rs",
    // Conservative ceilings — first pass on parser; tighten after baseline.
    ceiling: { pinocchio: 200, native: 200 },
  },
  {
    id: "marginfi-v2",
    repo: "https://github.com/mrgnlabs/marginfi-v2.git",
    commit: "843aa82df852b9e9a3c555e67ffd12aa53f4805b",
    libPath: "programs/marginfi/src/lib.rs",
    ceiling: { pinocchio: 270, native: 270 },
  },
  {
    id: "raydium-clmm",
    repo: "https://github.com/raydium-io/raydium-clmm.git",
    commit: "5e13240b3e4682f5f1ab8b1456a835ac87c28ead",
    libPath: "programs/amm/src/lib.rs",
    ceiling: { pinocchio: 35, native: 35 },
  },
  {
    id: "klend",
    repo: "https://github.com/Kamino-Finance/klend.git",
    commit: "4c7653a12276ded3bcaf95a3474973ca135ca810",
    libPath: "programs/klend/src/lib.rs",
    ceiling: { pinocchio: 175, native: 175 },
  },
  // Phoenix is non-Anchor (native solana_program); listed here as a doc
  // of the gap. Anvil doesn't parse non-Anchor sources today.
  // Solend likewise has its own non-Anchor codebase. Tracking these out
  // of scope until parser support widens.
];

function collectRsFiles(dir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  if (!existsSync(dir)) return out;
  const root = dir;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const stat = statSync(cur);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(cur)) stack.push(join(cur, entry));
    } else if (stat.isFile() && cur.endsWith(".rs")) {
      out.push({
        path: relative(root, cur).replace(/\\/g, "/"),
        content: readFileSync(cur, "utf-8"),
      });
    }
  }
  return out;
}

function cloneIfNeeded(fix: Fixture): boolean {
  const dest = join(CACHE_ROOT, fix.id);
  if (existsSync(join(dest, ".git"))) return true;

  const probe = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5_000 });
  if (probe.status !== 0) {
    console.warn(`[realworld-large] git not available — skipping ${fix.id}`);
    return false;
  }
  mkdirSync(CACHE_ROOT, { recursive: true });
  const r = spawnSync(
    "git",
    ["clone", "--depth", "1", fix.repo, dest],
    { stdio: "inherit", timeout: 300_000 },
  );
  if (r.status !== 0) {
    console.warn(`[realworld-large] clone failed for ${fix.id} — network or repo issue, skipping`);
    return false;
  }
  // Best-effort checkout of the pinned commit. --depth=1 means the commit
  // probably isn't in the shallow history; if checkout fails we accept
  // the latest main as a soft-pin. Same trade-off as program-examples.
  spawnSync("git", ["fetch", "--depth", "1", "origin", fix.commit], {
    cwd: dest, stdio: "ignore", timeout: 60_000,
  });
  spawnSync("git", ["checkout", fix.commit], {
    cwd: dest, stdio: "ignore", timeout: 30_000,
  });
  return true;
}

// Same env-var pattern as realworld-tracking + realworld-cargo-coverage
// (commit e452086, task #72). Set ANVIL_TEST_STRICT_FIXTURES=1 to escalate
// silent-skips (clone failure / libPath drift) into real test failures —
// useful in CI where missing fixtures should NOT pass-by-omission.
const STRICT_FIXTURES = process.env.ANVIL_TEST_STRICT_FIXTURES === "1";

describe("Real-world LARGE program coverage (parser + emit gates)", () => {
  for (const fix of LARGE_FIXTURES) {
    test(`${fix.id}: parser passes + validator under ceiling`, async () => {
      const have = cloneIfNeeded(fix);
      if (!have) {
        const msg = `[realworld-large] ${fix.id} not available locally — skipping`;
        if (STRICT_FIXTURES) throw new Error(`${msg} — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
        console.warn(msg);
        return;
      }
      const libFile = join(CACHE_ROOT, fix.id, fix.libPath);
      if (!existsSync(libFile)) {
        const msg = `[realworld-large] ${fix.id}: ${fix.libPath} not found in cloned repo — likely the libPath drifted; update the fixture entry.`;
        if (STRICT_FIXTURES) throw new Error(`${msg} — surfacing per ANVIL_TEST_STRICT_FIXTURES=1`);
        console.warn(msg);
        return;
      }
      // Flatten the multi-file project. Marinade-class programs split
      // accounts/instructions/state across many .rs files; lib.rs alone
      // doesn't carry the #[account] structs. buildProjectSource walks
      // the program directory + inlines the mod tree into one big
      // source string the parser can chew on.
      const programDir = libFile.split("/").slice(0, -1).join("/");
      const collected = collectRsFiles(programDir);
      // Entry path is relative to programDir — `lib.rs` for marinade-style.
      const source = buildProjectSource("lib.rs", collected);

      const parsed = await parseAnchor(source);
      if (!parsed.ok) {
        throw new Error(`Parser failed on ${fix.id}: ${parsed.error}\n${parsed.details ?? ""}`);
      }
      expect(parsed.ir.instructions.length).toBeGreaterThan(0);
      expect(parsed.ir.accounts.length).toBeGreaterThan(0);

      // Pinocchio emit + validate
      const pinOut = emitPinocchioFull(parsed.ir);
      const pinIssues = validateEmitterOutput(parsed.ir, pinOut);
      const pinErrors = pinIssues.filter((i) => i.severity === "error").length;
      if (pinErrors > fix.ceiling.pinocchio) {
        console.log(`[realworld-large] ${fix.id} pinocchio: ${pinErrors} errors (ceiling ${fix.ceiling.pinocchio})`);
        for (const issue of pinIssues.filter((i) => i.severity === "error").slice(0, 5)) {
          console.log(`  ${issue.path ?? ""}: ${issue.message}`);
        }
      }
      expect(pinErrors).toBeLessThanOrEqual(fix.ceiling.pinocchio);

      // Native emit + validate
      const natOut = emitNativeFull(parsed.ir);
      const natIssues = validateEmitterOutput(parsed.ir, natOut);
      const natErrors = natIssues.filter((i) => i.severity === "error").length;
      if (natErrors > fix.ceiling.native) {
        console.log(`[realworld-large] ${fix.id} native: ${natErrors} errors (ceiling ${fix.ceiling.native})`);
      }
      expect(natErrors).toBeLessThanOrEqual(fix.ceiling.native);
    }, 600_000);
  }
});
