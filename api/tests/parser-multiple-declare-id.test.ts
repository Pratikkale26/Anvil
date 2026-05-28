import { test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROG = `
#[program]
pub mod p {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Go<'info> { pub signer: Signer<'info> }
`;

// Guards the first-declare_id-wins silent issue: a dual-branch (mainnet/devnet)
// declare_id! source has its program ID picked by source-order, ignoring #[cfg].
// Anvil keeps that behavior but must WARN so the wrong ID isn't emitted silently.
test("multiple declare_id! raises multiple_declare_id warning + picks the first", async () => {
  const dual = `use anchor_lang::prelude::*;
#[cfg(feature = "mainnet")]
declare_id!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
#[cfg(not(feature = "mainnet"))]
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
${PROG}`;
  const r = await parseAnchor(dual);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.ir.programId).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const w = (r.ir.warnings ?? []).find((x) => x.code === "multiple_declare_id");
  expect(w).toBeDefined();
});

test("single declare_id! does NOT raise multiple_declare_id", async () => {
  const single = `use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
${PROG}`;
  const r = await parseAnchor(single);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const w = (r.ir.warnings ?? []).find((x) => x.code === "multiple_declare_id");
  expect(w).toBeUndefined();
});
