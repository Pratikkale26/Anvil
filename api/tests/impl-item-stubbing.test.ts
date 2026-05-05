import { describe, test, expect } from "bun:test";
import { stubAnchorOnlyImplItem } from "../src/emitter/emitter-base.ts";

describe("stubAnchorOnlyImplItem — Anchor-pattern impl method stubbing", () => {
  test("stubs body containing CpiContext::new", () => {
    const raw = `pub fn transfer_fee(&self) -> Result<()> {
        CpiContext::new(prog, accs);
        Ok(())
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    expect(out).toContain("⚠️ Anvil TODO");
    expect(out).toContain("Err(ProgramError::Custom(0))");
    expect(out).toContain("pub fn transfer_fee(&self) -> Result<()>");
    expect(out).not.toContain("CpiContext::new(prog");
  });

  test("stubs body containing ctx.accounts", () => {
    const raw = `pub fn run(ctx: Context<Self>) -> Result<()> {
        let x = ctx.accounts.foo;
        Ok(())
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    expect(out).toContain("⚠️ Anvil TODO");
    expect(out).not.toContain("ctx.accounts.foo");
  });

  test("stubs body with require! macro", () => {
    const raw = `pub fn check(&self) -> Result<()> {
        require!(self.x > 0, MyError::Bad);
        Ok(())
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    expect(out).toContain("⚠️ Anvil TODO");
    // The original `require!(self.x > 0, …)` body should be gone (stub
    // comment may mention "require!" as part of the explanation).
    expect(out).not.toContain("require!(self.x > 0");
  });

  test("stubs body with require_keys_eq! / require_keys_neq!", () => {
    const raw = `pub fn check(&self) -> Result<()> {
        require_keys_eq!(self.a, self.b, MyError::Bad);
        require_keys_neq!(self.c, Pubkey::default(), MyError::Bad);
        Ok(())
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    expect(out).toContain("⚠️ Anvil TODO");
    expect(out).not.toContain("require_keys_eq!(self.a");
    expect(out).not.toContain("require_keys_neq!(self.c");
  });

  test("preserves clean impl methods unchanged", () => {
    const raw = `pub fn double(&self) -> u64 {
        self.x * 2
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    expect(out).toBe(raw);
  });

  test("stubs body referencing anchor_lang or anchor_spl", () => {
    const raw = `pub fn foo() -> Result<()> {
        anchor_lang::system_program::transfer(ctx, 100)?;
        Ok(())
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    expect(out).toContain("⚠️ Anvil TODO");
    expect(out).not.toContain("anchor_lang::system_program::transfer");
  });

  test("Context<Self> in signature triggers stub", () => {
    const raw = `pub fn handler(ctx: Context<Self>) -> Result<()> {
        Ok(())
    }`;
    const out = stubAnchorOnlyImplItem(raw);
    // No body-level Anchor pattern, but the signature is Anchor-shaped — stub
    expect(out).toContain("⚠️ Anvil TODO");
  });
});
