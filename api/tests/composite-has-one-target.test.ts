/**
 * F8 (#16) — a nested composite `has_one = <field>` must resolve its target
 * BINDING to the same composite group's account (`<prefix><field>`), not
 * first-match a same-named TOP-LEVEL account.
 *
 * Anchor resolves a composite has_one within the field's own `#[derive(Accounts)]`
 * struct. Before this fix, Anvil's `find(acc.name === <field>)` first-matched the
 * top-level account, so the nested check was mis-targeted (silently subsumed when
 * the two accounts share a key/seed; a SILENT mis-validation when they differ).
 *
 * The fix scopes only the BINDING (key source) via the account's compositePrefix;
 * the deserialized struct FIELD name stays bare (the struct field is `my_account`,
 * not `nested_my_account` — the 2026-05-27 revert that prefixed BOTH broke field
 * access).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.js";
import { emitNativeFull } from "../src/emitter/native-emitter.js";

const SRC = `
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Outer>) -> Result<()> {
        let _r = &ctx.accounts.nested.related;
        Ok(())
    }
}

#[account]
pub struct Related { pub my_account: Pubkey, pub data: u64 }

#[derive(Accounts)]
pub struct Nested<'info> {
    /// CHECK: only the key is used (has_one target)
    pub my_account: UncheckedAccount<'info>,
    #[account(has_one = my_account)]
    pub related: Account<'info, Related>,
}

#[derive(Accounts)]
pub struct Outer<'info> {
    /// CHECK: top-level, same name as the nested target
    pub my_account: UncheckedAccount<'info>,
    pub nested: Nested<'info>,
}
`;

describe("F8 composite has_one target resolution", () => {
  test("parser records compositePrefix on flattened nested accounts", async () => {
    const r = await parseAnchor(SRC);
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    const accts = r.ir.instructions[0]!.accounts;
    const names = accts.map((a) => a.name);
    // Flattened: top-level my_account + nested_my_account + nested_related.
    expect(names).toContain("my_account");
    expect(names).toContain("nested_my_account");
    expect(names).toContain("nested_related");
    const nestedRelated = accts.find((a) => a.name === "nested_related")!;
    expect(nestedRelated.compositePrefix).toBe("nested_");
    // The top-level account carries no composite prefix.
    expect(accts.find((a) => a.name === "my_account")!.compositePrefix).toBeUndefined();
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull],
    ["native", emitNativeFull],
  ] as const) {
    test(`nested has_one targets the nested binding, not top-level, and reads the bare field (${target})`, async () => {
      const r = await parseAnchor(SRC);
      if (!r.ok) throw new Error(`parse failed: ${r.error}`);
      const code = emit(r.ir).singleFile;

      // The has_one comparison line for the nested `related` account.
      const cmp = code
        .split("\n")
        .find((ln) => /!=/.test(ln) && /\bmy_account\b/.test(ln) && /key/.test(ln));
      expect(cmp).toBeDefined();
      // Key source must be the NESTED binding...
      expect(cmp!).toMatch(/nested_my_account\.key/);
      // ...and the deserialized struct FIELD stays bare (`.my_account`, NOT
      // `.nested_my_account` — the reverted bug).
      expect(cmp!).toMatch(/\.my_account !=/);
      expect(cmp!).not.toMatch(/\.nested_my_account !=/);
    });
  }
});
