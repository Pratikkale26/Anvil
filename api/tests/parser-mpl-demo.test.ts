/**
 * Guards that the demo program backing the MPL differential fixture parses
 * to a typed `cpi_mpl_*` IR statement — NOT the generic `pass_through`
 * fallback. Silent pass-through is the failure mode that makes a byte-equal
 * differential trivially "pass" even when Anvil's emit literally does
 * nothing while Anchor does the CPI.
 *
 * Locks the parser contract for the demo at api/src/demo-programs/
 * mpl-create-metadata.rs. If the parser regresses on this shape, the test
 * fires loudly BEFORE the differential test wastes a 30s cargo build-sbf
 * cycle reaching a meaningless verdict.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const MPL_CREATE = join(import.meta.dir, "..", "src", "demo-programs", "mpl-create-metadata.rs");

describe("MPL demo programs parse to typed cpi_mpl_* IR kinds (not pass_through)", () => {
  test("mpl-create-metadata.rs → cpi_mpl_create_metadata_v3", async () => {
    const src = readFileSync(MPL_CREATE, "utf-8");
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const make = r.ir.instructions.find((i) => i.name === "make");
    expect(make).toBeDefined();
    if (!make) return;
    const stmt = make.body.find((s) => s.kind === "cpi_mpl_create_metadata_v3");
    expect(stmt).toBeDefined();
    if (stmt?.kind !== "cpi_mpl_create_metadata_v3") return;
    expect(stmt.metadata).toBe("metadata");
    expect(stmt.mint).toBe("mint");
    expect(stmt.payer).toBe("payer");
    expect(stmt.mintAuthority).toBe("payer");
    expect(stmt.updateAuthority).toBe("payer");
    // name/symbol/uri come from the instruction args — captured verbatim
    // as Rust expression text. Differential gate proves equivalence at
    // runtime; parser test only checks the IR shape.
    expect(stmt.name).toBe("name");
    expect(stmt.symbol).toBe("symbol");
    expect(stmt.uri).toBe("uri");
    expect(stmt.sellerFeeBasisPoints).toBe("500");
    expect(stmt.isMutable).toBe("true");
    // Critical regression guard: no body stmt is pass_through. If the
    // parser ever falls back, the CPI emit is replaced with a TODO stub
    // and the differential silently passes (both runtimes no-op).
    const passes = make.body.filter((s) => s.kind === "pass_through");
    expect(passes).toEqual([]);
  });

  test("shorthand DataV2 fields (DataV2 { name, symbol, uri, ... }) capture the variable name, not 'unknown'", async () => {
    // Smaller-surface regression: a parser that drops to `"unknown"` here
    // would silently emit a CPI hard-coding the literal string in the
    // emitted Rust, while Anchor would forward the user's argument. That's
    // a real money-loss class bug for any program where the metadata name
    // comes from instruction args (most NFT minters).
    const src = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::{create_metadata_accounts_v3, CreateMetadataAccountsV3, Metadata};
use anchor_spl::token::{Mint, Token};
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>, name: String, symbol: String, uri: String) -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 {
                name,
                symbol,
                uri,
                seller_fee_basis_points: 500,
                creators: None, collection: None, uses: None,
            },
            true, true, None,
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct MakeNft<'info> {
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stmt = r.ir.instructions[0]?.body.find(
      (s) => s.kind === "cpi_mpl_create_metadata_v3",
    );
    expect(stmt).toBeDefined();
    if (stmt?.kind !== "cpi_mpl_create_metadata_v3") return;
    expect(stmt.name).toBe("name");
    expect(stmt.symbol).toBe("symbol");
    expect(stmt.uri).toBe("uri");
  });
});
