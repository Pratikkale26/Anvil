/**
 * N5 — modern Pyth oracle read pattern detection. Distinguished from
 * legacy by:
 *   - 3-arg `get_price_no_older_than(&clock, max_age, &feed_id)`
 *   - account typed `Account<'info, PriceUpdateV2>` (legacy was AccountInfo)
 *   - feed_id obtained via `get_feed_id_from_hex` (passes through as
 *     a separate pass_through statement for now — Pinocchio-compatible
 *     hex parse is a follow-up)
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

describe("N5 — modern Pyth read parser detection", () => {
  test("3-arg get_price_no_older_than on ctx.accounts.X → cpi_pyth_read_price_modern", async () => {
    const source = `
      use anchor_lang::prelude::*;
      use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};
      declare_id!("PythMod1111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let feed_id: [u8; 32] = get_feed_id_from_hex("0xef00")?;
          let price = ctx.accounts.price_update
            .get_price_no_older_than(&Clock::get()?, 60, &feed_id)?;
          Ok(())
        }
      }

      #[derive(Accounts)]
      pub struct R<'info> {
        pub price_update: Account<'info, PriceUpdateV2>,
      }
    `;
    const r = await parseAnchor(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "read");
    expect(ix).toBeDefined();
    const stmt = ix!.body.find((s) => s.kind === "cpi_pyth_read_price_modern") as any;
    expect(stmt).toBeDefined();
    expect(stmt.priceUpdateAccount).toBe("price_update");
    expect(stmt.priceBinding).toBe("price");
    expect(stmt.maxAgeExpr).toBe("60");
    expect(stmt.feedIdExpr).toBe("&feed_id");
    expect(stmt.clockExpr).toContain("Clock::get()");
  });

  test("modern and legacy don't collide — legacy 2-arg routes correctly", async () => {
    const source = `
      use anchor_lang::prelude::*;
      use pyth_sdk_solana::load_price_feed_from_account_info;
      declare_id!("PythLegacy11111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn legacy_read(ctx: Context<R>) -> Result<()> {
          let pf = load_price_feed_from_account_info(&ctx.accounts.feed)?;
          let p = pf.get_price_no_older_than(&Clock::get()?, 60).ok_or(ErrorCode::Stale)?;
          Ok(())
        }
      }

      #[derive(Accounts)]
      pub struct R<'info> {
        pub feed: AccountInfo<'info>,
      }

      #[error_code]
      pub enum ErrorCode { #[msg("stale")] Stale }
    `;
    const r = await parseAnchor(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "legacy_read")!;
    const kinds = ix.body.map((s) => s.kind);
    expect(kinds).toContain("cpi_pyth_read_price_legacy");
    expect(kinds).not.toContain("cpi_pyth_read_price_modern");
  });

  test("modern call without ctx.accounts. prefix still detected", async () => {
    // Programs that bind the PriceUpdate account to a local var first:
    //   let pu = &ctx.accounts.price_update;
    //   let p = pu.get_price_no_older_than(...)?;
    // The regex strips ctx.accounts. but should also accept bare receivers.
    const source = `
      use anchor_lang::prelude::*;
      use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};
      declare_id!("PythMod1111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let feed_id: [u8; 32] = get_feed_id_from_hex("0xef00")?;
          let price = price_update_alias.get_price_no_older_than(&Clock::get()?, 60, &feed_id)?;
          Ok(())
        }
      }

      #[derive(Accounts)]
      pub struct R<'info> {
        pub price_update_alias: Account<'info, PriceUpdateV2>,
      }
    `;
    const r = await parseAnchor(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stmt = r.ir.instructions
      .find((i) => i.name === "read")!.body
      .find((s) => s.kind === "cpi_pyth_read_price_modern") as any;
    expect(stmt).toBeDefined();
    expect(stmt.priceUpdateAccount).toBe("price_update_alias");
  });
});
