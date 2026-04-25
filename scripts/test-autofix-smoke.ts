#!/usr/bin/env bun
// Smoke test the /build/auto-fix endpoint end-to-end.
// Picks a clean-emit demo (counter), confirms the loop returns immediately
// with stoppedReason: "green". Cheap and fast.

const API = "http://localhost:8080";

async function fetchJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

const demo = await fetchJSON<{ ir: unknown }>("GET", `/demo/counter`);
const ir = demo.ir;

const emitted = await fetchJSON<{ files: { path: string; content: string }[]; programName: string }>(
  "POST",
  "/emit",
  { ir, target: "pinocchio", multiFile: true },
);

console.log(`emitted ${emitted.files.length} files for ${emitted.programName}`);

// /build expects bare paths (lib.rs, state.rs); the runner places them under src/.
const t0 = Date.now();
const result = await fetchJSON<{
  ok: boolean;
  stoppedReason: string;
  iterations: { iteration: number; buildResult: { ok: boolean; durationMs: number; errors: unknown[] } }[];
  totalDurationMs: number;
  totalCostUsd: number;
}>("POST", "/build/auto-fix", {
  target: "pinocchio",
  ir,
  files: emitted.files,
  programName: emitted.programName,
  maxIterations: 3,
  maxCostUsd: 0.5,
});
const elapsed = Date.now() - t0;

console.log(`\n=== /build/auto-fix result (${elapsed}ms wall) ===`);
console.log(`ok: ${result.ok}`);
console.log(`stoppedReason: ${result.stoppedReason}`);
console.log(`iterations: ${result.iterations.length}`);
console.log(`totalDurationMs: ${result.totalDurationMs}`);
console.log(`totalCostUsd: ~$${result.totalCostUsd.toFixed(4)}`);
for (const it of result.iterations) {
  console.log(
    `  #${it.iteration}: ${it.buildResult.errors.length} errors, ${it.buildResult.durationMs}ms`,
  );
}

if (!result.ok || result.stoppedReason !== "green") {
  console.error("\nFAIL: counter should auto-fix to green immediately (was already clean).");
  process.exit(1);
}
console.log("\nPASS: auto-fix loop returned green on a clean demo.");
