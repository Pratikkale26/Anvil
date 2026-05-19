/**
 * Locks LiteSVM aux-program fixture availability — when a scenario tags
 * `$program:X` the runner is expected to load
 * `tests/fixtures/programs/X.so` via svm.addProgram.
 *
 * Without this test, a missing or corrupted .so silently produces a
 * runtime "program X not loaded" error deep in differential tests; the
 * smoke test fails fast at module load time instead.
 *
 * Pyth Solana Receiver fixture saved 2026-05-19 via
 *   solana program dump rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ \
 *     api/tests/fixtures/programs/pyth_solana_receiver.so \
 *     -u http://localhost:8899
 * (validator must have the program cloned via --clone).
 * Unlocks M2c differential testing for cpi_pyth_read_price_modern.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LiteSVM } from "litesvm";
import { PublicKey } from "@solana/web3.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "programs");

const AUX_PROGRAMS: Array<{
  tag: string;
  filename: string;
  programId: string;
  description: string;
}> = [
  {
    tag: "mpl_token_metadata",
    filename: "mpl_token_metadata.so",
    programId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    description: "Metaplex Token Metadata (12-slot MPL catalog)",
  },
  {
    tag: "pyth_solana_receiver",
    filename: "pyth_solana_receiver.so",
    programId: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    description: "Pyth Solana Receiver (modern PriceUpdateV2 path, M2c unlock)",
  },
];

describe("LiteSVM auxiliary program fixtures", () => {
  for (const aux of AUX_PROGRAMS) {
    test(`${aux.tag} .so fixture present + non-trivial size`, () => {
      const path = join(FIXTURES_DIR, aux.filename);
      expect(existsSync(path)).toBe(true);
      // Anchor-style on-chain programs are typically 50KB-3MB. Anything
      // tiny is a corruption signal; anything massive is a copy mistake.
      const stat = statSync(path);
      expect(stat.size).toBeGreaterThan(50_000);
      expect(stat.size).toBeLessThan(5_000_000);
    });

    test(`${aux.tag} loads into LiteSVM via addProgram`, () => {
      const path = join(FIXTURES_DIR, aux.filename);
      if (!existsSync(path)) {
        throw new Error(`fixture not present: ${path}`);
      }
      const svm = new LiteSVM().withDefaultPrograms();
      const id = new PublicKey(aux.programId);
      // Before addProgram, the program account isn't visible.
      expect(svm.getAccount(id)).toBeNull();
      svm.addProgram(id, readFileSync(path));
      // After addProgram, the account exists + is marked executable.
      const acc = svm.getAccount(id);
      expect(acc).not.toBeNull();
      expect(acc!.executable).toBe(true);
      expect(acc!.data.length).toBeGreaterThan(0);
    });
  }
});
