/**
 * On-disk AI refine response cache.
 *
 * Pre-fix this module was unbounded: every (model × prompt × inputs) tuple
 * landed as a JSON file in ANVIL_aiCacheDir() with no size cap, no entry
 * cap, and no eviction. A long-running process or a busy public API would
 * accumulate gigabytes of cached responses indefinitely. Disk fill →
 * everything else on the host (sandbox writes, Sentry buffer, Express
 * temp files) starts failing.
 *
 * Now: bounded by both entry count and total bytes. On every write we
 * scan the cache directory, compute total size + count, and if either
 * cap is exceeded we evict the oldest entries (by mtime) until we're
 * back under both caps.
 *
 * Caps are env-tunable so a deploy with disk pressure can tighten them
 * without a code change. Defaults are sized for a single-instance API:
 *   - 1 GiB total bytes
 *   - 10 000 entries
 * At ~10 KB per cached response (Sonnet's typical output size), this
 * gives ~100 K cache slots before the byte cap dominates.
 *
 * Eviction runs in-process at write time; we don't depend on a cron or
 * a separate process. The trade-off: a single write that pushes us over
 * the cap pays the eviction cost. With caps bounded as above, an eviction
 * sweep is ~10K-file readdir + stat + sort, sub-100ms on any reasonable
 * disk. If that becomes a hot-path issue, debounce or move to a daemon.
 */
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "fs/promises";
import { createHash } from "crypto";
import { dirname, join } from "path";
import type { RefineResponse } from "./refine-schemas.js";

// Resolved lazily per call so tests that mutate env between imports get
// their override honored. The cost — a process.env.X read + path.join per
// cache touch — is negligible vs the disk I/O that follows.
function aiCacheDir(): string {
  return process.env.ANVIL_AI_CACHE_DIR ?? join(process.cwd(), ".anvil-data", "ai-cache");
}
function maxEntries(): number {
  return parseInt(process.env.ANVIL_AI_CACHE_MAX_ENTRIES ?? "10000", 10);
}
function maxBytes(): number {
  return parseInt(process.env.ANVIL_AI_CACHE_MAX_BYTES ?? `${1024 * 1024 * 1024}`, 10);
}

export function createAICacheKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function readAICache(key: string): Promise<RefineResponse | null> {
  try {
    const path = join(aiCacheDir(), `${key}.json`);
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as RefineResponse;
  } catch {
    return null;
  }
}

export async function writeAICache(key: string, value: RefineResponse): Promise<void> {
  const path = join(aiCacheDir(), `${key}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  // Best-effort eviction. If it fails for any reason (race with another
  // writer, fs error mid-stat) we log and move on — the next write retries.
  try {
    await evictIfNeeded();
  } catch (err) {
    console.warn(`[ai-cache] eviction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Single-pass eviction: scan the cache dir, build (path, mtimeMs, size)
 * triples, sort by mtime ascending (oldest first), and unlink until we're
 * under both caps. Concurrent writers between scan and unlink may race —
 * each unlink swallows ENOENT.
 *
 * Exported for tests; production callers should use writeAICache.
 */
export async function evictIfNeeded(): Promise<{ evicted: number; bytesAfter: number; entriesAfter: number }> {
  let names: string[];
  try {
    names = await readdir(aiCacheDir());
  } catch {
    return { evicted: 0, bytesAfter: 0, entriesAfter: 0 };
  }
  // Stat in parallel; tolerant of ENOENT for files unlinked mid-scan.
  const entries = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (name) => {
        try {
          const full = join(aiCacheDir(), name);
          const s = await stat(full);
          return { path: full, mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      }),
  );
  const valid = entries.filter((e): e is { path: string; mtimeMs: number; size: number } => e !== null);
  let totalBytes = valid.reduce((s, e) => s + e.size, 0);
  let totalEntries = valid.length;
  if (totalEntries <= maxEntries() && totalBytes <= maxBytes()) {
    return { evicted: 0, bytesAfter: totalBytes, entriesAfter: totalEntries };
  }
  // Oldest first.
  valid.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let evicted = 0;
  for (const entry of valid) {
    if (totalEntries <= maxEntries() && totalBytes <= maxBytes()) break;
    try {
      await unlink(entry.path);
      totalBytes -= entry.size;
      totalEntries -= 1;
      evicted += 1;
    } catch {
      // ENOENT (someone else deleted it) — keep going.
    }
  }
  return { evicted, bytesAfter: totalBytes, entriesAfter: totalEntries };
}

/** Inspect the current cache state. Test/metrics use only. */
export async function cacheStats(): Promise<{ entries: number; totalBytes: number; maxEntries: number; maxBytes: number }> {
  let names: string[];
  try {
    names = await readdir(aiCacheDir());
  } catch {
    return { entries: 0, totalBytes: 0, maxEntries: maxEntries(), maxBytes: maxBytes() };
  }
  const sizes = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (name) => {
        try {
          const s = await stat(join(aiCacheDir(), name));
          return s.size;
        } catch {
          return 0;
        }
      }),
  );
  return {
    entries: sizes.length,
    totalBytes: sizes.reduce((a, b) => a + b, 0),
    maxEntries: maxEntries(),
    maxBytes: maxBytes(),
  };
}
