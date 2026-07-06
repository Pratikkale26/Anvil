/**
 * Production-gate regression guard for ALL demo programs.
 *
 * The differential-* and cargo-compile-* suites call emitPinocchioFull /
 * buildProjectScaffold DIRECTLY — they never run the gate `/emit` and
 * `anvil compile --strict` use to refuse a write. That gate is:
 *     validateEmitterOutput(severity:error)  ∪  auditPassthrough(severity:error)
 * (validateEmitterOutput already covers [portability], the unsafe-marker scan,
 * and the parser-code errors; auditPassthrough is the separate pre-emit pass.)
 *
 * Because nothing asserted the gate over the demos, two whole classes shipped
 * silently: the stale portability blocker (mpl_core #48 / switchboard_on_demand
 * #47) and the auditPassthrough false-refusals (create_account / token .amount).
 * This scans every demo on both targets so a future regression of that class
 * trips HERE instead of in production.
 *
 * KNOWN_GATED: demos that legitimately refuse today. Each is either a genuinely
 * unsupported shape or a B2-guarded read whose lowering is unproven — NOT a
 * false positive. They are asserted to STILL refuse, so if a real fix later
 * makes one clean, this test fails and reminds us to drop it from the list
 * (rather than silently masking a fix). Do NOT add a demo here to "make the
 * test pass" — only after confirming the refusal is correct.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { auditPassthrough } from "../src/emitter/passthrough-audit.ts";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");
const demos = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".rs")).sort();

// Demos that legitimately refuse the strict gate (genuine unsupported shape or
// B2-guarded unproven read). Keyed by file stem.
const KNOWN_GATED: Record<string, string> = {
  "compression-append": "declare_program! CPI to spl_account_compression — transpiles ONLY with the crate IDL (supplied by differential-compression-append.test.ts, byte-equal green); parsed here without the IDL, the #44 cnft_compression_unsupported refuse correctly fires",
  "bubblegum-create-tree": "declare_program! CPI to mpl_bubblegum — transpiles ONLY with the crate IDL (supplied by differential-bubblegum-create-tree.test.ts, byte-equal green); parsed here without the IDL, the #44 cnft_compression_unsupported refuse correctly fires",
  "control-flow": "for/while/match control-flow IR is corpus-absent/deferred — ctx.accounts inside a for-loop pass_through",
  "cpi-memo": "let-bound memo CpiContext not recognized into a typed cpi_memo kind (unhandled shape)",
  "marketplace": "user-struct field read `listing.price` — B2 silent-read guard, lowering unproven",
  "perp-funding": "ctx.bumps + control-flow — bump must be passed explicitly, genuinely unsupported",
  "vault": "`.lamports()` accessor read — B2 guard, lowering genuinely unproven",
  "vesting": "user-struct field read `.vault_bump` — B2 silent-read guard, lowering unproven",
};

const productionGateErrors = (ir: Parameters<typeof emitPinocchioFull>[0]) => {
  const msgs: string[] = [];
  for (const emit of [emitPinocchioFull, emitNativeFull] as const) {
    msgs.push(...validateEmitterOutput(ir, emit(ir)).filter((i) => i.severity === "error").map((i) => i.message));
  }
  msgs.push(...auditPassthrough(ir).filter((i) => i.severity === "error").map((i) => i.message));
  return msgs;
};

describe("demo programs vs the production strict gate (validator ∪ auditPassthrough)", () => {
  test(`scans all ${demos.length} demo programs`, () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  for (const file of demos) {
    const stem = file.replace(/\.rs$/, "");
    test(file, async () => {
      const r = await parseAnchor(readFileSync(join(DEMO_DIR, file), "utf-8"));
      expect(r.ok, `demo ${file} failed to parse: ${r.ok ? "" : r.error}`).toBe(true);
      if (!r.ok) return;
      const errors = productionGateErrors(r.ir);
      if (stem in KNOWN_GATED) {
        // Documented legitimate refusal — assert it STILL refuses so a future
        // real fix forces an update here instead of silently passing.
        expect(errors.length, `${file} no longer refuses — drop it from KNOWN_GATED (${KNOWN_GATED[stem]})`).toBeGreaterThan(0);
      } else {
        expect(errors, `${file} tripped the production gate — a regression of the portability/auditPassthrough class`).toEqual([]);
      }
    });
  }
});
