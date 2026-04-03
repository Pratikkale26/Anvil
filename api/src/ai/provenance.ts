import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import type { AIProvenance } from "./schemas.js";

const PROVENANCE_PATH = join(process.cwd(), ".anvil-data", "ai-provenance.jsonl");

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function writeProvenance(record: AIProvenance): void {
  mkdirSync(dirname(PROVENANCE_PATH), { recursive: true });
  appendFileSync(PROVENANCE_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

