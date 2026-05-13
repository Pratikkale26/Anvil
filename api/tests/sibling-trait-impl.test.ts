import { describe, test, expect, beforeAll } from "bun:test";
import { commentOutSiblingTraitImpl } from "../src/emitter/emitter-base.ts";
import { getParser } from "../src/parser/ts-init.ts";

beforeAll(async () => {
  await getParser();
});

describe("commentOutSiblingTraitImpl — sibling-Anchor-program trait impls", () => {
  test("comments out impl targeting unknown sibling crate", () => {
    const raw = `impl From<IncomingInstruction> for squads_mpl::state::IncomingInstruction {
    fn from(_: IncomingInstruction) -> Self {
        unimplemented!()
    }
}`;
    const out = commentOutSiblingTraitImpl(raw);
    expect(out).toContain("⚠️ Anvil TODO: trait impl for sibling-Anchor-program type");
    expect(out.split("\n").slice(1).every((l) => l.startsWith("//"))).toBe(true);
  });

  test("preserves impl targeting known external (spl_, mpl_, anchor_*)", () => {
    for (const target of [
      "spl_token::state::Account",
      "mpl_token_metadata::types::Metadata",
      "anchor_spl::token::Mint",
      "solana_program::pubkey::Pubkey",
    ]) {
      const raw = `impl Foo for ${target} { fn x(&self) {} }`;
      expect(commentOutSiblingTraitImpl(raw)).toBe(raw);
    }
  });

  test("preserves impl with non-scoped target type", () => {
    // `for Bar` is local — not a sibling-crate reference.
    const raw = `impl From<Foo> for Bar {
    fn from(_: Foo) -> Self { Bar }
}`;
    expect(commentOutSiblingTraitImpl(raw)).toBe(raw);
  });

  test("preserves impl targeting core/std/alloc", () => {
    for (const target of ["core::fmt::Display", "std::error::Error", "alloc::vec::Vec"]) {
      const raw = `impl ${target.split("::")[2]} for ${target} { }`;
      expect(commentOutSiblingTraitImpl(raw)).toBe(raw);
    }
  });

  test("AST path ignores `for` keyword inside string literal", () => {
    // Regex path would false-match `for sibling_crate::` inside the literal.
    // AST path correctly identifies the target as `LocalType` and skips.
    const raw = `impl Display for LocalType {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result {
        write!(f, "for sibling_crate::token")
    }
}`;
    expect(commentOutSiblingTraitImpl(raw)).toBe(raw);
  });
});
