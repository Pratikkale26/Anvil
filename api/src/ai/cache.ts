import { mkdir, readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { dirname, join } from "path";
import type { RefineResponse } from "./refine-schemas.js";

const AI_CACHE_DIR = process.env.ANVIL_AI_CACHE_DIR ?? join(process.cwd(), ".anvil-data", "ai-cache");

export function createAICacheKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function readAICache(key: string): Promise<RefineResponse | null> {
  try {
    const path = join(AI_CACHE_DIR, `${key}.json`);
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as RefineResponse;
  } catch {
    return null;
  }
}

export async function writeAICache(key: string, value: RefineResponse): Promise<void> {
  const path = join(AI_CACHE_DIR, `${key}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}
