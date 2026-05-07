import { describe, test, expect } from "bun:test";
import {
  u64ToAsciiTsMirror,
  asciiSliceToString,
  pubkeyToBase58TsMirror,
  RUST_U64_TO_ASCII,
  RUST_PUBKEY_TO_BASE58,
} from "../src/emitter/m7-helpers";

describe("M7 8a — u64 → ASCII helper algorithm mirror", () => {
  // Each case verifies the TS mirror produces the canonical decimal
  // representation. The Rust impl in RUST_U64_TO_ASCII is required to
  // produce the same output — once M7 8c wires it into emit, cargo
  // MUST_PASS will catch any divergence at compile + test time.
  const cases: { n: bigint; expected: string }[] = [
    { n: 0n, expected: "0" },
    { n: 1n, expected: "1" },
    { n: 9n, expected: "9" },
    { n: 10n, expected: "10" },
    { n: 42n, expected: "42" },
    { n: 100n, expected: "100" },
    { n: 999n, expected: "999" },
    { n: 1000n, expected: "1000" },
    { n: 1_000_000n, expected: "1000000" },
    { n: 1_000_000_000n, expected: "1000000000" },
    { n: 18446744073709551615n, expected: "18446744073709551615" }, // u64::MAX
  ];
  for (const c of cases) {
    test(`u64ToAscii(${c.n}) → "${c.expected}"`, () => {
      const { buf, offset } = u64ToAsciiTsMirror(c.n);
      expect(asciiSliceToString(buf, offset)).toBe(c.expected);
      // Buffer is always 20 bytes; offset + result.length === 20.
      expect(buf.length).toBe(20);
      expect(20 - offset).toBe(c.expected.length);
    });
  }

  test("RUST_U64_TO_ASCII source string is valid Rust shape", () => {
    expect(RUST_U64_TO_ASCII).toContain("pub const fn u64_to_ascii");
    expect(RUST_U64_TO_ASCII).toContain("pub const fn i64_to_ascii");
    // Algorithm-mirror sentinels (catch accidental edits).
    expect(RUST_U64_TO_ASCII).toContain("[u8; 20]");
    expect(RUST_U64_TO_ASCII).toContain("b'0' + (n % 10) as u8");
    expect(RUST_U64_TO_ASCII).toContain("n /= 10");
  });

  test("Rejects negative input (would underflow u64)", () => {
    expect(() => u64ToAsciiTsMirror(-1n)).toThrow();
  });

  test("Rejects > u64::MAX", () => {
    expect(() => u64ToAsciiTsMirror(18446744073709551616n)).toThrow();
  });
});

describe("M7 8b — Pubkey → base58 helper algorithm mirror", () => {
  // Each case is a (32-byte pubkey, expected base58) pair sourced
  // from canonical Solana program IDs. The TS mirror must produce the
  // same output as bs58 encoding; the Rust impl in RUST_PUBKEY_TO_BASE58
  // must produce the same output once M7 8c wires it into emit (cargo
  // MUST_PASS gates that).
  const cases: { name: string; bytes: Uint8Array; expected: string }[] = [
    {
      name: "default (all zero)",
      bytes: new Uint8Array(32),
      expected: "11111111111111111111111111111111",
    },
    {
      name: "system_program (32 zero bytes is also system program)",
      bytes: new Uint8Array(32),
      expected: "11111111111111111111111111111111",
    },
    {
      // SPL Token program ID — TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
      name: "spl_token program",
      bytes: new Uint8Array([
        0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79,
        0xac, 0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff,
        0x00, 0xa9,
      ]),
      expected: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    },
    {
      // Token-2022 program ID — TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
      name: "spl_token_2022 program",
      bytes: new Uint8Array([
        0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde, 0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd,
        0xda, 0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27, 0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1,
        0x8b, 0xfc,
      ]),
      expected: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    },
    {
      // ATA program ID — ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
      name: "associated_token_program",
      bytes: new Uint8Array([
        0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d,
        0x83, 0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9,
        0xf8, 0x59,
      ]),
      expected: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    },
    {
      // All-FF — longest possible base58 of 32 bytes (no leading zeros, max value).
      name: "all-FF",
      bytes: new Uint8Array(32).fill(0xff),
      expected: "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG",
    },
  ];
  for (const c of cases) {
    test(`pubkey_to_base58 (${c.name}) → "${c.expected}"`, () => {
      const { buf, offset } = pubkeyToBase58TsMirror(c.bytes);
      expect(asciiSliceToString(buf, offset)).toBe(c.expected);
      expect(buf.length).toBe(44);
    });
  }

  test("RUST_PUBKEY_TO_BASE58 source string is valid Rust shape", () => {
    expect(RUST_PUBKEY_TO_BASE58).toContain("pub fn pubkey_to_base58");
    expect(RUST_PUBKEY_TO_BASE58).toContain("[u8; 44]");
    expect(RUST_PUBKEY_TO_BASE58).toContain("ALPHABET[remainder as usize]");
    // Sentinel: leading-zero handling (each input zero byte → '1' char).
    expect(RUST_PUBKEY_TO_BASE58).toContain("leading_zeros");
    expect(RUST_PUBKEY_TO_BASE58).toContain(`b'1'`);
  });

  test("Rejects non-32-byte input", () => {
    expect(() => pubkeyToBase58TsMirror(new Uint8Array(31))).toThrow();
    expect(() => pubkeyToBase58TsMirror(new Uint8Array(33))).toThrow();
  });
});
