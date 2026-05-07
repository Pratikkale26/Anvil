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
 * 32-byte Pubkey → base58 ASCII. Stack-allocated 44-byte buffer
 * (longest base58 of 32 zero-MSB bytes — `1` is base58's zero, so
 * leading zero bytes encode as leading `1` chars + the rest). Returns
 * (buf, offset) shape — slice via `&buf[offset..]` for the printable
 * bytes.
 *
 * Algorithm: standard base58 (Bitcoin alphabet,
 * "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz") via
 * repeated big-int division by 58 over the 32-byte input. Leading-zero
 * bytes in the input map 1:1 to leading `'1'` chars in the output.
 *
 * No alloc, no panic, no_std-compatible. Computes in O(N²) but N=32
 * so it's cheap. Used by Anvil's Pinocchio emitter for formatted
 * msg!() expansion when an arg is a Pubkey.
 */
export const RUST_PUBKEY_TO_BASE58 = `/// 32-byte Pubkey → base58 ASCII helper (no_std, stack-only).
///
/// Returns ([u8; 44], usize) — slice via \`&buf[offset..]\` for the
/// printable bytes. \`offset\` points at the first base58 char; the
/// prefix [0..offset) is unused. u64::MAX-style longest cases fit
/// in 44 bytes (32-byte all-FF input encodes to 44 chars).
///
/// Bitcoin's base58 alphabet (no '0', 'O', 'I', 'l').
pub fn pubkey_to_base58(input: &[u8; 32]) -> ([u8; 44], usize) {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut buf = [0u8; 44];
    // Count leading zero bytes — each maps 1:1 to a leading '1'.
    let mut leading_zeros = 0usize;
    while leading_zeros < 32 && input[leading_zeros] == 0 {
        leading_zeros += 1;
    }
    // Big-int division by 58 over a working copy of the input.
    // \`scratch\` holds the remaining big-int; \`out_idx\` walks down
    // from the end of buf, writing one base58 char per division.
    let mut scratch = *input;
    let mut out_idx = 44usize;
    let mut start = leading_zeros;
    while start < 32 {
        // One pass of long division: scratch = scratch / 58, remainder = digit.
        let mut remainder = 0u32;
        let mut i = start;
        while i < 32 {
            let acc = (remainder << 8) | (scratch[i] as u32);
            scratch[i] = (acc / 58) as u8;
            remainder = acc % 58;
            i += 1;
        }
        out_idx -= 1;
        buf[out_idx] = ALPHABET[remainder as usize];
        // Skip newly-zero leading bytes for next iter.
        while start < 32 && scratch[start] == 0 {
            start += 1;
        }
    }
    // Prepend the leading-zero '1' chars.
    let mut k = 0usize;
    while k < leading_zeros {
        out_idx -= 1;
        buf[out_idx] = b'1';
        k += 1;
    }
    (buf, out_idx)
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

/**
 * Algorithm mirror in TypeScript for `pubkey_to_base58`. Same shape
 * as the Rust impl — works on a 32-byte Uint8Array input, returns
 * `{ buf: number[44], offset: number }`. Tests assert against
 * known-canonical pubkey base58 encodings (system program, token
 * program, default zero pubkey).
 */
export function pubkeyToBase58TsMirror(input: Uint8Array): { buf: number[]; offset: number } {
  if (input.length !== 32) throw new Error("pubkeyToBase58TsMirror: input must be 32 bytes");
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const buf = new Array<number>(44).fill(0);
  let leadingZeros = 0;
  while (leadingZeros < 32 && input[leadingZeros] === 0) leadingZeros++;
  const scratch = Uint8Array.from(input);
  let outIdx = 44;
  let start = leadingZeros;
  while (start < 32) {
    let remainder = 0;
    for (let i = start; i < 32; i++) {
      const acc = (remainder << 8) | (scratch[i] ?? 0);
      scratch[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    outIdx--;
    buf[outIdx] = ALPHABET.charCodeAt(remainder);
    while (start < 32 && scratch[start] === 0) start++;
  }
  for (let k = 0; k < leadingZeros; k++) {
    outIdx--;
    buf[outIdx] = "1".charCodeAt(0);
  }
  return { buf, offset: outIdx };
}
