"use client";

/**
 * Landing-playground state hook. Owns the demo/target selection, pipeline
 * stage, fetched code/IR/source, viewport tracking, and the run/copy
 * actions. Mirrors the workbench's use-anvil-pipeline pattern so the
 * landing components stay presentational.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/constants";
import {
  DEMOS,
  LANDING_TARGETS,
  type DemoName,
  type CuRow,
  type LandingStage,
  type Target,
} from "@/data/demos";

type ActiveTab = "source" | "code" | "ir";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useLandingPipeline() {
  const [demo, setDemo] = useState<DemoName>("counter");
  const [target, setTarget] = useState<Target>("pinocchio");
  const [stage, setStage] = useState<LandingStage>("idle");
  const [code, setCode] = useState("");
  const [ir, setIr] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [cuData, setCuData] = useState<CuRow[]>(DEMOS.counter.cuSummary);
  const [copied, setCopied] = useState(false);
  const [apiOk, setApiOk] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("code");
  const [viewportWidth, setViewportWidth] = useState(1280);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/`, { cache: "no-store" })
      .then((r) => setApiOk(r.ok))
      .catch(() => setApiOk(false));
  }, []);

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    setCuData(DEMOS[demo].cuSummary);
    setCode("");
    setIr("");
    setSourceCode("");
    setStage("idle");
  }, [demo]);

  useEffect(() => {
    if (!DEMOS[demo].available) {
      setDemo("counter");
    }
  }, [demo]);

  useEffect(() => {
    const next = LANDING_TARGETS.find((t) => t.id === target);
    if (next && !next.available) {
      setTarget("pinocchio");
    }
  }, [target]);

  const activeTarget = useMemo(
    () => LANDING_TARGETS.find((t) => t.id === target) ?? LANDING_TARGETS[0],
    [target],
  );

  const totals = useMemo(
    () =>
      cuData.reduce(
        (acc, r) => ({
          anchor: acc.anchor + r.anchor,
          pinocchio: acc.pinocchio + r.pinocchio,
          native: acc.native + r.native,
        }),
        { anchor: 0, pinocchio: 0, native: 0 },
      ),
    [cuData],
  );

  const overallSavings = useMemo(() => {
    if (totals.anchor === 0) return "~79%";
    const t = totals[target];
    return `${Math.round(((totals.anchor - t) / totals.anchor) * 100)}%`;
  }, [totals, target]);

  const isRunning = stage === "fetching" || stage === "parsing" || stage === "generating";

  const run = useCallback(async () => {
    if (isRunning) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setStage("fetching");
    setCode("");
    setIr("");
    setSourceCode("");
    try {
      await sleep(300);
      const demoRes = await fetch(`${API_BASE}/demo/${demo}`, { cache: "no-store", signal });
      if (!demoRes.ok) throw new Error("Failed to load demo.");
      const demoPayload = await demoRes.json();
      if (demoPayload.source) {
        setSourceCode(demoPayload.source);
      }
      setStage("parsing");
      await sleep(600);
      setIr(JSON.stringify(demoPayload.ir, null, 2));
      setStage("generating");
      await sleep(400);
      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: demoPayload.ir, target }),
        signal,
      });
      if (!emitRes.ok) throw new Error("Emit failed.");
      const emitPayload = await emitRes.json();
      setCode(emitPayload.code);
      if (emitPayload.cu?.length) {
        const liveCu = emitPayload.cu as CuRow[];
        setCuData(
          DEMOS[demo].cuSummary.map((row) => {
            const live = liveCu.find((c) => c.instruction === row.instruction);
            return live ? { ...row, ...live } : row;
          }),
        );
      }
      setStage("done");
      setApiOk(true);
    } catch {
      if (signal.aborted) return;
      setStage("error");
      setApiOk(false);
    }
  }, [demo, target, isRunning]);

  const activeTabValue = activeTab === "code" ? code : activeTab === "ir" ? ir : sourceCode;
  const activeTabLang = activeTab === "ir" ? "json" : "rust";

  const copy = useCallback(async () => {
    if (!activeTabValue) return;
    await navigator.clipboard.writeText(activeTabValue).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [activeTabValue]);

  const isTablet = viewportWidth < 1100;
  const isMobile = viewportWidth < 760;

  return {
    // selection
    demo, setDemo, target, setTarget,
    // pipeline state
    stage, isRunning,
    // outputs
    code, ir, sourceCode, cuData, totals, overallSavings,
    // tabs / clipboard
    activeTab, setActiveTab, activeTabValue, activeTabLang, copied,
    // status / actions
    apiOk, run, copy, activeTarget,
    // viewport
    isMobile, isTablet,
  };
}

export type LandingPipelineState = ReturnType<typeof useLandingPipeline>;
