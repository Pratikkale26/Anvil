import { Router } from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SolanaIR } from "../ir/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../ir/fixtures");

const VALID_DEMOS = ["counter", "vault"] as const;
type DemoName = (typeof VALID_DEMOS)[number];

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
const DEMO_SRC_DIR = join(__dirname, "../demo-programs");
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
 * Returns pre-loaded IR fixture + source for counter|vault
 */
demoRoute.get("/:name", (req, res) => {
  const name = req.params.name as DemoName;

  if (!VALID_DEMOS.includes(name)) {
    res.status(404).json({
      error: `Unknown demo: '${name}'`,
      available: VALID_DEMOS,
    });
    return;
  }

  const ir = fixtureCache.get(name);
  const source = sourceCache.get(name);

  if (!ir) {
    res.status(500).json({ error: `Fixture for '${name}' not loaded` });
    return;
  }

  res.json({ name, ir, source: source ?? null });
});

/**
 * GET /demo
 * List all available demo programs
 */
demoRoute.get("/", (_req, res) => {
  res.json({ demos: VALID_DEMOS });
});
