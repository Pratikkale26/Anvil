/**
 * task #47 — Switchboard end-to-end parse → emit smoke.
 *
 * Locks the emit output shape: feed account binding, byte-read prelude,
 * staleness gate, f64 result. Output is byte-equal-pending — this test
 * verifies the structural pieces are in the right place, not that the
 * actual bytes deploy correctly. That comes with the differential gate
 * (deferred per docs/plan-switchboard.md).
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const SOURCE = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");

#[program]
mod sb_reader {
    use super::*;
    pub fn read_price(ctx: Context<ReadFeed>) -> Result<()> {
        let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
        let price = feed.value().ok_or(ProgramError::Custom(42))?;
        msg!("price set");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadFeed<'info> {
    pub feed: AccountInfo<'info>,
}
`;

describe("task #47 — Switchboard parse + emit (Pinocchio)", () => {
  test("emit contains the byte-read prelude + f64 conversion", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitPinocchioFull(parsed.ir);
    const all = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    // PullFeed byte-read prelude
    expect(all).toContain("Switchboard On-Demand PullFeed read");
    expect(all).toContain("__sb_data[200..216]");
    expect(all).toContain("__sb_data[296..304]");
    expect(all).toContain("i128::from_le_bytes");
    expect(all).toContain("1_000_000_000_000_000_000.0");
    // staleness error path uses the user's ok_or arm
    expect(all).toContain("ProgramError::Custom(42)");
    // bound to user's localVar
    expect(all).toMatch(/let\s+price:\s*f64\s*=/);
  });

  test("emit drops the original PullFeedAccountData::parse line", async () => {
    const parsed = await parseAnchor(SOURCE);
    const emit = emitPinocchioFull(parsed.ir!);
    const all = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(all).not.toContain("PullFeedAccountData::parse");
  });

  test("emit doesn't reference switchboard_on_demand crate", async () => {
    const parsed = await parseAnchor(SOURCE);
    const emit = emitPinocchioFull(parsed.ir!);
    const all = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(all).not.toContain("switchboard_on_demand");
  });
});

describe("task #47 — Switchboard parse + emit (Native)", () => {
  test("Native emit produces same hand-rolled shape (no crate dep)", async () => {
    const parsed = await parseAnchor(SOURCE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitNativeFull(parsed.ir);
    const all = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(all).toContain("Switchboard On-Demand PullFeed read");
    expect(all).toContain("__sb_data[200..216]");
    expect(all).toContain("i128::from_le_bytes");
    // Native also drops the crate
    expect(all).not.toContain("switchboard_on_demand::");
  });
});

describe("task #47 — value_with_max_staleness variant", () => {
  test("emit gates on Clock slot diff vs maxStalenessSlots arg", async () => {
    const SRC_STALE = `
use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
mod sb { use super::*;
    pub fn read(ctx: Context<R>) -> Result<()> {
        let feed = PullFeedAccountData::parse(&ctx.accounts.feed.data.borrow())?;
        let price = feed.value_with_max_staleness(100).ok_or(ProgramError::Custom(0))?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct R<'info> { pub feed: AccountInfo<'info> }
`;
    const parsed = await parseAnchor(SRC_STALE);
    if (!parsed.ok) throw new Error("parse: " + parsed.error);
    const emit = emitPinocchioFull(parsed.ir);
    const all = (emit.files ?? []).map((f) => f.content).join("\n") || emit.code || "";
    expect(all).toContain("__sb_now_slot");
    expect(all).toContain("(100) as u64");
  });
});
