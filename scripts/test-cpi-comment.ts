#!/usr/bin/env bun
// Verify a trailing // comment inside a CPI arg list doesn't consume the
// emitted )?;. Reproduces the real-world failure from transfer-tokens:
//   spl_token_mint_to(..., amount, // Mint tokens)?;
// The // would swallow )?; and cause "unclosed delimiter" at cargo build.
import { cleanInlineExpr } from "../api/src/emitter/emitter-utils.ts";
import { cleanAmountExpr } from "../api/src/parser/ast-helpers.ts";

const cases = [
  {
    name: "cleanInlineExpr — trailing // on arg",
    input: "amount * 10u64.pow(decimals as u32) // Mint tokens",
    fn: cleanInlineExpr,
  },
  {
    name: "cleanAmountExpr — trailing // on arg",
    input: "amount * 10u64.pow(ctx.accounts.mint.decimals as u32) // Mint tokens",
    fn: cleanAmountExpr,
  },
  {
    name: "cleanInlineExpr — block comment middle",
    input: "a /* inner */ + b",
    fn: cleanInlineExpr,
  },
];

let ok = true;
for (const c of cases) {
  const out = c.fn(c.input);
  const hasLineComment = /\/\//.test(out);
  const hasBlockComment = /\/\*|\*\//.test(out);
  if (hasLineComment || hasBlockComment) {
    console.error(`FAIL  ${c.name}`);
    console.error(`  in:  ${c.input}`);
    console.error(`  out: ${out}`);
    ok = false;
  } else {
    console.log(`PASS  ${c.name}  →  ${out}`);
  }
}
if (!ok) process.exit(1);
