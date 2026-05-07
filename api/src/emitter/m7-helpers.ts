/**
 * M7 (Pinocchio formatted msg!() runtime helpers) — first chunk.
 *
 * This module ships ready-to-wire Rust source strings for the `no_std`
 * stack-allocated int-to-ASCII helpers Pinocchio's emitter will need
 * once the rest of M7 lands (format-arg parser, sol_log_data buffer
 * builder, fixture). The helpers are NOT wired into the production
 * emit yet — wiring is M7 step 8c per docs/plan-pure-ast-emitter.md
 * Session 8.
 *
 * The helpers themselves are tested via algorithm-mirror in TS
 * (m7-helpers.test.ts) — same algorithm reimplemented in TS, asserted
 * against the canonical decimal output for known-input/output pairs.
 * Once M7 8c wires the Rust helpers into emit, the existing cargo
 * MUST_PASS layer will fail-loud if the Rust impl diverges from this
 * TS mirror.
 */

/**
 * u64 → ASCII decimal. Stack-allocated 20-byte buffer (max digits for
 * u64::MAX = 18446744073709551615 = 20 chars). Returns the buffer + the
 * offset where printable bytes start; `&buf[offset..]` is the result.
 *
 * `const fn` so it works in `static` contexts and the Rust optimizer can
 * fold call sites against literal args. No `alloc` dep, no panic
 * branches — safe in any Pinocchio handler.
 */
export const RUST_U64_TO_ASCII = `/// Stack-allocated u64 → ASCII decimal helper.
///
/// Returns a fixed [u8; 20] buffer plus the offset where the printable
/// bytes start. Slice via \`&buf[offset..]\` to get the ASCII bytes. No
/// alloc dep, no panic branches. \`const fn\` so call sites with literal
/// args fold at compile time.
///
/// u64::MAX = 18446744073709551615 — 20 ASCII digits, fits the buffer.
pub const fn u64_to_ascii(mut n: u64) -> ([u8; 20], usize) {
    let mut buf = [b'0'; 20];
    if n == 0 {
        return (buf, 19);
    }
    let mut i = 20usize;
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    (buf, i)
}

/// Convenience wrapper around \`u64_to_ascii\` for i64. The sign byte
/// goes immediately before the digits in the buffer (or absent for
/// non-negative). Returns the same (buf, offset) shape; offset points
/// at the sign byte when negative, at the first digit otherwise.
pub const fn i64_to_ascii(n: i64) -> ([u8; 21], usize) {
    let mut out = [b'0'; 21];
    let (digits, dig_off) = u64_to_ascii(if n < 0 { n.unsigned_abs() } else { n as u64 });
    // Copy the digit bytes to out[1..] — leave out[0] available for the sign.
    let mut k = 0usize;
    while k < 20 {
        out[1 + k] = digits[k];
        k += 1;
    }
    if n < 0 {
        out[dig_off] = b'-';
        (out, dig_off)
    } else {
        (out, dig_off + 1)
    }
}
`;

/**
 * Algorithm mirror in TypeScript — same logic as the Rust impl, used to
 * validate expected outputs in the unit tests. Mirror lives close to
 * the source string so it stays easy to keep in sync.
 */
export function u64ToAsciiTsMirror(n: bigint): { buf: number[]; offset: number } {
  if (n < 0n) throw new Error("u64ToAsciiTsMirror: negative input");
  if (n > 18446744073709551615n) throw new Error("u64ToAsciiTsMirror: overflows u64");
  const buf = new Array<number>(20).fill(0x30); // b'0'
  if (n === 0n) return { buf, offset: 19 };
  let i = 20;
  let m = n;
  while (m > 0n) {
    i -= 1;
    buf[i] = 0x30 + Number(m % 10n);
    m = m / 10n;
  }
  return { buf, offset: i };
}

/** Decode a (buf, offset) pair into the printable string. */
export function asciiSliceToString(buf: number[], offset: number): string {
  return Buffer.from(buf.slice(offset)).toString("utf-8");
}
