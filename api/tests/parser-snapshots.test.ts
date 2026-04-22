import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";

const DEMOS = ["counter", "vault", "escrow", "staking"];
const SNAPSHOT_DIR = `${import.meta.dir}/snapshots`;

describe("Parser Snapshots", () => {
  for (const demo of DEMOS) {
    test(`parses ${demo} correctly`, async () => {
      const sourcePath = `${import.meta.dir}/../src/demo-programs/${demo}.rs`;
      expect(existsSync(sourcePath)).toBe(true);

      const source = readFileSync(sourcePath, "utf-8");
      const result = await parseAnchor(source);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Normalize timestamp for snapshot stability
      const ir = {
        ...result.ir,
        metadata: { ...result.ir.metadata, parsedAt: "NORMALIZED" },
      };

      const snapshotPath = `${SNAPSHOT_DIR}/${demo}-ir.json`;
      if (!existsSync(snapshotPath)) {
        // Create snapshot on first run
        mkdirSync(SNAPSHOT_DIR, { recursive: true });
        writeFileSync(snapshotPath, JSON.stringify(ir, null, 2));
        console.log(`Created snapshot: ${snapshotPath}`);
        return;
      }

      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
      expect(ir).toEqual(snapshot);
    });
  }
});
