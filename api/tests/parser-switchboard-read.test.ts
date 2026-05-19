/**
 * task #47 — parser detector for Switchboard On-Demand PullFeed reader.
 *
 * Two-line idiom recognition (mirror of Pyth M2a):
 *   let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
 *   let price = feed.value().ok_or(MyError::StalePrice)?;
 *
 * Both lines collapse into one cpi_switchboard_read_feed IR stmt; the
 * intermediate let-binding is dropped (since the typed IR carries the
 * binding info directly).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const PROGRAM = (body: string) => `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod sb {
    use super::*;
    pub fn read(ctx: Context<ReadFeed>) -> Result<()> {
        ${body}
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadFeed<'info> {
    pub feed: AccountInfo<'info>,
}
`;

async function findSbStmt(body: string) {
  const parsed = await parseAnchor(PROGRAM(body));
  if (!parsed.ok) throw new Error("parse: " + parsed.error);
  return parsed.ir.instructions[0]!.body.find((s) => s.kind === "cpi_switchboard_read_feed");
}

describe("task #47 — Switchboard PullFeed parser detector", () => {
  test("canonical .value().ok_or(...) idiom", async () => {
    const stmt = await findSbStmt(`
      let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
      let price = feed.value().ok_or(ProgramError::Custom(0))?;
    `);
    expect(stmt).toBeDefined();
    expect((stmt as { feedAccount: string }).feedAccount).toBe("feed");
    expect((stmt as { feedBinding: string }).feedBinding).toBe("feed");
    expect((stmt as { priceBinding: string }).priceBinding).toBe("price");
    expect((stmt as { staleErrExpr?: string }).staleErrExpr).toBe("ProgramError::Custom(0)");
  });

  test("bare .value()? form without ok_or", async () => {
    const stmt = await findSbStmt(`
      let feed_data = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
      let p = feed_data.value()?;
    `);
    expect(stmt).toBeDefined();
    expect((stmt as { feedBinding: string }).feedBinding).toBe("feed_data");
    expect((stmt as { staleErrExpr?: string }).staleErrExpr).toBeUndefined();
  });

  test(".value_with_max_staleness(N) variant captures slots arg", async () => {
    const stmt = await findSbStmt(`
      let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
      let price = feed.value_with_max_staleness(100).ok_or(ProgramError::Custom(0))?;
    `);
    expect(stmt).toBeDefined();
    expect((stmt as { maxStalenessSlots?: string }).maxStalenessSlots).toBe("100");
  });

  test("fully-qualified switchboard_on_demand:: prefix also matched", async () => {
    const stmt = await findSbStmt(`
      let feed = switchboard_on_demand::accounts::PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
      let price = feed.value().ok_or(ProgramError::Custom(0))?;
    `);
    expect(stmt).toBeDefined();
    expect((stmt as { feedAccount: string }).feedAccount).toBe("feed");
  });

  test("try_borrow_data() form (Solana SDK style)", async () => {
    const stmt = await findSbStmt(`
      let feed = PullFeedAccountData::parse(ctx.accounts.feed.try_borrow_data()?)?;
      let price = feed.value().ok_or(ProgramError::Custom(0))?;
    `);
    expect(stmt).toBeDefined();
    expect((stmt as { feedAccount: string }).feedAccount).toBe("feed");
  });

  test("first line without second line does NOT emit cpi_switchboard_read_feed", async () => {
    const stmt = await findSbStmt(`
      let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
      let other_thing = 42;
    `);
    expect(stmt).toBeUndefined();
  });

  test("unrelated .value() call after binding doesn't spuriously match", async () => {
    const stmt = await findSbStmt(`
      let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
      let other = some_other_var.value().ok_or(ProgramError::Custom(0))?;
    `);
    expect(stmt).toBeUndefined();
  });
});
