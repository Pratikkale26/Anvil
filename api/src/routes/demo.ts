import { Router } from "express";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SolanaIR } from "../ir/schema.js";
import { parseAnchor } from "../parser/anchor-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../ir/fixtures");
const DEMO_SRC_DIR = join(__dirname, "../demo-programs");

function discoverDemos(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(DEMO_SRC_DIR)) {
    if (file.endsWith(".rs")) names.add(file.replace(/\.rs$/, ""));
  }
  for (const file of readdirSync(FIXTURES_DIR)) {
    if (file.endsWith(".json")) names.add(file.replace(/\.json$/, ""));
  }
  return [...names].sort();
}

const VALID_DEMOS = discoverDemos();
type DemoName = string;

/**
 * Demo names with a `differential-<name>.test.ts` byte-equal fixture under
 * api/tests/. Each listed demo passes a per-instruction LiteSVM scenario
 * comparing the Anchor reference build to the Anvil emit on account data,
 * lamports, and owner. The workbench renders a "byte-equal verified" badge
 * next to these in the picker.
 *
 * Add a name here when a new differential fixture lands. CI gate at
 * `realworld-tracking.test.ts` catches drift.
 */
const BYTE_EQUAL_VERIFIED_DEMOS: ReadonlySet<string> = new Set([
  "counter",
  "vault",
  "escrow",
  "amm",
  "marketplace",
  "multisig",
  "vesting",
  "staking",
  "simple-staking",
  "zero-copy-foo",
  "bumps-access",
  "has-one",
  "init-if-needed",
  "ata-mint",
  "spl-transfer",
  "spl-burn",
  "set-authority",
  "event-emit",
  "msg-emit",
  "return-data",
  "return-err",
  "sysvar-rent",
  "tip-jar",
  "program-config",
  "realloc",
  "realloc-grow",
  "optional-state",
  "cpi-custom",
  "cpi-memo",
  "close-account",
  "page-visits",
  "pda-rent-payer",
  "favorites",
  "account-data",
]);

function fixtureNeedsReparse(ir: SolanaIR): boolean {
  return ir.instructions.some((instr) =>
    instr.body.length === 0 ||
    (instr.rawBody ?? "").length === 0 ||
    instr.accounts.some((account) =>
      account.isInit && (!account.initPayer || !account.initSpace)
    )
  );
}

// Cache fixtures in memory at startup
const fixtureCache = new Map<DemoName, SolanaIR>();
for (const name of VALID_DEMOS) {
  try {
    const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf-8");
    fixtureCache.set(name, JSON.parse(raw) as SolanaIR);
  } catch {
    console.warn(`⚠️  Could not load fixture: ${name}.json`);
  }
}

// Cache source files in memory too
const sourceCache = new Map<DemoName, string>();
for (const name of VALID_DEMOS) {
  try {
    const raw = readFileSync(join(DEMO_SRC_DIR, `${name}.rs`), "utf-8");
    sourceCache.set(name, raw);
  } catch {
    console.warn(`⚠️  Could not load demo source: ${name}.rs`);
  }
}

export const demoRoute = Router();

/**
 * GET /demo/:name
 * Returns pre-loaded IR fixture + source for counter|vault|escrow|staking
 *
 * If the fixture doesn't have body data (from pre-body-classifier era),
 * automatically re-parses the source to produce a complete IR.
 */
demoRoute.get("/:name", async (req, res) => {
  const name = req.params.name as DemoName;

  if (!VALID_DEMOS.includes(name)) {
    res.status(404).json({
      error: `Unknown demo: '${name}'`,
      available: VALID_DEMOS,
    });
    return;
  }

  const source = sourceCache.get(name);
  let ir = fixtureCache.get(name);

  // Check if the fixture has body data. If not, try live parsing.
  const needsReparse = ir ? fixtureNeedsReparse(ir) : false;

  if (needsReparse && source) {
    console.log(`🔄 Fixture '${name}' is stale/incomplete — re-parsing from source...`);
    const result = await parseAnchor(source);
    if (result.ok) {
      ir = result.ir;
      fixtureCache.set(name, ir); // cache the upgraded version
    } else {
      console.warn(`⚠️ Re-parse failed for '${name}': ${result.error}`);
    }
  }

  if (!ir) {
    // Try parsing from source as last resort
    if (source) {
      const result = await parseAnchor(source);
      if (result.ok) {
        ir = result.ir;
        fixtureCache.set(name, ir);
      }
    }
    if (!ir) {
      res.status(500).json({ error: `Fixture for '${name}' not loaded` });
      return;
    }
  }

  res.json({ name, ir, source: source ?? null });
});

/**
 * GET /demo
 * List all available demo programs + which ones have a byte-equal-verified
 * differential fixture under api/tests/. The workbench renders a small
 * "byte-equal verified" badge next to the verified ones in the picker.
 */
demoRoute.get("/", (_req, res) => {
  res.json({
    demos: VALID_DEMOS,
    byteEqualVerified: VALID_DEMOS.filter((n) => BYTE_EQUAL_VERIFIED_DEMOS.has(n)),
  });
});
