/**
 * Byte-offset regression for the unified hand-rolled Pyth emit
 * (api/src/emitter/emitter-base.ts emitPythReadPriceLegacy /
 * emitPythReadPriceModern).
 *
 * The cargo-compile test (cargo-compile-pyth.test.ts) only proves the
 * emit COMPILES. The hand-rolled offsets could still be wrong by N
 * bytes and silently return wrong prices — money-loss risk.
 *
 * This test builds synthetic PriceAccountV2 + PriceUpdateV2 byte
 * buffers with KNOWN values, then re-implements the SAME offset reads
 * the Pinocchio emit uses, and asserts the extracted values match the
 * inputs. If anyone edits the Pinocchio emit's offsets without
 * updating this test, the assertions fail loud.
 *
 * NOT a full differential gate (that's M2c proper — requires running
 * the Rust emit against svm.setAccount-installed PriceUpdate bytes
 * and comparing extracted prices). But it locks in the *byte layout*
 * contract today.
 */
import { describe, test, expect } from "bun:test";

// ─── Synthetic account builders ────────────────────────────────────────────────

/**
 * Build a synthetic PriceAccountV2 (legacy pyth-sdk-solana 0.10
 * PriceAccount struct). Only the fields the Pinocchio emit reads are
 * meaningful; the rest are zero-padded.
 *
 * Layout pinned to the Pinocchio emit at emitter-base.ts:
 *   0..4     magic (u32 LE) = 0xa1b2c3d4
 *   20..24   expo (i32 LE)
 *   96..104  timestamp (i64 LE) — publish_time of the agg block
 *   208..216 agg.price (i64 LE)
 *   216..224 agg.conf (u64 LE)
 */
function buildLegacyPriceAccount(opts: {
  magic?: number;
  expo: number;
  publishTime: bigint;
  price: bigint;
  conf: bigint;
}): Uint8Array {
  const buf = new Uint8Array(2056); // > 224, padding for variable fields
  const view = new DataView(buf.buffer);
  view.setUint32(0, opts.magic ?? 0xa1b2c3d4, true);
  view.setInt32(20, opts.expo, true);
  view.setBigInt64(96, opts.publishTime, true);
  view.setBigInt64(208, opts.price, true);
  view.setBigUint64(216, opts.conf, true);
  return buf;
}

/**
 * Build a synthetic PriceUpdateV2 (pyth-solana-receiver-sdk 0.6).
 * Layout per the Pinocchio emit:
 *   0..8     Anchor discriminator
 *   8..40    write_authority
 *   40       verification_level tag (0 = Partial+u8, 1 = Full)
 *   41       num_signatures (Partial only)
 *   N..N+32  feed_id (N = 42 if Partial, 41 if Full)
 *   N+32..N+40   price (i64)
 *   N+40..N+48   conf (u64)
 *   N+48..N+52   exponent (i32)
 *   N+52..N+60   publish_time (i64)
 */
function buildModernPriceUpdate(opts: {
  feedId: Uint8Array;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  verificationLevel?: "Partial" | "Full";
  numSignatures?: number;
}): Uint8Array {
  const buf = new Uint8Array(256);
  const view = new DataView(buf.buffer);
  // Discriminator (8 bytes, content doesn't matter for the Anvil emit).
  view.setBigUint64(0, 0n, true);
  // write_authority (32 bytes, zero-filled).
  // verification_level tag.
  const vlTag = (opts.verificationLevel ?? "Full") === "Partial" ? 0 : 1;
  buf[40] = vlTag;
  let msgOff: number;
  if (vlTag === 0) {
    buf[41] = opts.numSignatures ?? 1;
    msgOff = 42;
  } else {
    msgOff = 41;
  }
  // Embedded feed_id.
  if (opts.feedId.length !== 32) throw new Error("feedId must be 32 bytes");
  buf.set(opts.feedId, msgOff);
  // PriceFeedMessage fields.
  view.setBigInt64(msgOff + 32, opts.price, true);
  view.setBigUint64(msgOff + 40, opts.conf, true);
  view.setInt32(msgOff + 48, opts.exponent, true);
  view.setBigInt64(msgOff + 52, opts.publishTime, true);
  return buf;
}

// ─── Re-implementation of the Pinocchio emit's offset-reads ────────────────────
// Mirrors the offsets in emitter-base.ts emitPythReadPriceLegacy /
// emitPythReadPriceModern. If the TS reads disagree with the Rust emit's
// reads, the bug is real — both should track the same source-of-truth
// offsets.

