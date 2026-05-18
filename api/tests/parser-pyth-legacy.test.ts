/**
 * M2a — legacy Pyth oracle read pattern detection.
 *
 * The parser collapses the two-line idiom:
 *   let price_feed = load_price_feed_from_account_info(&ctx.accounts.X)?;
 *   let current_price = price_feed.get_price_no_older_than(&clock, max_age)
 *       .ok_or(ErrorCode::Stale)?;
 * into ONE `cpi_pyth_read_price_legacy` IR statement. The first let is
 * dropped; the second emits the typed IR carrying both halves of context.
 *
 * Locks the detection across three call shapes:
 *   1. Standard: load → get_price_no_older_than → ok_or → ?
 *   2. Without ok_or (uses Option<Price> directly)
 *   3. Fully-qualified path: pyth_sdk_solana::load_price_feed_from_account_info
 *
 * Plus locks the negative: a bare get_price_no_older_than without a
 * matching prior load_price_feed_from_account_info stays in pass_through —
 * we should not silently invent a feedAccount.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

function bodyKindsOf(source: string, expectedIxName: string): string[] {
  return new Promise<string[]>(async (resolve, reject) => {
    try {
      const r = await parseAnchor(source);
      if (!r.ok) return reject(new Error(`parse failed: ${r.error}`));
      const ix = r.ir.instructions.find((i) => i.name === expectedIxName);
      if (!ix) return reject(new Error(`no instruction '${expectedIxName}'`));
      resolve(ix.body.map((s) => s.kind));
    } catch (e) {
      reject(e as Error);
    }
  }) as unknown as string[];
}

describe("M2a — legacy Pyth oracle read parser detection", () => {
  test("standard shape — load + get_price_no_older_than + ok_or + ?", async () => {
    const source = `
      use anchor_lang::prelude::*;
      use pyth_sdk_solana::load_price_feed_from_account_info;
      declare_id!("Pyth1111111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let price_feed = load_price_feed_from_account_info(&ctx.accounts.feed)?;
          let current_price = price_feed
            .get_price_no_older_than(&Clock::get()?, 60)
            .ok_or(ErrorCode::Stale)?;
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
    const ix = r.ir.instructions.find((i) => i.name === "read");
    expect(ix).toBeDefined();
    const stmt = ix!.body.find((s) => s.kind === "cpi_pyth_read_price_legacy") as any;
    expect(stmt).toBeDefined();
    expect(stmt.feedAccount).toBe("feed");
    expect(stmt.feedBinding).toBe("price_feed");
    expect(stmt.priceBinding).toBe("current_price");
    expect(stmt.maxAgeExpr).toBe("60");
    expect(stmt.clockExpr).toContain("Clock::get()");
    expect(stmt.staleErrExpr).toBe("ErrorCode::Stale");
  });

  test("variant: no ok_or — bare ? on Option<Price>", async () => {
    const source = `
      use anchor_lang::prelude::*;
      use pyth_sdk_solana::load_price_feed_from_account_info;
      declare_id!("Pyth1111111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let pf = load_price_feed_from_account_info(&ctx.accounts.feed)?;
          let p = pf.get_price_no_older_than(&Clock::get()?, 30)?;
          Ok(())
        }
      }

      #[derive(Accounts)]
      pub struct R<'info> {
        pub feed: AccountInfo<'info>,
      }
    `;
    const r = await parseAnchor(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stmt = r.ir.instructions
      .find((i) => i.name === "read")!.body
      .find((s) => s.kind === "cpi_pyth_read_price_legacy") as any;
    expect(stmt).toBeDefined();
    expect(stmt.staleErrExpr).toBeUndefined();
    expect(stmt.maxAgeExpr).toBe("30");
  });

  test("variant: fully-qualified pyth_sdk_solana:: path", async () => {
    const source = `
      use anchor_lang::prelude::*;
      declare_id!("Pyth1111111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let pf = pyth_sdk_solana::load_price_feed_from_account_info(&ctx.accounts.feed)?;
          let p = pf.get_price_no_older_than(&Clock::get()?, 60)
            .ok_or(ErrorCode::Stale)?;
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
    const ix = r.ir.instructions.find((i) => i.name === "read");
    expect(ix).toBeDefined();
    const stmt = ix!.body.find((s) => s.kind === "cpi_pyth_read_price_legacy") as any;
    expect(stmt).toBeDefined();
    expect(stmt.feedAccount).toBe("feed");
  });

  test("bare get_price_no_older_than without prior load stays pass_through", async () => {
    // No load_price_feed_from_account_info call — the parser must NOT
    // invent the typed IR kind. Stays in pass_through (or wherever the
    // method-call falls).
    const source = `
      use anchor_lang::prelude::*;
      declare_id!("Pyth1111111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
          let p = some_other_feed
            .get_price_no_older_than(&Clock::get()?, 60)
            .ok_or(ErrorCode::Stale)?;
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
    const ix = r.ir.instructions.find((i) => i.name === "read")!;
    const pythStmt = ix.body.find((s) => s.kind === "cpi_pyth_read_price_legacy");
    expect(pythStmt).toBeUndefined();
  });

  test("the load and get_price are collapsed (load stmt is NOT in IR)", async () => {
    const source = `
      use anchor_lang::prelude::*;
      use pyth_sdk_solana::load_price_feed_from_account_info;
      declare_id!("Pyth1111111111111111111111111111111111111");

      #[program]
      pub mod p {
        use super::*;
        pub fn read(ctx: Context<R>) -> Result<()> {
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
    const ix = r.ir.instructions.find((i) => i.name === "read")!;
    // The body should NOT contain a pass_through line that mentions
    // load_price_feed_from_account_info — it must be consumed.
    const leaked = ix.body.some((s) =>
      s.kind === "pass_through" &&
      (s as { code: string }).code.includes("load_price_feed_from_account_info"),
    );
    expect(leaked).toBe(false);
  });
});
