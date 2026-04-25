#!/usr/bin/env bun
/**
 * Streaming smoke test for /build/auto-fix?stream=1.
 *
 * Two passes:
 *   1) `counter` (clean demo) — confirms one iteration → build-result(ok) → done.
 *   2) `perp-funding` (errors) — confirms refine-start / refine-result events fire.
 *
 * Each event is printed as it arrives so the output can be eyeballed for
 * latency / ordering. Asserts that a `done` event terminated each stream.
 */

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

interface SSEEvent {
  type: string;
  data: unknown;
}

async function streamAutoFix(body: unknown, label: string): Promise<SSEEvent[]> {
  console.log(`\n── streaming /build/auto-fix?stream=1 (${label}) ──`);
  const t0 = Date.now();
  const res = await fetch(`${API}/build/auto-fix?stream=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`stream POST → ${res.status}: ${text.slice(0, 300)}`);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream")) {
    throw new Error(`expected text/event-stream, got '${ctype}'`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SSEEvent[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf("\n\n");

      let evtType = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) evtType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let data: unknown;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch (err) {
        console.error(`  bad JSON in event: ${(err as Error).message}`);
        continue;
      }

      const ms = Date.now() - t0;
      const summary = summarize(evtType, data);
      console.log(`  +${String(ms).padStart(5)}ms  ${evtType.padEnd(16)} ${summary}`);
      events.push({ type: evtType, data });
    }
  }
  return events;
}

function summarize(type: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  switch (type) {
    case "iteration-start":
      return `iteration=${d.iteration}`;
    case "build-result":
      return `iteration=${d.iteration} ok=${d.ok} errors=${(d.errors as unknown[])?.length ?? 0} durMs=${d.durationMs}`;
    case "refine-start":
      return `iteration=${d.iteration}`;
    case "refine-result":
      return `iteration=${d.iteration} accepted=${d.acceptedPatches} rejected=${d.rejectedPatches} cost~$${
        typeof d.estimatedCostUsd === "number" ? d.estimatedCostUsd.toFixed(4) : "?"
      }`;
    case "refine-error":
      return `iteration=${d.iteration} category=${d.category} msg="${String(d.message).slice(0, 60)}"`;
    case "done": {
      const iters = (d.iterations as unknown[])?.length ?? 0;
      return `stopped=${d.stoppedReason} ok=${d.ok} iterations=${iters} totalCost~$${
        typeof d.totalCostUsd === "number" ? d.totalCostUsd.toFixed(4) : "?"
      } durMs=${d.totalDurationMs}`;
    }
    default:
      return JSON.stringify(data).slice(0, 80);
  }
}

// ── Pass 1: clean demo (`counter`) ─────────────────────────────────────────
{
  const demo = await fetchJSON<{ ir: unknown }>("GET", `/demo/counter`);
  const emitted = await fetchJSON<{ files: { path: string; content: string }[]; programName: string }>(
    "POST",
    "/emit",
    { ir: demo.ir, target: "pinocchio", multiFile: true },
  );
  const events = await streamAutoFix(
    {
      target: "pinocchio",
      ir: demo.ir,
      files: emitted.files,
      programName: emitted.programName,
      maxIterations: 3,
      maxCostUsd: 0.5,
    },
    "counter / pinocchio (expected: green on first iteration)",
  );
  const types = events.map((e) => e.type);
  if (!types.includes("iteration-start")) throw new Error("missing iteration-start");
  if (!types.includes("build-result")) throw new Error("missing build-result");
  const doneEvt = events.find((e) => e.type === "done");
  if (!doneEvt) throw new Error("missing done event");
  const done = doneEvt.data as Record<string, unknown>;
  if (done.stoppedReason !== "green") {
    throw new Error(`counter expected stoppedReason=green, got ${done.stoppedReason}`);
  }
  console.log(`  counter: PASS (${types.length} events, terminated with done)`);
}

// ── Pass 2: deliberately-broken counter (forces refine to fire) ───────────
// We take counter's emitted files and inject a syntax error into lib.rs so
// cargo check fails. This guarantees the stream produces refine-start +
// refine-result/refine-error events without depending on a real-world
// contract being broken at this exact commit.
{
  const demo = await fetchJSON<{ ir: unknown }>("GET", `/demo/counter`);
  const emitted = await fetchJSON<{ files: { path: string; content: string }[]; programName: string }>(
    "POST",
    "/emit",
    { ir: demo.ir, target: "pinocchio", multiFile: true },
  );
  const broken = emitted.files.map((f) => {
    if (f.path !== "lib.rs") return f;
    // Inject a reference to a nonexistent identifier that rustc will flag
    // with E0425. Trivially fixable but rustc has to see it first.
    return {
      ...f,
      content: `${f.content}\n\nfn _anvil_stream_test_broken() { let _ = NONEXISTENT_SYMBOL_FOR_STREAM_TEST; }\n`,
    };
  });

  const events = await streamAutoFix(
    {
      target: "pinocchio",
      ir: demo.ir,
      files: broken,
      programName: emitted.programName,
      maxIterations: 2,
      maxCostUsd: 0.20,
    },
    "broken counter / pinocchio (expected: refine-start + refine-result fire)",
  );
  const types = events.map((e) => e.type);
  const doneEvt = events.find((e) => e.type === "done");
  if (!doneEvt) throw new Error("broken-counter stream missing done event");
  if (!types.includes("refine-start")) {
    throw new Error("broken-counter had errors but no refine-start event fired");
  }
  if (!types.includes("refine-result") && !types.includes("refine-error")) {
    throw new Error("broken-counter refine-start fired but neither refine-result nor refine-error followed");
  }
  console.log(`  broken-counter: PASS (${types.length} events, terminated with done)`);
}

console.log("\nALL PASS: SSE streaming smoke test green.");
