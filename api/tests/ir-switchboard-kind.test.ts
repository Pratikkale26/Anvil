/**
 * task #47 — Switchboard On-Demand reader IR kind schema test.
 *
 * Kickoff for the Switchboard arc. Full parser + emit + byte-equal
 * differential are scoped in docs/plan-switchboard.md. This commit ships
 * just the IR kind so:
 *   1. Downstream code (parser detector, emit) has the schema to target.
 *   2. The arc isn't blocked on schema review.
 *   3. Future work building toward byte-equal can land atomically.
 */
import { describe, test, expect } from "bun:test";
import { BodyStatementSchema } from "../src/ir/schema.ts";

describe("task #47 — cpi_switchboard_read_feed IR kind", () => {
  test("schema accepts the canonical .value() shape", () => {
    const stmt = {
      kind: "cpi_switchboard_read_feed",
      feedAccount: "feed",
      feedBinding: "feed_data",
      priceBinding: "price",
    };
    const parsed = BodyStatementSchema.safeParse(stmt);
    expect(parsed.success).toBe(true);
  });

  test("schema accepts the .value_with_max_staleness(N) variant", () => {
    const stmt = {
      kind: "cpi_switchboard_read_feed",
      feedAccount: "feed",
      priceBinding: "price",
      maxStalenessSlots: "100",
      staleErrExpr: "MyError::StalePrice.into()",
    };
    const parsed = BodyStatementSchema.safeParse(stmt);
    expect(parsed.success).toBe(true);
  });

  test("schema requires feedAccount + priceBinding", () => {
    const stmt = { kind: "cpi_switchboard_read_feed" } as unknown;
    const parsed = BodyStatementSchema.safeParse(stmt);
    expect(parsed.success).toBe(false);
  });

  test("feedAccount + priceBinding are strings", () => {
    const stmt = {
      kind: "cpi_switchboard_read_feed",
      feedAccount: 123,
      priceBinding: "x",
    };
    const parsed = BodyStatementSchema.safeParse(stmt);
    expect(parsed.success).toBe(false);
  });
});
