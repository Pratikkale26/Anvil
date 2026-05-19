/**
 * Anchor version detection from source / inline Cargo.toml fragments
 * (task #27 P4.1). Three shapes supported, all flow into ir.metadata.sourceVersion.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

async function ver(prefix: string): Promise<string | undefined> {
  const src = `${prefix}
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p { use super::*; pub fn r(_c: Context<R>) -> Result<()> { Ok(()) } }
#[derive(Accounts)] pub struct R<'info> { #[account(mut)] pub p: Signer<'info> }`;
  const r = await parseAnchor(src);
  if (!r.ok) return undefined;
  return r.ir.metadata.sourceVersion;
}

describe("detectAnchorVersion: source / Cargo.toml shape coverage (task #27)", () => {
  test("terse form: anchor-lang = \"0.31\"", async () => {
    expect(await ver(`// anchor-lang = "0.31"`)).toBe("0.31");
  });

  test("dotted patch: anchor-lang = \"0.31.1\"", async () => {
    expect(await ver(`// anchor-lang = "0.31.1"`)).toBe("0.31.1");
  });

  test("exact pin: anchor-lang = \"=0.31.0\" (leading = stripped)", async () => {
    expect(await ver(`// anchor-lang = "=0.31.0"`)).toBe("0.31.0");
  });

  test("extended form: anchor-lang = { version = \"0.32.0\", features = [\"foo\"] }", async () => {
    expect(await ver(`// anchor-lang = { version = "0.32.0", features = ["foo"] }`)).toBe("0.32.0");
  });

  test("anchor_lang (underscore) also matched", async () => {
    expect(await ver(`// anchor_lang = "0.30.1"`)).toBe("0.30.1");
  });

  test("no anchor-lang mention → fallback 0.30.0", async () => {
    expect(await ver(``)).toBe("0.30.0");
  });
});