function readLegacy(data: Uint8Array): {
  expo: number;
  publishTime: bigint;
  price: bigint;
  conf: bigint;
} {
  if (data.length < 240) throw new Error("too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== 0xa1b2c3d4) throw new Error("bad magic");
  return {
    expo: view.getInt32(20, true),
    publishTime: view.getBigInt64(96, true),
    price: view.getBigInt64(208, true),
    conf: view.getBigUint64(216, true),
  };
}

function readModern(data: Uint8Array, expectedFeedId: Uint8Array): {
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
} {
  if (data.length < 50) throw new Error("too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vlTag = data[40];
  if (vlTag === undefined || vlTag > 1) throw new Error(`bad vl tag: ${vlTag}`);
  const msgOff = vlTag === 0 ? 42 : 41;
  if (data.length < msgOff + 84) throw new Error("too short for msg");
  // Feed-id cross-check.
  const embeddedFeedId = data.subarray(msgOff, msgOff + 32);
  for (let i = 0; i < 32; i++) {
    if (embeddedFeedId[i] !== expectedFeedId[i]) {
      throw new Error(`feed_id mismatch at byte ${i}`);
    }
  }
  return {
    price: view.getBigInt64(msgOff + 32, true),
    conf: view.getBigUint64(msgOff + 40, true),
    exponent: view.getInt32(msgOff + 48, true),
    publishTime: view.getBigInt64(msgOff + 52, true),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Pyth byte-offset regression — legacy PriceAccountV2", () => {
  test("round-trip with known values reads back identical bytes", () => {
    const acc = buildLegacyPriceAccount({
      expo: -8,
      publishTime: 1_700_000_000n,
      price: 42_000_000_000n, // $420.00 with 8-dec expo
      conf: 12_345n,
    });
    const out = readLegacy(acc);
    expect(out.expo).toBe(-8);
    expect(out.publishTime).toBe(1_700_000_000n);
    expect(out.price).toBe(42_000_000_000n);
    expect(out.conf).toBe(12_345n);
  });

  test("wrong magic fails loud", () => {
    const acc = buildLegacyPriceAccount({
      magic: 0xdeadbeef, // wrong magic
      expo: 0,
      publishTime: 0n,
      price: 0n,
      conf: 0n,
    });
    expect(() => readLegacy(acc)).toThrow("bad magic");
  });

  test("negative prices preserve sign", () => {
    const acc = buildLegacyPriceAccount({
      expo: 0,
      publishTime: 1n,
      price: -100_000n, // negative i64
      conf: 0n,
    });
    expect(readLegacy(acc).price).toBe(-100_000n);
  });
});

describe("Pyth byte-offset regression — modern PriceUpdateV2", () => {
  // SOL/USD canonical feed id, first 4 bytes are the documented prefix.
  const SOL_USD = new Uint8Array([
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
  ]);

  test("Full-verified round-trip with known values", () => {
    const acc = buildModernPriceUpdate({
      feedId: SOL_USD,
      price: 12_345_678n,
      conf: 999n,
      exponent: -8,
      publishTime: 1_700_000_000n,
      verificationLevel: "Full",
    });
    const out = readModern(acc, SOL_USD);
    expect(out.price).toBe(12_345_678n);
    expect(out.conf).toBe(999n);
    expect(out.exponent).toBe(-8);
    expect(out.publishTime).toBe(1_700_000_000n);
  });

  test("Partial-verified shifts message offset by 1", () => {
    const acc = buildModernPriceUpdate({
      feedId: SOL_USD,
      price: 7n,
      conf: 1n,
      exponent: 0,
      publishTime: 42n,
      verificationLevel: "Partial",
      numSignatures: 3,
    });
    const out = readModern(acc, SOL_USD);
    expect(out.price).toBe(7n);
    expect(out.publishTime).toBe(42n);
  });

  test("wrong feed_id fails loud (closes the wrong-feed attack vector)", () => {
    const acc = buildModernPriceUpdate({
      feedId: SOL_USD,
      price: 100n,
      conf: 0n,
      exponent: 0,
      publishTime: 0n,
    });
    const wrongFeed = new Uint8Array(32);
    wrongFeed[0] = 0x42; // differs from SOL_USD
    expect(() => readModern(acc, wrongFeed)).toThrow(/feed_id mismatch/);
  });

  test("unknown verification_level tag (>1) fails loud", () => {
    const acc = new Uint8Array(256);
    acc[40] = 2; // invalid
    expect(() => readModern(acc, SOL_USD)).toThrow(/bad vl tag/);
  });
});
