/**
 * Unit tests for the routerDiscriminator helper introduced in commit
 * 824e50b. Locks the hex → byte-array round-trip and the fallback
 * to the auto-computed sha256("global:<name>") shape.
 */
import { describe, test, expect } from "bun:test";
import { routerDiscriminator, instrDiscriminator } from "../src/emitter/emitter-utils.ts";

describe("routerDiscriminator", () => {
  test("override hex → formatted byte array", () => {
    expect(routerDiscriminator({ name: "foo", discriminator: "0102030405060708" }))
      .toBe("[1, 2, 3, 4, 5, 6, 7, 8]");
  });

  test("override with uppercase hex still works", () => {
    expect(routerDiscriminator({ name: "foo", discriminator: "AABBCCDDEEFF0011" }))
      .toBe("[170, 187, 204, 221, 238, 255, 0, 17]");
  });

  test("undefined discriminator → computed sha256 fallback", () => {
    const r = routerDiscriminator({ name: "initialize" });
    expect(r).toBe(instrDiscriminator("initialize"));
    expect(r).toMatch(/^\[\d+, \d+, \d+, \d+, \d+, \d+, \d+, \d+\]$/);
  });

  test("malformed hex (not 16 chars) → falls back to computed", () => {
    const r = routerDiscriminator({ name: "initialize", discriminator: "abcdef" });
    expect(r).toBe(instrDiscriminator("initialize"));
  });

  test("malformed hex (non-hex chars) → falls back to computed", () => {
    const r = routerDiscriminator({ name: "initialize", discriminator: "01020304zzzzzzzz" });
    expect(r).toBe(instrDiscriminator("initialize"));
  });

  test("empty string → falls back to computed", () => {
    const r = routerDiscriminator({ name: "initialize", discriminator: "" });
    expect(r).toBe(instrDiscriminator("initialize"));
  });

  test("computed discriminators differ per instruction name", () => {
    const a = instrDiscriminator("initialize");
    const b = instrDiscriminator("transfer");
    expect(a).not.toBe(b);
  });
});
