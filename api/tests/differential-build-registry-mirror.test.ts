/**
 * Byte-equal registry hash-dir mirror (the cargo-1.85 index-hash split fix).
 *
 * Cargo names its registry dirs `registry/{index,cache,src}/index.crates.io-<hash>`,
 * and the <hash> flipped at cargo 1.85: `6f17d22bba15001f` (< 1.85) →
 * `1949cf8c6b5b557f` (>= 1.85). On a stale prod image the host warm-fetch cargo
 * (>= 1.91) populates `1949…` while the offline cargo-build-sbf (2.1.0, < 1.85)
 * reads `6f17…` → "no matching package ... offline mode" even though the crate
 * is on disk. mirrorRegistryHashDirs hardlinks the populated dir to the other
 * known hash so whichever cargo runs the offline build resolves its deps.
 *
 * This is a pure fs unit test (no cargo). The real cross-version resolution was
 * verified manually with rustup cargo 1.79 ↔ 1.96; here we lock the mirror's
 * fs behaviour: both hash dirs end up present, with identical content, in all
 * three registry subtrees, and re-running is idempotent.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mirrorRegistryHashDirsForTest } from "../src/build/differential-build.ts";

const HASH_GE_185 = "1949cf8c6b5b557f";
const HASH_LT_185 = "6f17d22bba15001f";
const dir = (h: string) => `index.crates.io-${h}`;

function seedRegistry(cargoHome: string, hash: string) {
  // Minimal shape mirroring what `cargo fetch` lays down under each subtree.
  const files: Array<[string, string]> = [
    [join("index", dir(hash), ".cache", "an", "ch", "anchor-spl"), "INDEX-BLOB"],
    [join("cache", dir(hash), "anchor-spl-0.31.0.crate"), "CRATE-TARBALL"],
    [join("src", dir(hash), "anchor-spl-0.31.0", "Cargo.toml"), "[package]\nname=\"anchor-spl\"\n"],
  ];
  for (const [rel, content] of files) {
    const abs = join(cargoHome, "registry", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

describe("mirrorRegistryHashDirs", () => {
  test("mirrors the populated >=1.85 hash dir to the <1.85 hash dir across index/cache/src", () => {
    const cargoHome = mkdtempSync(join(tmpdir(), "anvil-mirror-"));
    try {
      seedRegistry(cargoHome, HASH_GE_185);
      // Sanity: the other hash dir is absent before the mirror (the prod failure).
      expect(existsSync(join(cargoHome, "registry", "index", dir(HASH_LT_185)))).toBe(false);

      mirrorRegistryHashDirsForTest(cargoHome);

      for (const sub of ["index", "cache", "src"] as const) {
        const probe =
          sub === "index"
            ? join(".cache", "an", "ch", "anchor-spl")
            : sub === "cache"
              ? "anchor-spl-0.31.0.crate"
              : join("anchor-spl-0.31.0", "Cargo.toml");
        const mirrored = join(cargoHome, "registry", sub, dir(HASH_LT_185), probe);
        expect(existsSync(mirrored)).toBe(true);
        const original = join(cargoHome, "registry", sub, dir(HASH_GE_185), probe);
        expect(readFileSync(mirrored, "utf-8")).toBe(readFileSync(original, "utf-8"));
        // Hardlink, not a copy → same inode → near-zero extra disk.
        expect(statSync(mirrored).ino).toBe(statSync(original).ino);
      }
    } finally {
      rmSync(cargoHome, { recursive: true, force: true });
    }
  });

  test("is idempotent and adds newly-fetched crates on a second pass", () => {
    const cargoHome = mkdtempSync(join(tmpdir(), "anvil-mirror-"));
    try {
      seedRegistry(cargoHome, HASH_GE_185);
      mirrorRegistryHashDirsForTest(cargoHome);

      // A later request fetches a new crate into the host hash dir.
      const newCrate = join(cargoHome, "registry", "cache", dir(HASH_GE_185), "spl-token-7.0.0.crate");
      writeFileSync(newCrate, "NEW-CRATE");

      // Second pass must not throw and must propagate the new crate.
      expect(() => mirrorRegistryHashDirsForTest(cargoHome)).not.toThrow();
      expect(existsSync(join(cargoHome, "registry", "cache", dir(HASH_LT_185), "spl-token-7.0.0.crate"))).toBe(true);
    } finally {
      rmSync(cargoHome, { recursive: true, force: true });
    }
  });

  test("no-ops cleanly when neither known hash dir is present", () => {
    const cargoHome = mkdtempSync(join(tmpdir(), "anvil-mirror-"));
    try {
      mkdirSync(join(cargoHome, "registry", "index"), { recursive: true });
      expect(() => mirrorRegistryHashDirsForTest(cargoHome)).not.toThrow();
      expect(existsSync(join(cargoHome, "registry", "index", dir(HASH_LT_185)))).toBe(false);
      expect(existsSync(join(cargoHome, "registry", "index", dir(HASH_GE_185)))).toBe(false);
    } finally {
      rmSync(cargoHome, { recursive: true, force: true });
    }
  });
});
