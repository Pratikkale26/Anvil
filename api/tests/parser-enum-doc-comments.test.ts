/**
 * Regression test for C1 — doc/line comments must not leak into enum
 * variant names. Without the type-parser guard this test exercises,
 * any Anchor program with a doc-commented enum (the norm in production
 * code: mango, openbook, squads, drift, marinade) emits broken Rust
 * with `Self::/// some doc text` match arms.
 */
import { describe, it, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";

const SRC_WITH_DOC_COMMENTS = `
use anchor_lang::prelude::*;

declare_id!("EnumDoc11111111111111111111111111111111111");

#[program]
pub mod enum_doc {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub signer: Signer<'info>,
}

/// User account state — drives access control + balance accounting.
#[account]
pub struct UserAccount {
    pub authority: Pubkey,
    pub kind: UserKind,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum UserKind {
    /// Free-tier user. Default state for newly-created accounts.
    Free,
    /// Premium subscriber — full feature set.
    Premium,
    /* Block-comment variant, used for trial periods. */
    Trial,
    #[deprecated(note = "use Premium")]
    Pro,
}
`;

describe("parser: enum variants must skip line/block comments + attributes", () => {
  it("strips doc comments from variant list", async () => {
    const r = await parseAnchor(SRC_WITH_DOC_COMMENTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const userKind = r.ir.types.find((t) => t.name === "UserKind");
    expect(userKind).toBeTruthy();
    expect(userKind?.kind).toBe("enum");
    if (userKind?.kind !== "enum") return;
    // Exactly the 4 actual variants — no comments, no attributes.
    expect(userKind.variants).toEqual(["Free", "Premium", "Trial", "Pro"]);
    // None of the variants should start with /// or /*.
    for (const v of userKind.variants) {
      expect(v).not.toMatch(/^\s*\/\//);
      expect(v).not.toMatch(/^\s*\/\*/);
    }
  });
});
