/**
 * Unit tests for resolveSeedExpression.
 *
 * Pinned regressions for A1: $state:/$arg: tags must throw, not silently
 * encode the literal tag-string as UTF-8 bytes. The previous fall-through
 * to `Buffer.from(seed, "utf-8")` produced a deterministically-wrong PDA
 * for every state-or-arg-derived seed, surfacing as a misleading "DIVERGED
 * at byte 8" workbench verdict.
 */
import { describe, test, expect } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { resolveSeedExpression } from "../src/build/scenario-runner.ts";

describe("resolveSeedExpression: supported shapes still work", () => {
  test("b\"literal\" -> UTF-8 bytes", () => {
    const out = resolveSeedExpression('b"counter"', new Map(), new Map());
    expect(out.equals(Buffer.from("counter", "utf-8"))).toBe(true);
  });

  test("$signer:name.pubkey -> 32 bytes", () => {
    const kp = Keypair.generate();
    const signers = new Map([["alice", kp]]);
    const out = resolveSeedExpression("$signer:alice.pubkey", signers, new Map());
    expect(out.length).toBe(32);
    expect(out.equals(Buffer.from(kp.publicKey.toBytes()))).toBe(true);
  });

  test("$pda:other.pubkey -> 32 bytes", () => {
    const dummy = PublicKey.default;
    const pdas = new Map([["other", { pubkey: dummy, bump: 255 }]]);
    const out = resolveSeedExpression("$pda:other.pubkey", new Map(), pdas);
    expect(out.length).toBe(32);
  });

  test("$mint:foo.pubkey -> 32 bytes when mints map provided", () => {
    const kp = Keypair.generate();
    const mints = new Map([[
      "foo",
      {
        keypair: kp,
        programOwner: PublicKey.default,
        decimals: 6,
        mintAuthority: PublicKey.default,
        supply: 0n,
      },
    ]]);
    const out = resolveSeedExpression("$mint:foo.pubkey", new Map(), new Map(), mints);
    expect(out.length).toBe(32);
    expect(out.equals(Buffer.from(kp.publicKey.toBytes()))).toBe(true);
  });

  test("$mint:foo.pubkey throws when mints map missing the entry", () => {
    expect(() =>
      resolveSeedExpression("$mint:absent.pubkey", new Map(), new Map(), new Map()),
    ).toThrow(/wasn't declared/);
  });

  test("u64:1000 -> 8 little-endian bytes", () => {
    const out = resolveSeedExpression("u64:1000", new Map(), new Map());
    expect(out.length).toBe(8);
    expect(out.readBigUInt64LE(0)).toBe(1000n);
  });

  test("bytes:0xDEADBEEF -> hex", () => {
    const out = resolveSeedExpression("bytes:0xDEADBEEF", new Map(), new Map());
    expect(out.equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true);
  });

  test("plain string literal -> UTF-8 bytes", () => {
    // `seeds = ["counter"]` style; auto-scenario wraps these as `b"counter"`,
    // but the runtime accepts the bare form too (back-compat).
    const out = resolveSeedExpression("counter", new Map(), new Map());
    expect(out.equals(Buffer.from("counter", "utf-8"))).toBe(true);
  });
});

describe("resolveSeedExpression: speculative tags refused loudly (A1)", () => {
  test("$state: throws with a clear message", () => {
    expect(() =>
      resolveSeedExpression("$state:counter.bump", new Map(), new Map()),
    ).toThrow(/state-derived seeds.*not yet supported/);
  });

  test("$arg: throws with a clear message", () => {
    expect(() =>
      resolveSeedExpression("$arg:name", new Map(), new Map()),
    ).toThrow(/arg-derived seeds.*not yet supported/);
  });

  test("$keypair: bare form (no .pubkey suffix) is refused as a seed", () => {
    // `$keypair:foo.pubkey` IS valid (resolver supports it for B2f-synth
    // PDA derivation), but the bare form has no recognized shape and must
    // throw rather than UTF-8-encode the tag string.
    expect(() =>
      resolveSeedExpression("$keypair:foo", new Map(), new Map()),
    ).toThrow(/unknown seed reference shape/);
  });

  test("$program: as a seed is refused", () => {
    expect(() =>
      resolveSeedExpression("$program:system", new Map(), new Map()),
    ).toThrow(/not as a PDA seed/);
  });

  test("unknown $-prefixed sigil refused (no UTF-8 fall-through)", () => {
    expect(() =>
      resolveSeedExpression("$mystery:foo", new Map(), new Map()),
    ).toThrow(/unknown seed reference shape/);
  });

  // Critical: prove that the fix actually prevents the silent-corruption
  // path. Before A1, $state:counter.bump fell through to UTF-8 encoding and
  // returned 19 bytes of literal tag-string. Confirming we throw here means
  // no scenario can ever silently use those bytes as a seed.
  test("regression: $state: never returns tag-string bytes", () => {
    let returned: Buffer | null = null;
    try {
      returned = resolveSeedExpression("$state:counter.bump", new Map(), new Map());
    } catch {
      // expected
    }
    expect(returned).toBeNull();
  });
});
