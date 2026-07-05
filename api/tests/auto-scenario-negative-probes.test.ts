/**
 * #14 — negative/expectFail probe generation in the auto-scenario synthesiser.
 *
 * Happy-path-only scenarios can't catch a DROPPED access-control guard: a
 * transpile that silently removed `has_one = owner` still passes every valid
 * call. With `{ negativeProbes: true }` the synthesiser inserts an `expectFail`
 * step before each guarded instruction that re-invokes it with an unauthorized
 * signer. Both targets must revert; a transpile that dropped the check accepts
 * on Anvil while Anchor rejects → the revert-parity comparator (#13) flags
 * DIVERGED. These tests cover the SYNTHESIS shape (no toolchain / no build).
 */
import { describe, test, expect } from "bun:test";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { ScenarioSchema, lintScenario } from "../src/ir/scenario.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function parseDemo(name: string) {
  const src = readFileSync(join(import.meta.dir, "..", "src", "demo-programs", name), "utf-8");
  const r = await parseAnchor(src);
  if (!r.ok) throw new Error(`parse ${name}: ${r.error}`);
  return r.ir;
}

const ATTACKER = "$signer:__unauthorized";

describe("auto-scenario negative probes (#14)", () => {
  test("default (no opts) stays happy-path-only — backwards compatible", async () => {
    const ir = await parseDemo("counter.rs");
    const r = synthesizeAutoScenario(ir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No expectFail steps, no unauthorized signer — identical to pre-#14 output.
    expect(r.scenario.steps.every((s) => !s.expectFail)).toBe(true);
    expect(r.scenario.signers.some((s) => s.name === "__unauthorized")).toBe(false);
    expect(r.scenario.steps.length).toBe(4);
  });

  test("negativeProbes: has_one guards get an unauthorized-caller probe before each happy step", async () => {
    const ir = await parseDemo("counter.rs");
    const r = synthesizeAutoScenario(ir, { negativeProbes: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // counter's increment/decrement/reset share an Update ctx with
    // `has_one = authority`; initialize (init) is skipped. → 3 probes.
    const probes = r.scenario.steps.filter((s) => s.expectFail);
    expect(probes.length).toBe(3);
    expect(probes.map((p) => p.ix).sort()).toEqual(["decrement", "increment", "reset"]);

    // Each probe swaps the authority slot to the unauthorized signer, keeps the
    // rest of the happy accounts, and is labeled.
    for (const p of probes) {
      expect(p.accounts).toContain(ATTACKER);
      expect(p.label).toContain("has_one");
    }

    // The unauthorized signer is declared so the runner can fund + sign it.
    expect(r.scenario.signers.some((s) => s.name === "__unauthorized")).toBe(true);

    // Each probe sits IMMEDIATELY before its happy twin (same ix, not expectFail)
    // so the guarded account is set up but not yet consumed.
    const steps = r.scenario.steps;
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i]!.expectFail) continue;
      const next = steps[i + 1];
      expect(next).toBeDefined();
      expect(next!.ix).toBe(steps[i]!.ix);
      expect(next!.expectFail).toBe(false);
    }

    // Still schema-valid + lint-clean with the probes interleaved.
    const parsed = ScenarioSchema.safeParse(r.scenario);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(lintScenario(parsed.data).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("has-one demo: single probe before bump_value with unauthorized owner", async () => {
    const ir = await parseDemo("has-one.rs");
    const r = synthesizeAutoScenario(ir, { negativeProbes: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const probes = r.scenario.steps.filter((s) => s.expectFail);
    expect(probes.length).toBe(1);
    expect(probes[0]!.ix).toBe("bump_value");
    expect(probes[0]!.accounts).toContain(ATTACKER);
    // The guarded `safe` account is preserved (only the owner slot is swapped).
    expect(probes[0]!.accounts).toContain("$keypair:safe");
  });

  test("init-only program gets no probe (re-invoking init reverts for the wrong reason)", async () => {
    // bumps-access is a single init instruction — no non-init has_one target,
    // so even with probes on there is nothing safe to probe.
    const ir = await parseDemo("bumps-access.rs");
    const r = synthesizeAutoScenario(ir, { negativeProbes: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.steps.some((s) => s.expectFail)).toBe(false);
    expect(r.scenario.signers.some((s) => s.name === "__unauthorized")).toBe(false);
  });
});
