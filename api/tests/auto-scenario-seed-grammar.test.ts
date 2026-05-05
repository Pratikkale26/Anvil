/**
 * C8 — auto-scenario seed grammar test sweep.
 *
 * Pre-C8 the seed grammar was extended ad-hoc: each new shape that real
 * programs hit triggered a regex tweak with no coverage of the related
 * shapes. Per the post-N1 review, fixing one shape without a sweep was
 * how regressions slipped in. This file pins every supported seed
 * shape + the explicit blockers, so future grammar changes have a
 * regression-guard.
 *
 * Each test builds a minimal IR with ONE PDA carrying a target seed,
 * runs synthesizeAutoScenario, and asserts what the resulting scenario
 * looks like (or what blocker fires when the shape isn't supported).
 */
import { describe, test, expect } from "bun:test";
import { synthesizeAutoScenario } from "../src/cli/auto-scenario.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

function makeIrWithSeeds(rawSeeds: string[], extraArgs: SolanaIR["instructions"][0]["args"] = []): SolanaIR {
  return {
    name: "p",
    instructions: [{
      name: "init",
      accounts: [
        { name: "user", accountType: "Signer", isSigner: true, isMut: true, isInit: false, isOptional: false, isPda: false, pdaSeeds: [], constraints: [] },
        { name: "state", accountType: "State", isSigner: false, isMut: true, isInit: true, isOptional: false, isPda: true, pdaSeeds: rawSeeds, constraints: [{ kind: "init" }] },
      ],
      args: extraArgs,
      body: [],
      bodyLocs: [],
    }],
    accounts: [{ name: "State", fields: [{ name: "n", type: "u64" }] as never }],
    types: [],
    constants: [],
    errors: [],
    helperFns: [],
    events: [],
    imports: [],
    userTraitImpls: [],
    warnings: [],
    metadata: { sourceFramework: "anchor", anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
  };
}

function expectAccept(rawSeeds: string[], extraArgs: SolanaIR["instructions"][0]["args"] = []) {
  const ir = makeIrWithSeeds(rawSeeds, extraArgs);
  const r = synthesizeAutoScenario(ir);
  if (!r.ok) {
    throw new Error(
      `expected synthesis OK for ${JSON.stringify(rawSeeds)} but got blockers: ${JSON.stringify(r.blockers)}`,
    );
  }
  return r.scenario.pdas[0]!.seeds;
}

function expectBlock(rawSeeds: string[], reasonSubstring: string, extraArgs: SolanaIR["instructions"][0]["args"] = []) {
  const ir = makeIrWithSeeds(rawSeeds, extraArgs);
  const r = synthesizeAutoScenario(ir);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  const found = r.blockers.find((b) => b.message.includes(reasonSubstring));
  if (!found) {
    throw new Error(
      `expected blocker containing '${reasonSubstring}', got: ${JSON.stringify(r.blockers)}`,
    );
  }
}

describe("auto-scenario seed grammar — accepted shapes", () => {
  test("b\"literal\" preserves exactly", () => {
    expect(expectAccept(['b"counter"'])).toEqual(['b"counter"']);
  });

  test("bare string literal wraps as b\"...\"", () => {
    expect(expectAccept(['"counter"'])).toEqual(['b"counter"']);
  });

  test("bare lowercase identifier (single token) wraps as b\"<ident>\"", () => {
    expect(expectAccept(["counter"])).toEqual(['b"counter"']);
  });

  test("ALL_CAPS const ident strips _SEED / _PREFIX / _TAG suffixes", () => {
    expect(expectAccept(["VAULT_SEED"])).toEqual(['b"vault"']);
    expect(expectAccept(["ESCROW_PREFIX"])).toEqual(['b"escrow"']);
    expect(expectAccept(["MARKER_TAG"])).toEqual(['b"marker"']);
    expect(expectAccept(["SOMETHING_NAMESPACE"])).toEqual(['b"something"']);
  });

  test("ALL_CAPS without recognised suffix falls back to lowercase", () => {
    expect(expectAccept(["MAGIC_VALUE"])).toEqual(['b"magic_value"']);
  });

  test("$signer:user.pubkey form (signer.key().as_ref())", () => {
    expect(expectAccept(["user.key().as_ref()"])).toEqual(["$signer:user.pubkey"]);
  });

  test("signer.key.as_ref() variant (no parens after key)", () => {
    expect(expectAccept(["user.key.as_ref()"])).toEqual(["$signer:user.pubkey"]);
  });

  test(".bump suffix is dropped (find_program_address derives it)", () => {
    // .bump alone gets skipped — the runtime walks find_program_address
    // and supplies the canonical bump byte. Test by combining with a
    // literal so we can verify the .bump is silently skipped not
    // included.
    expect(expectAccept(['b"counter"', "state.bump"])).toEqual(['b"counter"']);
  });
});

describe("auto-scenario seed grammar — explicit blockers", () => {
  test("state-derived seed `<account>.<field>.as_ref()` blocks with state-derived hint", () => {
    expectBlock(["counter.id.as_ref()"], "state-derived");
  });

  test("state-derived chained `<account>.<field>.to_le_bytes().as_ref()` blocks (anchor-escrow-2025 shape)", () => {
    expectBlock(["counter.id.to_le_bytes().as_ref()"], "state-derived");
  });

  test("arg-derived `<arg>.as_ref()` blocks with arg-derived hint", () => {
    // Add the arg to the IR's args list so the heuristic recognises it
    // as an arg ref, not a misnamed signer.
    expectBlock(
      ["beneficiary.as_ref()"],
      "arg-derived",
      [{ name: "beneficiary", type: "Pubkey" as const }],
    );
  });

  test("cross-account `<other>.key().as_ref()` against a non-PDA blocks (likely SPL Mint)", () => {
    expectBlock(
      ["token_mint_a.key().as_ref()"],
      "externally-supplied",
    );
  });

  test("unsupported shape blocks with the supported-list hint", () => {
    expectBlock(["some.weird.expression(42)"], "unsupported seed expression");
  });
});

describe("auto-scenario seed grammar — chained-call shape (C8 extension)", () => {
  // The chained `<X>.to_le_bytes().as_ref()` form for ARGUMENTS
  // (anchor-escrow-2025's `id.to_le_bytes().as_ref()`) needs to block
  // the same way `<arg>.as_ref()` does — both are arg-derived and
  // can't be auto-resolved without the runtime resolver.
  test("arg-derived chained `<arg>.to_le_bytes().as_ref()` blocks (NOT silently fall through)", () => {
    expectBlock(
      ["id.to_le_bytes().as_ref()"],
      "arg-derived",
      [{ name: "id", type: "u64" as const }],
    );
  });
});
