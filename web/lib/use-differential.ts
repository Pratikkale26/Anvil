"use client";

/**
 * Hook orchestrating the workbench's byte-equal differential UX.
 *
 * Owns:
 *   - the auto-scenario fetch (POST /build/differential/auto-scenario)
 *   - scenario state (form view + JSON view, two-way sync)
 *   - quota/availability fetch (GET /build/differential/quota)
 *   - the verify run (POST /build/differential?stream=1, SSE consumer)
 *   - verdict + per-stage progress display state
 *
 * Consumed by `differential-panel.tsx` (scenario view) and
 * `differential-verdict.tsx` (verdict view) -- both read the same hook
 * instance via the workbench's existing pipeline-state pattern.
 */
import { useCallback, useEffect, useState } from "react";
import {
  API_BASE,
  type AutoScenarioBlocker,
  type AutoScenarioResponse,
  type DifferentialQuota,
  type DifferentialVerdict,
  type ScenarioShape,
} from "./constants";

export type DifferentialPhase =
  | "idle"
  | "fetching-scenario"
  | "scenario-ready"
  | "scenario-blocked"
  | "running"
  | "verdict";

export interface DifferentialProgress {
  phase: "build" | "scenario-anchor" | "scenario-anvil" | "comparing" | null;
  message: string;
  buildLogs: string[];
}

/**
 * P5.3: detect whether the parsed IR contains SPL / Token-2022 / ATA
 * CPI body statements. When it does, the workbench's differential
 * panel surfaces a "Recommended for SPL programs" badge to nudge the
 * user to run byte-equal verification before extracting. Pure read of
 * IR body kinds — no type-narrowing across the unknown unwrapping
 * because the workbench passes the IR as opaque JSON.
 */
function detectSplCpiInIr(ir: unknown | null): boolean {
  if (!ir || typeof ir !== "object") return false;
  const root = ir as { instructions?: Array<{ body?: Array<{ kind?: string }> }> };
  const ixs = root.instructions;
  if (!Array.isArray(ixs)) return false;
  for (const ix of ixs) {
    if (!Array.isArray(ix.body)) continue;
    for (const stmt of ix.body) {
      const k = stmt.kind;
      if (typeof k !== "string") continue;
      if (
        k.startsWith("cpi_spl_") ||
        k.startsWith("cpi_t22_") ||
        k === "cpi_ata_create" ||
        k === "cpi_memo"
      ) {
        return true;
      }
    }
  }
  return false;
}

