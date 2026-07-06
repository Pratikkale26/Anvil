/**
 * #44 — compressed-NFT / state-compression CPI is a NAMED, deliberate refuse.
 *
 * Byte-equal is impossible for cNFT operations: they mutate a concurrent-
 * Merkle-tree account (spl-account-compression) whose correctness can only be
 * proven against the real spl_account_compression / spl_noop / bubblegum
 * programs, and there is no loadable `.so` for any of them in the differential
 * harness. So Anvil refuses — but now with a SPECIFIC diagnostic
 * (`cnft_compression_unsupported`) instead of the generic
 * `cpi_unrecognized_dropped` whose message wrongly invites "file a bug so we
 * add an extractor". The emit still refuses (validator ERROR) either way.
 */
import { describe, test, expect } from "bun:test";
import { detectCnftCompressionCpi } from "../src/parser/ast-helpers.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

describe("detectCnftCompressionCpi — positive matches", () => {
  test("mpl_bubblegum::cpi::mint_v1", () => {
    expect(detectCnftCompressionCpi("mpl_bubblegum::cpi::mint_v1(ctx, args)?;"))
      .toMatch(/bubblegum/);
  });
  test("bare bubblegum::cpi::transfer", () => {
    expect(detectCnftCompressionCpi("bubblegum::cpi::transfer(ctx)?;")).toMatch(/bubblegum/);
  });
  test("spl_account_compression::cpi::append", () => {
    expect(detectCnftCompressionCpi("spl_account_compression::cpi::append(ctx, leaf)?;"))
      .toMatch(/account_compression/);
  });
  test("spl_noop reference", () => {
    expect(detectCnftCompressionCpi("spl_noop::instruction::noop(&data);")).toMatch(/noop/);
  });
  test("program id constants", () => {
    expect(detectCnftCompressionCpi("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY")).toMatch(/bubblegum/);
    expect(detectCnftCompressionCpi("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK")).toMatch(/compression/);
    expect(detectCnftCompressionCpi("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV")).toMatch(/noop/);
  });
});

describe("detectCnftCompressionCpi — negatives (no false positives)", () => {
  test("plain SPL transfer is NOT cNFT", () => {
    expect(detectCnftCompressionCpi("anchor_spl::token::transfer(ctx, 100)?;")).toBeNull();
  });
  test("commented-out bubblegum does not match", () => {
    expect(detectCnftCompressionCpi("// mpl_bubblegum::cpi::mint_v1(ctx)")).toBeNull();
  });
  test("bubblegum inside a string literal does not match", () => {
    expect(detectCnftCompressionCpi('let s = "mpl_bubblegum::cpi::mint_v1";')).toBeNull();
  });
});

const SRC = `use anchor_lang::prelude::*;
declare_id!("Cnft44Refuse111111111111111111111111111111");

#[program]
pub mod cnft {
    use super::*;
    pub fn do_mint(ctx: Context<A>) -> Result<()> {
        mpl_bubblegum::cpi::mint_v1(cpi_ctx(&ctx), args())?;
        Ok(())
    }
    pub fn do_append(ctx: Context<A>) -> Result<()> {
        spl_account_compression::cpi::append(cpi_ctx2(&ctx), leaf())?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct A<'info> {
    /// CHECK
    #[account(mut)]
    pub merkle_tree: UncheckedAccount<'info>,
    /// CHECK
    pub authority: Signer<'info>,
}
`;

describe("cNFT program → named refuse warning + validator ERROR", () => {
  test("parser raises cnft_compression_unsupported (not the generic code)", async () => {
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cnftWarns = r.ir.warnings.filter((w) => w.code === "cnft_compression_unsupported");
    expect(cnftWarns.length).toBe(2);
    // The misleading "file a bug so we add an extractor" generic code must NOT fire.
    expect(r.ir.warnings.some((w) => w.code === "cpi_unrecognized_dropped")).toBe(false);
    // Message names the family and states it's deliberate.
    expect(cnftWarns[0]!.message).toMatch(/permanent, by-design refuse|keep these instructions on Anchor/);
  });

  for (const [target, emit] of [
    ["pinocchio", emitPinocchioFull] as const,
    ["native", emitNativeFull] as const,
  ]) {
    test(`${target}: emit still refuses (validator error) — cannot deploy silently`, async () => {
      const r = await parseAnchor(SRC);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const issues = validateEmitterOutput(r.ir, emit(r.ir));
      expect(issues.filter((i) => i.severity === "error").length).toBeGreaterThan(0);
    });
  }
});
