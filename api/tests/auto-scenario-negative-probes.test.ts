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
    // `has_one = authority` (+ a signing authority); initialize (init) is
    // skipped. Each mutation gets TWO probes: a has_one probe (wrong signer)
    // and a missing-signer probe (right signer, no signature). → 6 probes.
    const probes = r.scenario.steps.filter((s) => s.expectFail);
    expect(probes.length).toBe(6);

    const hasOneProbes = probes.filter((p) => p.label?.includes("has_one"));
    const signerProbes = probes.filter((p) => p.label?.includes("missing signature"));
    expect(hasOneProbes.length).toBe(3);
    expect(signerProbes.length).toBe(3);

    // has_one probe: wrong-but-signing authority.
    for (const p of hasOneProbes) expect(p.accounts).toContain(ATTACKER);
    // missing-signer probe: the authority is present but passed via $unsigned:.
    for (const p of signerProbes) {
      expect(p.accounts.some((a) => a.startsWith("$unsigned:authority"))).toBe(true);
      expect(p.accounts).not.toContain("$signer:authority");
    }

    // Both probe fixtures are declared as signers so the runner can fund them.
    expect(r.scenario.signers.some((s) => s.name === "__unauthorized")).toBe(true);
    expect(r.scenario.signers.some((s) => s.name === "__probe_payer")).toBe(true);
    // The dedicated fee payer MUST be first (fee-payer fallback lands on it).
    expect(r.scenario.signers[0]!.name).toBe("__probe_payer");

    // Probes for an instruction are contiguous and sit right before its happy
    // twin: each probe is followed by a step of the SAME ix (another probe or
    // the happy step), and every probed ix has a non-expectFail happy step.
    const steps = r.scenario.steps;
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i]!.expectFail) continue;
      const next = steps[i + 1];
      expect(next).toBeDefined();
      expect(next!.ix).toBe(steps[i]!.ix);
    }
    for (const ix of new Set(probes.map((p) => p.ix))) {
      expect(steps.some((s) => s.ix === ix && !s.expectFail)).toBe(true);
    }

    // Still schema-valid + lint-clean with the probes interleaved.
    const parsed = ScenarioSchema.safeParse(r.scenario);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(lintScenario(parsed.data).filter((i) => i.severity === "error")).toEqual([]);
  });

  test("has-one demo: has_one + missing-signer probes before bump_value", async () => {
    const ir = await parseDemo("has-one.rs");
    const r = synthesizeAutoScenario(ir, { negativeProbes: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const probes = r.scenario.steps.filter((s) => s.expectFail);
    expect(probes.length).toBe(2);
    for (const p of probes) expect(p.ix).toBe("bump_value");

    const hasOne = probes.find((p) => p.label?.includes("has_one"))!;
    const missingSig = probes.find((p) => p.label?.includes("missing signature"))!;
    expect(hasOne).toBeDefined();
    expect(missingSig).toBeDefined();
    // has_one: swap owner to the unauthorized (still-signing) caller.
    expect(hasOne.accounts).toContain(ATTACKER);
    // missing-signer: the real owner, passed unsigned.
    expect(missingSig.accounts).toContain("$unsigned:owner");
    // Both keep the guarded `safe` account (only the owner slot changes).
    expect(hasOne.accounts).toContain("$keypair:safe");
    expect(missingSig.accounts).toContain("$keypair:safe");
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
