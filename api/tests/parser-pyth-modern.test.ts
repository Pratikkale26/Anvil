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

  test("N5c — const-string identifier resolved to byte-array literal", async () => {
    const source = `
      use anchor_lang::prelude::*;
      use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};
      declare_id!("PythMod2222222222222222222222222222222222");

      const SOL_USD_FEED_ID: &str = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let feed_id: [u8; 32] = get_feed_id_from_hex(SOL_USD_FEED_ID)?;
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
    const body = r.ir.instructions.find((i) => i.name === "read")!.body;
    // The const-resolved hex should appear as a pyth_feed_id_literal
    // with the parsed 32-byte array. The first byte of the SOL/USD
    // feed id (0xef0d…) is 0xef.
    const stmt = body.find((s) => s.kind === "pyth_feed_id_literal") as any;
    expect(stmt).toBeDefined();
    expect(stmt.localVar).toBe("feed_id");
    expect(stmt.bytes.length).toBe(32);
    expect(stmt.bytes[0]).toBe(0xef);
    expect(stmt.bytes[1]).toBe(0x0d);
    // The original get_feed_id_from_hex call must NOT survive as
    // pass_through (this would re-pull the receiver-sdk dep).
    const leaked = body.some(
      (s) => s.kind === "pass_through" && (s as { code: string }).code.includes("get_feed_id_from_hex"),
    );
    expect(leaked).toBe(false);
  });

  test("N5c — unknown const ident stays pass_through (no silent zero-bytes)", async () => {
    // If the const isn't defined anywhere, the parser must NOT
    // invent a zero-filled feed_id — it should leave the call as
    // pass_through so the lint warns + cargo errors on the missing
    // identifier. Silent-zero would be a wrong-feed attack vector.
    const source = `
      use anchor_lang::prelude::*;
      use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};
      declare_id!("PythMod3333333333333333333333333333333333");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let feed_id: [u8; 32] = get_feed_id_from_hex(UNDEFINED_FEED_ID)?;
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
    const body = r.ir.instructions.find((i) => i.name === "read")!.body;
    expect(body.some((s) => s.kind === "pyth_feed_id_literal")).toBe(false);
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
