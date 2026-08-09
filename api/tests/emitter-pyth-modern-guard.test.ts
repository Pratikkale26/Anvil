/**
 * Pyth modern (PriceUpdateV2) — Anchor Account<T> parity guard regression.
 *
 * The Anchor source types the price account as `Account<'info,
 * PriceUpdateV2>`, which enforces (anchor-lang 1.1.2 `Account::try_from`,
 * in order):
 *   1. not-initialized (owner == System && lamports == 0) → error 3012
 *   2. owner == PriceUpdateV2::owner() (pyth receiver)     → error 3007
 *   3. discriminator present                               → error 3001
 *   4. discriminator == sha256("account:PriceUpdateV2")[..8] → error 3002
 *
 * Emitted output originally had NONE of these — a spoofed price account
 * owned by any program passed layout checks and was read as a price
 * (found by sentio SW002 on the transpiled output, 2026-08-09). This test
 * locks the guard on both targets, in Anchor's order, ahead of the layout
 * checks.
 *
 * The legacy path (pyth-sdk-solana via `/// CHECK` AccountInfo) is
 * intentionally unguarded — the Anchor original performs no checks there,
 * and adding any would diverge. Locked below too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";

// Independent oracles — deliberately NOT imported from the emitter, so a
// wrong constant there cannot drift this test along with it.
// base58("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"):
const EXPECTED_PYTH_RECEIVER_ID = [
  12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87,
  203, 2, 71, 116, 250, 254, 1, 230, 196, 223, 152, 204, 56, 88, 129,
];
// sha256("account:PriceUpdateV2")[0..8]:
const EXPECTED_DISCRIMINATOR = [34, 241, 35, 99, 157, 126, 244, 205];

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");

async function emitReadPrice(demo: string, target: "pinocchio" | "native"): Promise<string> {
  const source = readFileSync(join(DEMO_DIR, demo), "utf-8");
  const parsed = await parseAnchor(source);
  if (!parsed.ok) throw new Error("parse failed");
  const out = target === "native" ? emitNativeFull(parsed.ir) : emitPinocchioFull(parsed.ir);
  const file = out.files.find((f) => f.path === "instructions/read_price.rs");
  if (!file) throw new Error(`no read_price.rs in ${target} emit`);
  return file.content;
}

for (const target of ["pinocchio", "native"] as const) {
  describe(`pyth-modern Account<PriceUpdateV2> guard (${target})`, () => {
    test("emits owner + discriminator checks with anchor error codes, in Anchor's order", async () => {
      const body = await emitReadPrice("pyth-read-modern.rs", target);

      // All four anchor error codes present.
      expect(body).toContain("ProgramError::Custom(3012)");
      expect(body).toContain("ProgramError::Custom(3007)");
      expect(body).toContain("ProgramError::Custom(3001)");
      expect(body).toContain("ProgramError::Custom(3002)");

      // Owner pinned to the pyth receiver program id, byte-exact.
      expect(body).toContain(EXPECTED_PYTH_RECEIVER_ID.join(", "));

      // Discriminator byte-exact.
      expect(body).toContain(`[${EXPECTED_DISCRIMINATOR.join(", ")}]`);

      // Anchor's check order: 3012 → 3007 → 3001 → 3002 → then layout reads.
      const order = [3012, 3007, 3001, 3002]
        .map((code) => body.indexOf(`Custom(${code})`));
      expect(order[0]).toBeGreaterThan(-1);
      expect(order[0]).toBeLessThan(order[1]);
      expect(order[1]).toBeLessThan(order[2]);
      expect(order[2]).toBeLessThan(order[3]);
      expect(order[3]).toBeLessThan(body.indexOf("__pyth_vl_tag"));
    });
  });

  describe(`pyth-legacy stays unguarded (${target})`, () => {
    test("legacy /// CHECK AccountInfo path emits no anchor account-error codes", async () => {
      const body = await emitReadPrice("pyth-read-legacy.rs", target);
      expect(body).not.toContain("ProgramError::Custom(3007)");
      expect(body).not.toContain("ProgramError::Custom(3002)");
    });
  });
}
