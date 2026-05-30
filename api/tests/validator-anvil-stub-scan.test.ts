/**
 * Systemic silent-stub gate (the root cause behind carried-helper / AccountLoader
 * / __anvil_unported_self__): the output-validator scans `// ⚠️ Anvil` COMMENTS
 * but not `unimplemented!("anvil: …")` STRINGS, so any Anvil-emitted stub without
 * a separate comment marker was SILENT — compiles via the never-type, panics at
 * runtime, validator blind.
 *
 * checkUnsafeMarkers now also flags `unimplemented!("[Aa]nvil: …")` as an unsafe
 * non-functional error, UNLESS a `⚠️ Anvil` marker already classifies it within
 * the preceding lines (so a marked stub — e.g. the AccountLoader impl whose
 * marker sits ~14 lines above load_init — yields exactly one issue, from the
 * marker path, not a marker+string double).
 */
import { describe, test, expect } from "bun:test";
import { checkUnsafeMarkers } from "../src/emitter/output-validator.ts";

describe("validator scans Anvil unimplemented!() stubs (systemic silent-stub gate)", () => {
  test("UNMARKED Anvil stub → unsafe ERROR (the silent case, now loud)", () => {
    const content = [
      "pub fn handler() -> u64 {",
      `    let __anvil_unported_self__ = unimplemented!("anvil: lost-self placeholder — manual port");`,
      "    0",
      "}",
    ].join("\n");
    const issues = checkUnsafeMarkers(content, "instructions/x.rs");
    expect(issues.some((i) => i.severity === "error" && /non-functional/i.test(i.message))).toBe(true);
  });

  test("MARKED stub (multi-method impl) → exactly ONE issue (dedup, no marker+string double)", () => {
    const content = [
      "// ⚠️ Anvil: SomeLoader::a/b — zero-copy not yet supported (non-functional stub).",
      "impl SomeLoader {",
      "    pub fn a(&self) -> u64 {",
      `        unimplemented!("anvil: a stub")`,
      "    }",
      "    pub fn b(&self) -> u64 {",
      `        unimplemented!("anvil: b stub")`,
      "    }",
      "}",
    ].join("\n");
    const issues = checkUnsafeMarkers(content, "lib.rs");
    // The marker classifies it once (error, via "not yet supported"); the
    // string-check skips both unimplemented!() lines (marker within window).
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("error");
  });

  test("bare unimplemented!() in user code (no anvil: prefix) is NOT flagged", () => {
    const content = `pub fn user_todo() -> u64 {\n    unimplemented!()\n}`;
    expect(checkUnsafeMarkers(content, "x.rs").length).toBe(0);
  });
});
