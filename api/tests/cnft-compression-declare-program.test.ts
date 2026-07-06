/**
 * #44 scope check — a state-compression CPI is only *refused* when it can't be
 * transpiled. When the program is declared via `declare_program!` with an IDL,
 * the SAME external-CPI machinery that handles any other `<crate>::cpi::*` call
 * transpiles it (rewriteDeclareProgramCpis runs before body classification), so
 * the `cnft_compression_unsupported` refuse must NOT fire. The refuse is
 * reserved for the no-IDL raw-crate case.
 *
 * This guards against a regression from the #44 named-refuse detector: it keys
 * on the `spl_account_compression::` namespace, but the declare_program rewrite
 * replaces the call (and uses `*prog.key`, not the base58 id) before the
 * detector sees anything — so the supported path stays supported.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const CALLER = `use anchor_lang::prelude::*;
declare_id!("CnftIDLScope1111111111111111111111111111111");
declare_program!(spl_account_compression);
use spl_account_compression::program::SplAccountCompression;
#[program]
pub mod compressor {
    use super::*;
    pub fn add_leaf(ctx: Context<AddLeaf>, leaf: [u8; 32]) -> Result<()> {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.compression_program.key(),
            spl_account_compression::cpi::accounts::Modify {
                merkle_tree: ctx.accounts.merkle_tree.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
                noop: ctx.accounts.noop.to_account_info(),
            },
        );
        spl_account_compression::cpi::append(cpi_ctx, leaf)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct AddLeaf<'info> {
    /// CHECK
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK
    pub authority: Signer<'info>,
    /// CHECK
    pub noop: UncheckedAccount<'info>,
    pub compression_program: Program<'info, SplAccountCompression>,
}
`;

const IDL = {
  address: "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK",
  metadata: { name: "spl_account_compression", version: "0.4.0", spec: "0.1.0" },
  instructions: [
    {
      name: "append",
      discriminator: [149, 120, 18, 222, 236, 225, 88, 203],
      accounts: [
        { name: "merkle_tree", writable: true },
        { name: "authority", signer: true },
        { name: "noop" },
      ],
      args: [{ name: "leaf", type: { array: ["u8", 32] } }],
    },
  ],
  accounts: [],
  events: [],
  errors: [],
  types: [],
  constants: [],
};

describe("#44 — state-compression CPI: refused without IDL, transpiled with declare_program + IDL", () => {
  test("WITH declare_program IDL → transpiles (no cnft_compression_unsupported)", async () => {
    const r = await parseAnchor(CALLER, { externalIdls: { spl_account_compression: IDL } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The named refuse must NOT fire — the IDL rewrite handled the CPI.
    expect(r.ir.warnings.some((w) => w.code === "cnft_compression_unsupported")).toBe(false);
    // And it must NOT have silently fallen through as an unrecognized CPI either.
    expect(r.ir.warnings.some((w) => w.code === "cpi_unrecognized_dropped")).toBe(false);
  });

  test("WITHOUT IDL → cnft_compression_unsupported refuse fires (deploy-blocked)", async () => {
    const r = await parseAnchor(CALLER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ir.warnings.some((w) => w.code === "cnft_compression_unsupported")).toBe(true);
  });
});
