/**
 * P2 — surface unknown constraint keys via constraint_key_unrecognized.
 *
 * Pre-fix: parseConstraints silently dropped any key not in
 * KNOWN_CONSTRAINT_KEYS. If Anchor adds a new constraint attribute (e.g.
 * `lazy`, `delegate`, future T22-extension shortcuts) it vanished from
 * the IR with no signal — emit looked identical, semantics changed.
 *
 * The fix wires a ParserWarningCollector through parseConstraints and
 * fires `constraint_key_unrecognized` for any key outside both the
 * known map and the explicit intentional-skip set (payer/space/realloc::*).
 */
import { describe, test, expect } from "bun:test";
import { parseConstraints } from "../src/parser/constraint-parser.ts";
import { createWarningCollector } from "../src/parser/warning-collector.ts";

describe("P2 — constraint_key_unrecognized", () => {
  test("recognized keys produce no warning", () => {
    const collector = createWarningCollector();
    parseConstraints("mut, has_one = authority, seeds = [b\"vault\"]", {
      collector,
      structName: "MyAccounts",
      fieldName: "vault",
    });
    expect(collector.drain().length).toBe(0);
  });

  test("intentional-skip keys produce no warning", () => {
    const collector = createWarningCollector();
    parseConstraints("init, payer = signer, space = 8 + 32, rent_exempt = enforce", {
      collector,
      structName: "MyAccounts",
      fieldName: "vault",
    });
    const unrecognized = collector
      .drain()
      .filter((w) => w.code === "constraint_key_unrecognized");
    expect(unrecognized.length).toBe(0);
  });

  test("unknown key fires constraint_key_unrecognized", () => {
    const collector = createWarningCollector();
    parseConstraints("mut, lazy_init = true", {
      collector,
      structName: "MyAccounts",
      fieldName: "vault",
    });
    const unrecognized = collector
      .drain()
      .filter((w) => w.code === "constraint_key_unrecognized");
    expect(unrecognized.length).toBe(1);
    expect(unrecognized[0]!.message).toContain("lazy_init");
    expect(unrecognized[0]!.message).toContain("MyAccounts.vault");
  });

  test("multiple unknown keys each fire", () => {
    const collector = createWarningCollector();
    parseConstraints("frobulate = 1, delegate = signer", {
      collector,
      structName: "Foo",
      fieldName: "bar",
    });
    const unrecognized = collector
      .drain()
      .filter((w) => w.code === "constraint_key_unrecognized");
    expect(unrecognized.length).toBe(2);
  });

  test("empty key (trailing comma artifact) does not fire", () => {
    const collector = createWarningCollector();
    parseConstraints("mut, , has_one = a", {
      collector,
      structName: "S",
      fieldName: "f",
    });
    const unrecognized = collector
      .drain()
      .filter((w) => w.code === "constraint_key_unrecognized");
    expect(unrecognized.length).toBe(0);
  });

  test("no collector → no warning (back-compat for unit-test callers)", () => {
    // Old call sites that pass only attrBody continue to work.
    const out = parseConstraints("mut, unknown_thing = 1");
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("mut");
  });

  test("missing context falls back to <unknown field> in the message", () => {
    const collector = createWarningCollector();
    parseConstraints("unknown_thing = 1", { collector });
    const w = collector
      .drain()
      .find((w) => w.code === "constraint_key_unrecognized");
    expect(w?.message).toContain("<unknown field>");
  });
});
