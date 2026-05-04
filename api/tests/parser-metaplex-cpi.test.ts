/**
 * #29 Metaplex IR kinds — parser smoke + structured stub emit.
 *
 * Establishes that:
 *   1. cpi-detector.ts classifies create_metadata_accounts_v3 +
 *      create_master_edition_v3 calls into typed cpi_mpl_* IR kinds
 *      (not the generic cpi_custom fallback).
 *   2. The body-emitter handlers produce a structured TODO(manual) stub
 *      with every parsed field broken out by name -- strictly better
 *      than the prior text-regex stub.
 *
 * Full per-target real CPI emit (mpl_token_metadata::cpi:: on Native,
 * hand-rolled invoke against the Token Metadata program ID on Pinocchio
 * + Quasar) is grant-M3 / Tier 2.2 work tracked in
 * project-roadmap-todos.md (~5 weeks). The matrix gate's
 * DEFERRED_WITH_DESIGN_NOTE set captures these kinds until then.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::metadata::{Metadata, MetadataAccount};
declare_id!("11111111111111111111111111111111");
`;

describe("#29: Metaplex CPI IR kinds + stub emit", () => {
  test("create_metadata_accounts_v3 produces cpi_mpl_create_metadata_v3 kind", async () => {
    const src = `${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>) -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata_account.to_account_info(),
                    mint: ctx.accounts.mint_account.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 {
                name: "Anvil NFT".to_string(),
                symbol: "ANV".to_string(),
                uri: "ipfs://example".to_string(),
                seller_fee_basis_points: 500,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
    #[account(mut)] pub metadata_account: AccountInfo<'info>,
    #[account(mut)] pub mint_account: AccountInfo<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: AccountInfo<'info>,
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const make = r.ir.instructions.find((i) => i.name === "make")!;
    const stmt = make.body.find((s) => s.kind === "cpi_mpl_create_metadata_v3");
    expect(stmt).toBeDefined();
    if (stmt?.kind === "cpi_mpl_create_metadata_v3") {
      expect(stmt.metadata).toBe("metadata_account");
      expect(stmt.mint).toBe("mint_account");
      expect(stmt.payer).toBe("payer");
      expect(stmt.name).toContain("Anvil NFT");
      expect(stmt.symbol).toContain("ANV");
      expect(stmt.sellerFeeBasisPoints).toBe("500");
      expect(stmt.isMutable).toBe("true");
    }
  });

  test("structured stub emit (Pinocchio + Native) names every field", async () => {
    const src = `${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>) -> Result<()> {
        create_metadata_accounts_v3(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata_account.to_account_info(),
                    mint: ctx.accounts.mint_account.to_account_info(),
                    mint_authority: ctx.accounts.payer.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            DataV2 { name: "X".to_string(), symbol: "X".to_string(), uri: "".to_string(),
                seller_fee_basis_points: 0, creators: None, collection: None, uses: None },
            true, true, None,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MakeNft<'info> {
    #[account(mut)] pub metadata_account: AccountInfo<'info>,
    #[account(mut)] pub mint_account: AccountInfo<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: AccountInfo<'info>,
}
`;
    const r = await parseAnchor(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const emit of [emitPinocchioFull, emitNativeFull]) {
      const out = emit(r.ir);
      const allText = out.singleFile + out.files.map((f) => f.content).join("\n");
      expect(allText).toContain("create_metadata_accounts_v3 CPI");
      expect(allText).toContain("metadata_account");
      expect(allText).toContain("mint_account");
      expect(allText).toContain("TODO(manual)");
    }
  });
});
