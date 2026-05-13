import { describe, test, expect, beforeAll } from "bun:test";
import { rewriteSiblingCpiCalls } from "../src/emitter/emitter-base.ts";
import { getParser } from "../src/parser/ts-init.ts";

beforeAll(async () => {
  await getParser();
});

const BANNER = "⚠️ Anvil TODO: sibling-Anchor-program CPI";

describe("rewriteSiblingCpiCalls — sibling-Anchor-program CPI commentout", () => {
  test("comments out sibling CPI call as expression statement", () => {
    const body = `fn handler() -> Result<(), ProgramError> {
    squads_mpl::cpi::create_transaction(ctx, args)?;
    Ok(())
}`;
    const out = rewriteSiblingCpiCalls(body);
    expect(out).toContain(BANNER);
    expect(out).toContain("// squads_mpl::cpi::create_transaction(ctx, args)?;");
  });

  test("comments out sibling CPI bound as a let_declaration", () => {
    const body = `fn handler() -> Result<(), ProgramError> {
    let ret = squads_mpl::cpi::do_thing(ctx, args)?;
    Ok(())
}`;
    const out = rewriteSiblingCpiCalls(body);
    expect(out).toContain(BANNER);
    expect(out).toContain("// let ret = squads_mpl::cpi::do_thing(ctx, args)?;");
  });

  test("preserves known-external CPI namespaces", () => {
    for (const ns of ["anchor_lang", "anchor_spl", "spl_token", "mpl_token_metadata", "pyth_sdk", "switchboard_v2", "solana_program"]) {
      const body = `fn h() { ${ns}::cpi::call(ctx, args)?; }`;
      expect(rewriteSiblingCpiCalls(body)).toBe(body);
    }
  });

  test("no change when there is no sibling CPI call", () => {
    const body = `fn h() -> Result<(), ProgramError> {
    let x = some_helper(1, 2);
    Ok(())
}`;
    expect(rewriteSiblingCpiCalls(body)).toBe(body);
  });

  test("comments only the enclosing statement, not the whole block", () => {
    const body = `fn h() -> Result<(), ProgramError> {
    let x = 1;
    squads_mpl::cpi::call(ctx, args)?;
    let y = 2;
    Ok(())
}`;
    const out = rewriteSiblingCpiCalls(body);
    expect(out).toContain("let x = 1;");
    expect(out).toContain("let y = 2;");
    expect(out).toContain("// squads_mpl::cpi::call(ctx, args)?;");
  });

  test("merges duplicate ranges when one statement holds multiple sibling calls", () => {
    const body = `fn h() {
    let x = (squads_mpl::cpi::a(ctx, x)?, squads_mpl::cpi::b(ctx, y)?);
}`;
    const out = rewriteSiblingCpiCalls(body);
    // Only one TODO banner — both calls share an enclosing let_declaration
    const banners = out.match(/⚠️ Anvil TODO: sibling-Anchor-program CPI/g) ?? [];
    expect(banners.length).toBe(1);
  });

  test("regex fallback handles malformed input (parse errors)", () => {
    // Truncated body — tree-sitter parses but with ERROR nodes; AST path
    // bails and the regex fallback still finds + comments the call.
    const body = `fn h() { squads_mpl::cpi::call(ctx, args)?; unclosed_block`;
    const out = rewriteSiblingCpiCalls(body);
    expect(out).toContain(BANNER);
  });

  test("tail-position sibling CPI in fn body is commented", () => {
    // Block-tail expression (no trailing `;`) — the legacy regex caught it
    // by walking back to `{`. AST version must catch it via the block-child
    // fallback in enclosingStatement.
    const body = `fn h() -> Result<(), ProgramError> {
    squads_mpl::cpi::y(ctx, args)?
}`;
    const out = rewriteSiblingCpiCalls(body);
    expect(out).toContain(BANNER);
    expect(out).toContain("// squads_mpl::cpi::y(ctx, args)?");
  });

  test("AST path skips matches in string literals", () => {
    // Regex would match the string content; AST won't.
    const body = `fn h() -> &'static str {
    "squads_mpl::cpi::call(ctx, args)?;"
}`;
    expect(rewriteSiblingCpiCalls(body)).toBe(body);
  });
});
