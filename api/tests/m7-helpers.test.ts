import { describe, test, expect } from "bun:test";
import { u64ToAsciiTsMirror, asciiSliceToString, RUST_U64_TO_ASCII } from "../src/emitter/m7-helpers";

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