export function useDifferential(args: {
  ir: unknown | null;
  anchorSource: string | null;
  anvilEmittedFiles: Array<{ path: string; content: string }> | null;
  anvilScaffoldFiles: Array<{ path: string; content: string }> | null;
  programName: string;
  programIdBase58?: string;
  target?: "pinocchio" | "native";
}) {
  const [phase, setPhase] = useState<DifferentialPhase>("idle");
  const [scenario, setScenario] = useState<ScenarioShape | null>(null);
  const [scenarioJson, setScenarioJson] = useState<string>("");
  const [autoNotes, setAutoNotes] = useState<Array<{ message: string }>>([]);
  const [autoBlockersList, setAutoBlockersList] = useState<AutoScenarioBlocker[]>([]);
  const [verdict, setVerdict] = useState<DifferentialVerdict | null>(null);
  const [progress, setProgress] = useState<DifferentialProgress>({ phase: null, message: "", buildLogs: [] });
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<DifferentialQuota | null>(null);

  // Fetch quota + availability on mount + after every verify run.
  const refreshQuota = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/build/differential/quota`);
      if (r.ok) setQuota(await r.json() as DifferentialQuota);
    } catch { /* offline / no-cors -- ignore */ }
  }, []);
  useEffect(() => { void refreshQuota(); }, [refreshQuota]);

  // Two-way sync: when scenario state object changes, regenerate JSON
  // text. When user edits JSON text (via Monaco), parse + update object.
  useEffect(() => {
    if (scenario) setScenarioJson(JSON.stringify(scenario, null, 2));
  }, [scenario]);

  const updateScenarioJson = useCallback((json: string) => {
    setScenarioJson(json);
    try {
      const parsed = JSON.parse(json) as ScenarioShape;
      setScenario(parsed);
      setError(null);
    } catch (err) {
      setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // ── Generate auto-scenario from IR ───────────────────────────────────────
  const generateAutoScenario = useCallback(async () => {
    if (!args.ir) {
      setError("Compile a program first -- auto-scenario needs the IR.");
      return;
    }
    setPhase("fetching-scenario");
    setError(null);
    setVerdict(null);
    setAutoBlockersList([]);
    try {
      const res = await fetch(`${API_BASE}/build/differential/auto-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: args.ir }),
      });
      const data = (await res.json()) as AutoScenarioResponse;
      if (data.ok) {
        setScenario(data.scenario);
        setAutoNotes(data.notes);
        setAutoBlockersList([]);
        setPhase("scenario-ready");
      } else {
        setAutoBlockersList(data.blockers);
        setAutoNotes([]);
        setScenario(null);
        setPhase("scenario-blocked");
      }
    } catch (err) {
      setError(`Auto-scenario failed: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("idle");
    }
  }, [args.ir]);

  // ── Run the verification (SSE) ───────────────────────────────────────────
  const runVerify = useCallback(async () => {
    if (!scenario) {
      setError("Generate or paste a scenario first.");
      return;
    }
    if (!args.ir || !args.anchorSource || !args.anvilEmittedFiles) {
      setError("Missing source / emitted files / IR -- compile first.");
      return;
    }
    if (!quota?.available) {
      setError("Differential testing isn't available on this deploy. Run via the CLI: anvil-sol differential <input> --scenario scenario.json");
      return;
    }
    if (!quota.allowed) {
      setError(quota.reason ?? "Quota exhausted.");
      return;
    }
    setPhase("running");
    setVerdict(null);
    setError(null);
    setProgress({ phase: "build", message: "Starting build...", buildLogs: [] });

    const controller = new AbortController();
    try {
      const res = await fetch(`${API_BASE}/build/differential?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anchorSource: args.anchorSource,
          anvilEmittedFiles: args.anvilEmittedFiles,
          // API synthesises scaffold from IR + target when omitted/empty.
          ...(args.anvilScaffoldFiles && args.anvilScaffoldFiles.length > 0
            ? { anvilScaffoldFiles: args.anvilScaffoldFiles }
            : {}),
          target: args.target ?? "pinocchio",
          ir: args.ir,
          scenario,
          programName: args.programName,
          programIdBase58: args.programIdBase58,
        }),
        signal: controller.signal,
      });

      // Fast-path errors (toolchain missing, validation, scenario lint, quota
      // exhausted) come back as JSON before SSE setup. fetch always has a
      // body, so gating on `!res.body` here used to swallow the JSON and the
      // SSE reader below would consume it as zero events -- workbench got
      // stuck on "Starting build..." forever. Always treat non-2xx as JSON.
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        const lintIssues = (errBody as { lintIssues?: Array<{ message: string }> }).lintIssues;
        const baseMsg = (errBody as { error?: string }).error ?? `HTTP ${res.status}`;
        const fullMsg = lintIssues && lintIssues.length > 0
          ? `${baseMsg}: ${lintIssues.map((i) => i.message).join("; ")}`
          : baseMsg;
        setError(fullMsg);
        setPhase("idle");
        setProgress({ phase: null, message: "", buildLogs: [] });
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Parse SSE: events separated by \n\n
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const lines = ev.split("\n");
          let event = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!event) continue;
          let payload: unknown = {};
          try { payload = JSON.parse(data); } catch { /* keep raw */ }
          dispatchSseEvent(event, payload);
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(`Verify failed: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("idle");
    } finally {
      void refreshQuota();
    }
  }, [scenario, args.ir, args.anchorSource, args.anvilEmittedFiles, args.anvilScaffoldFiles, args.programName, args.programIdBase58, args.target, quota, refreshQuota]);

  function dispatchSseEvent(event: string, payload: unknown) {
    if (event === "build-start") {
      setProgress({ phase: "build", message: "Building both .so files...", buildLogs: [] });
    } else if (event === "build-log") {
      const line = (payload as { line?: string }).line ?? "";
      setProgress((p) => ({ ...p, buildLogs: [...p.buildLogs.slice(-50), line] }));
    } else if (event === "build-done") {
      setProgress((p) => ({ ...p, phase: "build", message: "Builds complete." }));
    } else if (event === "scenario-start") {
      const target = (payload as { target?: string }).target ?? "?";
      setProgress({
        phase: target === "anchor" ? "scenario-anchor" : "scenario-anvil",
        message: `Running scenario against ${target} reference...`,
        buildLogs: [],
      });
    } else if (event === "scenario-done") {
      const target = (payload as { target?: string }).target ?? "?";
      setProgress((p) => ({ ...p, message: `${target}: scenario completed.` }));
    } else if (event === "comparing") {
      setProgress({ phase: "comparing", message: "Comparing accounts + assertions...", buildLogs: [] });
    } else if (event === "done") {
      setVerdict(payload as DifferentialVerdict);
      setProgress({ phase: null, message: "", buildLogs: [] });
      setPhase("verdict");
    } else if (event === "error") {
      const msg = (payload as { message?: string }).message ?? "unknown error";
      setError(msg);
      setProgress({ phase: null, message: "", buildLogs: [] });
      setPhase("idle");
    }
  }

  // P5.3 — recompute on every IR change. Cheap (walks body kinds), so
  // useMemo is overkill; the IR identity is stable across re-renders
  // until the user re-runs the pipeline.
  const recommendedForSpl = detectSplCpiInIr(args.ir);

  return {
    phase,
    scenario,
    scenarioJson,
    setScenarioJson: updateScenarioJson,
    setScenario,
    autoNotes,
    autoBlockers: autoBlockersList,
    verdict,
    progress,
    error,
    quota,
    target: args.target ?? "pinocchio",
    /**
     * True when the IR has SPL / Token-2022 / ATA / Memo CPI body kinds.
     * SPL touches have the highest divergence-risk (decimals, account
     * ordering, signer-seed shape) so the workbench surfaces a
     * "Recommended for SPL programs" badge near the differential CTA.
     */
    recommendedForSpl,
    generateAutoScenario,
    runVerify,
    reset: () => {
      setPhase("idle");
      setScenario(null);
      setVerdict(null);
      setError(null);
      setAutoBlockersList([]);
      setAutoNotes([]);
    },
  };
}

export type DifferentialState = ReturnType<typeof useDifferential>;
