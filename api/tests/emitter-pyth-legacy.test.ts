/**
 * M2b — Pyth legacy oracle read emit (both targets).
 *
 * Native: re-emits the pyth_sdk_solana call chain (Cargo.toml gets
 * the crate via project-scaffold's NATIVE_OPTIONAL_DEPS auto-detect).
 *
 * Pinocchio: hand-rolls the PriceAccountV2 byte deserialization. The
 * magic-header check (0xa1b2c3d4) is the load-bearing piece that fails
 * loud on the wrong account type; the i64/u64 reads pin the documented
 * offsets to the pyth-sdk-solana 0.10 PriceAccount struct layout.
 *
 * Differential gating (against real PriceAccount payloads) is M2c —
 * the cloned validator only carries Pyth Receiver (PriceUpdateV2), not
 * legacy PriceAccount.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

const DEMO = join(import.meta.dir, "..", "src", "demo-programs", "pyth-read-legacy.rs");

async function emitFor(target: "pinocchio" | "native"): Promise<string> {
  const source = readFileSync(DEMO, "utf-8");
  const r = await parseAnchor(source);
  if (!r.ok) throw new Error(`parse: ${r.error}`);
  const out = target === "native" ? emitNativeFull(r.ir) : emitPinocchioFull(r.ir);
  const f = out.files.find((x) => x.path === "instructions/read_price.rs");
  if (!f) throw new Error(`no read_price.rs in ${target} emit`);
  return f.content;
}

describe("M2b — Pyth legacy read emit", () => {
  test("native uses pyth_sdk_solana crate directly", async () => {
    const code = await emitFor("native");
    expect(code).toContain("pyth_sdk_solana::load_price_feed_from_account_info");
    expect(code).toContain("get_price_no_older_than");
    expect(code).toContain("ok_or(ErrorCode::StalePrice)");
    // Native should NOT hand-roll bytes when the crate is available.
    expect(code).not.toContain("from_le_bytes");
    expect(code).not.toContain("0xa1b2c3d4");
  });

  test("pinocchio hand-rolls PriceAccountV2 bytes", async () => {
    const code = await emitFor("pinocchio");
    // Magic-header check — load-bearing for catching wrong account type.
    expect(code).toContain("0xa1b2c3d4");
    // Documented offsets from pyth-sdk-solana 0.10 PriceAccount.
    expect(code).toContain("__pyth_data[0..4]");      // magic
    expect(code).toContain("__pyth_data[20..24]");    // exponent
    expect(code).toContain("__pyth_data[96..104]");   // publish_time
    expect(code).toContain("__pyth_data[208..216]");  // agg.price
    expect(code).toContain("__pyth_data[216..224]");  // agg.conf
    // Local AnvilPythPrice struct gives the price binding a `.price`
    // / `.exponent` / `.conf` / `.publish_time` field shape compatible
    // with pyth_sdk_solana::Price for downstream user code.
    expect(code).toContain("struct AnvilPythPrice");
    expect(code).toContain("pub price: i64");
    expect(code).toContain("pub conf: u64");
    expect(code).toContain("pub exponent: i32");
    expect(code).toContain("pub publish_time: i64");
    // Pinocchio Clock import (not bare Clock::get).
    expect(code).toContain("pinocchio::sysvars::clock::Clock::get()");
  });

  test("pinocchio age-check propagates the .ok_or(ErrorCode::StalePrice) arm", async () => {
    const code = await emitFor("pinocchio");
    // The error arm from `let p = ...get_price_no_older_than(...).ok_or(ErrorCode::StalePrice)?;`
    // must surface in the if-age-too-large branch.
    expect(code).toContain("return Err(ErrorCode::StalePrice)");
  });

  test("both targets bind the priceBinding to a struct with the expected fields", async () => {
    // The user's source body has `msg!("price={}, exponent={}", current_price.price, current_price.exponent);`
    // — both emits must keep `current_price.price` / `current_price.exponent` references valid.
    for (const target of ["native", "pinocchio"] as const) {
      const code = await emitFor(target);
      expect(code).toContain("let current_price");
    }
  });
});
