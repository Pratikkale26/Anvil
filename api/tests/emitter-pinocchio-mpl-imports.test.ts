/**
 * Locks the Pinocchio import-gate for MPL helpers. The mpl_* family of
 * hand-rolled helpers all use bare `Seed::from(...)` / `Signer::from(...)`
 * inside their signer_seeds match arms. Without
 * `use pinocchio::instruction::{Seed, Signer};` brought in at the top of
 * helpers.rs, cargo refuses with E0433 "use of undeclared type Seed".
 *
 * Caught while wiring the MPL create_metadata_v3 differential (task #51).
 * Pre-fix, the helper compiled cleanly in unit tests because they only
 * inspect emit-string content, never invoking the SBF toolchain — the
 * differential's cargo build-sbf was the first surface where the missing
 * import surfaced.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const HEADER = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::{Metadata, MetadataAccount};
use anchor_spl::token::{Mint, Token, TokenAccount};
declare_id!("11111111111111111111111111111111");
`;

async function emitForKind(programText: string): Promise<string> {
  const r = await parseAnchor(programText);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("parse failed");
  const out = emitPinocchioFull(r.ir);
  return out.singleFile + out.files.map((f) => f.content).join("\n");
}

describe("Pinocchio MPL helpers carry the Seed/Signer import", () => {
  test("create_metadata_v3 helper triggers the Seed/Signer import gate", async () => {
    const text = await emitForKind(`${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<MakeNft>) -> Result<()> {
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
            DataV2 { name: "x".to_string(), symbol: "X".to_string(), uri: "".to_string(),
                seller_fee_basis_points: 0, creators: None, collection: None, uses: None },
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
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
`);
    // The helper body unconditionally uses bare Seed/Signer inside the
    // signer_seeds match arm — even when call sites pass None. Import
    // must come along.
    expect(text).toMatch(/use pinocchio::instruction::\{Seed, Signer\};/);
    expect(text).toMatch(/Seed::from/);
    expect(text).toMatch(/Signer::from/);
  });

  test("sign_metadata helper triggers the Seed/Signer import gate", async () => {
    const text = await emitForKind(`${HEADER}
#[program]
pub mod p {
    use super::*;
    pub fn s(ctx: Context<S>) -> Result<()> {
        sign_metadata(
            CpiContext::new(
                ctx.accounts.token_metadata_program.to_account_info(),
                SignMetadata {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    creator: ctx.accounts.payer.to_account_info(),
                },
            ),
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct S<'info> {
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
}
`);
    expect(text).toMatch(/use pinocchio::instruction::\{Seed, Signer\};/);
  });
});
