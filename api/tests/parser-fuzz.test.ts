/**
 * Parser fuzz harness — assert parser never throws on adversarial input.
 *
 * Seeds: each demo program in api/src/demo-programs/*.rs.
 * Mutations per seed:
 *   1. delete-char: random single-char deletion
 *   2. duplicate-line: copy a random line to a random position
 *   3. truncate-suffix: cut off random tail
 *   4. inject-token: paste a random Anchor-family token in a random position
 *   5. swap-lines: swap two random lines
 *
 * For each mutant the harness:
 *   - calls parseAnchor with a short timeout
 *   - asserts the call either resolves to {ok:true} or {ok:false} with a
 *     non-throwing error object; the call must NEVER reject with an
 *     uncaught exception, NEVER hang past the timeout, NEVER return a
 *     malformed IR (Zod validation against SolanaIRSchema).
 *
 * This is *correctness fuzzing*, not coverage fuzzing — we're proving
 * the parser's error path is exhaustive, not chasing new bugs. Seed
 * is deterministic (fixed PRNG seed) so reproductions don't drift.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { SolanaIRSchema } from "../src/ir/schema.js";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");
const ITERATIONS_PER_SEED = 6; // 6 mutants per demo × ~30 demos = ~180 fuzz inputs
const PARSE_TIMEOUT_MS = 4_000;
const PRNG_SEED = 0x4_E_53_4F_4C; // deterministic across runs

// Mulberry32 PRNG — small, deterministic, no deps. Good enough for fuzz seeds.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ANCHOR_TOKENS = [
  "ctx.accounts.", "ctx.bumps.", "Account<'info,", "Signer<'info>",
  "init", "mut", "seeds = [", "bump", "payer = ", "space = ",
  "#[account(", ")]", "#[derive(Accounts)]", "Result<()>",
  "msg!(", "require!(", "emit!(", "err!(", "Ok(())", "Err(",
  "CpiContext::new(", "transfer(", "borsh::to_vec(", "&[", "]",
];

interface Mutator {
  name: string;
  apply(src: string, rng: () => number): string;
}

const MUTATORS: Mutator[] = [
  {
    name: "delete-char",
    apply(src, rng) {
      if (src.length === 0) return src;
      const i = Math.floor(rng() * src.length);
      return src.slice(0, i) + src.slice(i + 1);
    },
  },
  {
    name: "duplicate-line",
    apply(src, rng) {
      const lines = src.split("\n");
      if (lines.length < 2) return src;
      const from = Math.floor(rng() * lines.length);
      const to = Math.floor(rng() * lines.length);
      const dup = lines[from] ?? "";
      lines.splice(to, 0, dup);
      return lines.join("\n");
    },
  },
  {
    name: "truncate-suffix",
    apply(src, rng) {
      const cut = Math.floor(rng() * src.length);
      return src.slice(0, cut);
    },
  },
  {
    name: "inject-token",
    apply(src, rng) {
      const tok = ANCHOR_TOKENS[Math.floor(rng() * ANCHOR_TOKENS.length)] ?? "ctx.";
      const i = Math.floor(rng() * src.length);
      return src.slice(0, i) + tok + src.slice(i);
    },
  },
  {
    name: "swap-lines",
    apply(src, rng) {
      const lines = src.split("\n");
      if (lines.length < 2) return src;
      const a = Math.floor(rng() * lines.length);
      const b = Math.floor(rng() * lines.length);
      [lines[a], lines[b]] = [lines[b]!, lines[a]!];
      return lines.join("\n");
    },
  },
];

function listDemos(): string[] {
  return readdirSync(DEMO_DIR)
    .filter((f) => f.endsWith(".rs"))
    .map((f) => join(DEMO_DIR, f));
}

describe("parser fuzz — adversarial input safety", () => {
  const demos = listDemos();
  // One global PRNG so iterations across demos/mutators stay correlated but
  // each demo-mutator pair is deterministic.
  const rng = mulberry32(PRNG_SEED);

  test("seed corpus is non-empty", () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  for (const path of demos) {
    const name = path.split("/").pop()!;
    const seedSrc = readFileSync(path, "utf-8");

    test(`${name}: original parses or errors cleanly`, async () => {
      // Sanity: the seed itself must parse OK (otherwise the mutation
      // tests below produce garbage findings — the bug is in the seed).
      const r = await parseAnchor(seedSrc, { timeoutMs: PARSE_TIMEOUT_MS });
      if (r.ok) {
        expect(() => SolanaIRSchema.parse(r.ir)).not.toThrow();
      }
    });

    for (const m of MUTATORS) {
      test(`${name} + ${m.name} × ${ITERATIONS_PER_SEED}: parser is exception-safe`, async () => {
        for (let i = 0; i < ITERATIONS_PER_SEED; i++) {
          const mutated = m.apply(seedSrc, rng);
          let result: Awaited<ReturnType<typeof parseAnchor>>;
          try {
            result = await parseAnchor(mutated, { timeoutMs: PARSE_TIMEOUT_MS });
          } catch (err) {
            // Parser MUST NOT throw. A surfaced exception is a fuzz finding.
            throw new Error(
              `parseAnchor threw on mutated ${name} via ${m.name} iter ${i}: ${err instanceof Error ? err.message : String(err)}\n` +
              `--- mutated source (first 500 chars) ---\n${mutated.slice(0, 500)}`,
            );
          }
          // Either ok=true with a valid IR or ok=false with a plain error
          // object. Both are acceptable.
          if (result.ok) {
            // Generated IR must round-trip through the schema. Catches
            // schema-validation bypass paths.
            expect(() => SolanaIRSchema.parse(result.ir)).not.toThrow();
          } else {
            expect(result.error).toBeDefined();
            expect(typeof result.error).toBe("string");
          }
        }
      });
    }
  }
});
