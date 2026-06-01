/**
 * #6 — exhaustiveness guard: every BodyStatement IR kind must be ACCOUNTED FOR
 * in the emitter. The kinds are enumerated from the schema (the zod
 * discriminated union — single source of truth), NOT a hardcoded list, so the
 * guard can't silently drift behind the schema.
 *
 * Why it matters: the emit pipeline has a pass_through catch-all. A new
 * BodyStatement kind added to the schema without an emit handler silently falls
 * to pass_through (carried verbatim / regex-mangled) instead of being typed-
 * emitted — exactly the kind of silent gap the production-readiness review
 * flagged. This test fails the moment a schema kind has no emit reference and
 * isn't explicitly allowlisted, forcing a deliberate decision.
 *
 * Limitation (documented, not theater): "referenced in emit source" is a proxy
 * for "handled" — it catches the real failure mode (a brand-new kind with zero
 * emit wiring, which appears nowhere) but would not catch a kind referenced
 * only in a comment. Strengthening to dispatch-context-only is the H7-walker
 * arc's job; this is the cheap, robust guard.
 */
import { describe, test, expect } from "bun:test";
import { BodyStatementSchema } from "../src/ir/schema.ts";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const API = join(import.meta.dir, "..");

// Kinds intentionally given NO dedicated emit reference. Empty today — every one
// of the 78 kinds is wired. Adding a kind here is an EXPLICIT, reviewed decision
// that it's handled generically or passes through by design.
const INTENTIONAL_NO_HANDLER: ReadonlyArray<string> = [];

function emitSourceText(): string {
  const dirs = ["src/emitter", "src/emitter/body-emitter", "src/emitter/ast-visitor"];
  let src = "";
  for (const d of dirs) {
    for (const f of readdirSync(join(API, d))) {
      if (f.endsWith(".ts")) src += readFileSync(join(API, d, f), "utf8");
    }
  }
  return src;
}

describe("#6 — BodyStatement emit exhaustiveness (silent-IR-gap guard)", () => {
  test("every schema kind is referenced in the emitter (or explicitly allowlisted)", () => {
    const kinds: string[] = (BodyStatementSchema as unknown as { options: Array<{ shape: { kind: { value: string } } }> })
      .options.map((o) => o.shape.kind.value);
    // Sanity: schema introspection actually produced the union (guards against
    // a zod API change silently yielding []).
    expect(kinds.length).toBeGreaterThan(70);

    const src = emitSourceText();
    const unreferenced = kinds.filter(
      (k) => !src.includes(`"${k}"`) && !INTENTIONAL_NO_HANDLER.includes(k),
    );
    // A non-empty list means a BodyStatement kind has NO emit wiring and isn't
    // allowlisted → it silently falls to pass_through. Wire a handler, or add it
    // to INTENTIONAL_NO_HANDLER with a reason.
    expect(unreferenced).toEqual([]);

    // Allowlist hygiene: no stale entries (every allowlisted kind still exists).
    for (const k of INTENTIONAL_NO_HANDLER) expect(kinds).toContain(k);
  });
});
