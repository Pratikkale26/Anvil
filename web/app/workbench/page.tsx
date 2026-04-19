"use client";

import Editor from "@monaco-editor/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  FolderOpen,
  GitBranch,
  Layers3,
  Loader2,
  Play,
  PlayCircle,
  Rocket,
  Sparkles,
  TerminalSquare,
  Upload,
  Zap,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Target = "pinocchio" | "quasar" | "native";
type InputMode = "demo" | "source" | "file" | "folder" | "repo";
type PipelineStage = "idle" | "resolving" | "parsing" | "emitting" | "validating" | "done" | "error";

type ParseResponse = {
  ir: unknown;
  sourcePath: string | null;
  candidates: string[] | null;
  repoUrl?: string | null;
  source?: string | null;
};

type EmitFile = { path: string; content: string };

type EmitResponse = {
  code: string;
  files?: EmitFile[];
  warnings?: string[];
  programName?: string;
  target: Target;
  transformReport?: { transformedCount: number; passedThroughCount: number };
  validationIssues?: Array<{ severity: "error" | "warning"; message: string; path?: string }>;
  reviewReport?: ReviewReport;
  refined?: boolean;
  refineResult?: RefineResult;
};

type FolderEntry = { path: string; content: string };

type RefinePatch = {
  filePath: string;
  originalContent: string;
  patchedContent: string;
  accepted: boolean;
  acceptanceReason: string;
};

type ReviewFinding = {
  severity: "error" | "warning";
  path?: string;
  message: string;
  suggestedFix: string;
};

type ReviewReport = {
  summary: string;
  findings: ReviewFinding[];
  requiresAI: boolean;
  recommendedAction: string;
};

type RefineResult = {
  rationale: string;
  findings?: Array<{
    severity: "error" | "warning" | "info";
    filePath?: string;
    title: string;
    explanation: string;
    suggestedFix: string;
  }>;
  patches: RefinePatch[];
  summary: string;
  aiCallMade: boolean;
  cacheKey?: string;
  cached?: boolean;
};

// ─── Color palette (matches landing page exactly) ─────────────────────────────

const C = {
  bg:         "#0d0f1a",
  card:       "#131520",
  cardBorder: "rgba(255,255,255,0.09)",
  card2:      "#0f1119",
  text:       "#e8ecf4",
  textSub:    "#9095b0",
  textMuted:  "#5c6080",
  textDim:    "#3e4260",
  amber:      "#f5a623",
  amberLight: "#ffcf6e",
  teal:       "#0ea880",
  indigo:     "#6b7bff",
  line:       "rgba(255,255,255,0.07)",
  red:        "#e05a5a",
};

const TARGET_META: Record<Target, { color: string; label: string; tagline: string }> = {
  pinocchio: { color: C.amber,  label: "Pinocchio", tagline: "Zero-copy by Anza" },
  quasar:    { color: C.teal,   label: "Quasar",    tagline: "Zero-alloc by Blueshift" },
  native:    { color: C.indigo, label: "Native",    tagline: "Raw solana_program" },
};

const MODE_META: Record<InputMode, { icon: React.ElementType; label: string }> = {
  demo:   { icon: PlayCircle, label: "Demo"   },
  source: { icon: Code2,      label: "Source" },
  file:   { icon: FileCode2,  label: "File"   },
  folder: { icon: FolderOpen, label: "Folder" },
  repo:   { icon: GitBranch,  label: "Repo"   },
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const TARGETS: Target[] = ["pinocchio", "quasar", "native"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const STAGES: { id: PipelineStage; label: string; sublabel: string }[] = [
  { id: "resolving",  label: "Resolve input",  sublabel: "Load / fetch source" },
  { id: "parsing",    label: "Parse IR",        sublabel: "Anchor → SolanaIR" },
  { id: "emitting",   label: "Emit code",       sublabel: "IR → Rust files" },
  { id: "validating", label: "Validate",        sublabel: "Structural checks" },
  { id: "done",       label: "Complete",        sublabel: "Code ready" },
];

const STAGE_ORDER: Record<string, number> = {
  idle: -1, resolving: 0, parsing: 1, emitting: 2, validating: 3, done: 4, error: -1,
};

// ─── Tar builder (client-side) ────────────────────────────────────────────────

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function octal(v: number, w: number) { return v.toString(8).padStart(w - 1, "0") + "\0"; }

function writeStr(buf: Uint8Array, off: number, len: number, val: string) {
  buf.set(new TextEncoder().encode(val.slice(0, len)), off);
}

function toAB(v: Uint8Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

function makeTar(files: EmitFile[]): Blob {
  const chunks: BlobPart[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const f of files) {
    const content = new TextEncoder().encode(f.content);
    const hdr = new Uint8Array(512);
    writeStr(hdr, 0, 100, f.path);
    writeStr(hdr, 100, 8, octal(0o644, 8));
    writeStr(hdr, 108, 8, octal(0, 8));
    writeStr(hdr, 116, 8, octal(0, 8));
    writeStr(hdr, 124, 12, octal(content.length, 12));
    writeStr(hdr, 136, 12, octal(now, 12));
    writeStr(hdr, 148, 8, "        ");
    hdr[156] = "0".charCodeAt(0);
    writeStr(hdr, 257, 6, "ustar");
    writeStr(hdr, 263, 2, "00");
    let cs = 0; for (const b of hdr) cs += b;
    writeStr(hdr, 148, 8, octal(cs, 8).replace(/\0$/, " "));
    chunks.push(toAB(hdr), toAB(content));
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) chunks.push(toAB(new Uint8Array(pad)));
  }
  chunks.push(toAB(new Uint8Array(1024)));
  return new Blob(chunks, { type: "application/x-tar" });
}

// ─── Monaco options ───────────────────────────────────────────────────────────

const MONACO_OPTS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: "on" as const,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  padding: { top: 16, bottom: 16 },
  folding: true,
  renderLineHighlight: "none" as const,
  fontFamily: "SFMono-Regular, 'JetBrains Mono', 'Fira Code', Menlo, monospace",
  theme: "vs-dark",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Workbench() {
  const [mode, setMode]   = useState<InputMode>("demo");
  const [target, setTarget] = useState<Target>("pinocchio");
  const [apiOk, setApiOk] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [error, setError] = useState<string | null>(null);

  const [demoNames, setDemoNames] = useState<string[]>([]);
  const [demoName, setDemoName]   = useState("counter");

  const [sourceText, setSourceText] = useState("");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [folderCandidate, setFolderCandidate] = useState("");
  const [repoUrl, setRepoUrl]         = useState("");
  const [repoRef, setRepoRef]         = useState("");
  const [repoSubpath, setRepoSubpath] = useState("");
  const [resolvedSource, setResolvedSource] = useState<string | null>(null);

  const [irText, setIrText]             = useState("");
  const [singleFileCode, setSingleFileCode] = useState("");
  const [outputFiles, setOutputFiles]   = useState<EmitFile[]>([]);
  const [programName, setProgramName]   = useState("anvil-output");
  const [activePane, setActivePane]     = useState<"single" | "ir" | "files">("single");
  const [activeFilePath, setActiveFilePath] = useState("");
  const [warnings, setWarnings]         = useState<string[]>([]);
  const [copied, setCopied]             = useState(false);
  const [transformSummary, setTransformSummary] = useState<{ transformedCount: number; passedThroughCount: number } | null>(null);
  const [validationIssues, setValidationIssues] = useState<Array<{ severity: "error" | "warning"; message: string; path?: string }>>([]);
  const [reviewReport, setReviewReport] = useState<ReviewReport | null>(null);
  const [refineResult, setRefineResult] = useState<RefineResult | null>(null);
  const [refineBusy, setRefineBusy] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [hasAppliedRefine, setHasAppliedRefine] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  const fileInputRef   = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1280);

  useEffect(() => {
    fetch(`${API_BASE}/`, { cache: "no-store" })
      .then((r) => setApiOk(r.ok)).catch(() => setApiOk(false));
    fetch(`${API_BASE}/demo`, { cache: "no-store" })
      .then((r) => r.json())
      .then((p) => {
        const demos = Array.isArray(p?.demos) ? p.demos as string[] : [];
        if (demos.length > 0) {
          setDemoNames(demos);
          setDemoName((cur) => (demos.includes(cur) ? cur : demos[0] ?? "counter"));
        }
      })
      .catch(() => setDemoNames(["counter", "vault", "escrow", "staking"]));
  }, []);

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const folderCandidates = useMemo(() => {
    const paths = folderEntries.map((e) => e.path);
    const preferred = paths.filter((p) =>
      /(^|\/)(programs\/[^/]+\/src\/lib\.rs|program\/src\/lib\.rs|src\/lib\.rs|src\/main\.rs)$/.test(p)
    );
    return preferred.length > 0 ? preferred : paths.filter((p) => p.endsWith(".rs"));
  }, [folderEntries]);

  useEffect(() => {
    if (!folderCandidates.length) { setFolderCandidate(""); return; }
    setFolderCandidate((cur) => (folderCandidates.includes(cur) ? cur : folderCandidates[0] ?? ""));
  }, [folderCandidates]);

  const selectedFileContent = useMemo(() => {
    if (!activeFilePath) return "";
    return outputFiles.find((f) => f.path === activeFilePath)?.content ?? "";
  }, [activeFilePath, outputFiles]);

  const activeRefinePatch = refineResult?.patches.find((p) => p.filePath === activeFilePath) ?? refineResult?.patches[0] ?? null;
  const compareOriginalContent = activeRefinePatch?.originalContent ?? "";
  const comparePatchedContent = activeRefinePatch?.patchedContent ?? "";

  const activeContent =
    activePane === "ir"    ? irText :
    activePane === "files" ? selectedFileContent :
    singleFileCode;

  async function copyActiveContent() {
    if (!activeContent) return;
    await navigator.clipboard.writeText(activeContent).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function downloadSingleFile() {
    if (!singleFileCode) return;
    downloadBlob(`${programName}-${target}.rs`, new Blob([singleFileCode], { type: "text/plain;charset=utf-8" }));
  }

  function downloadProjectBundle() {
    if (!outputFiles.length) return;
    downloadBlob(`${programName}-${target}.tar`, makeTar(outputFiles));
  }

  async function handleLocalFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSourceText(text);
    setSourceLabel(file.name);
    setResolvedSource(text);
    setMode("file");
  }

  async function handleFolderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const entries = await Promise.all(
      files.filter((f) => f.name.endsWith(".rs")).map(async (f) => ({
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
        content: await f.text(),
      }))
    );
    setFolderEntries(entries);
    setSourceLabel(entries.length ? `${entries.length} Rust files loaded` : null);
    setMode("folder");
  }

  async function runPipeline() {
    // ── Wipe previous output immediately so editor goes blank ────────────────
    setIsRunning(true);
    setPipelineStage("resolving");
    setError(null);
    setSingleFileCode("");
    setIrText("");
    setOutputFiles([]);
    setActiveFilePath("");
    setProgramName("anvil-output");
    setWarnings([]);
    setValidationIssues([]);
    setTransformSummary(null);
    setReviewReport(null);
    setRefineResult(null);
    setRefineError(null);
    setHasAppliedRefine(false);
    setShowCompare(false);

    try {
      let parsed: ParseResponse;

      // ── Stage 1: Resolve / load input (advances when real fetch completes) ──
      if (mode === "demo") {
        const r = await fetch(`${API_BASE}/demo/${demoName}`, { cache: "no-store" });
        if (!r.ok) throw new Error("Failed to load demo source");
        const p = await r.json();
        parsed = { ir: p.ir, sourcePath: `${demoName}.rs`, candidates: null };
        setResolvedSource(typeof p.source === "string" ? p.source : null);

      } else if (mode === "source" || mode === "file") {
        const src = resolvedSource ?? sourceText;
        if (!src.trim()) throw new Error("Provide a Rust source file first");
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: src }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(p.details ?? p.error ?? "Parse failed");
        }
        parsed = await r.json() as ParseResponse;
        setResolvedSource(parsed.source ?? src);

      } else if (mode === "folder") {
        if (!folderCandidate) throw new Error("Choose a Rust entry file from the selected folder");
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: folderEntries, entryPath: folderCandidate }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(p.details ?? p.error ?? "Parse failed");
        }
        parsed = await r.json() as ParseResponse;
        parsed.sourcePath = folderCandidate;
        setResolvedSource(parsed.source ?? null);

      } else {
        if (!repoUrl.trim()) throw new Error("Enter a public GitHub repository URL");
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: repoUrl.trim(),
            repoRef: repoRef.trim() || undefined,
            repoSubpath: repoSubpath.trim() || undefined,
          }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({ error: "Repository parse failed" }));
          throw new Error(p.details ?? p.error ?? "Repository parse failed");
        }
        parsed = await r.json() as ParseResponse;
        setResolvedSource(parsed.source ?? null);
      }

      // ── Stage 2: IR ready — brief pause so the step is visible ─────────────
      setPipelineStage("parsing");
      await sleep(280);
      setIrText(JSON.stringify(parsed.ir, null, 2));

      // ── Stage 3: Emit ────────────────────────────────────────────────────────
      setPipelineStage("emitting");
      await sleep(220);
      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: parsed.ir, target, multiFile: true }),
      });
      if (!emitRes.ok) {
        const p = await emitRes.json().catch(() => ({ error: "Emit failed" }));
        throw new Error(p.details ?? p.error ?? "Emit failed");
      }
      const emitted = await emitRes.json() as EmitResponse;

      // ── Stage 4: Validate ────────────────────────────────────────────────────
      setPipelineStage("validating");
      await sleep(260);
      setSingleFileCode(emitted.code);
      setOutputFiles(emitted.files ?? []);
      setActiveFilePath(emitted.files?.[0]?.path ?? "");
      setProgramName(emitted.programName ?? "anvil-output");
      setWarnings(emitted.warnings ?? []);
      setTransformSummary(emitted.transformReport ?? null);
      setValidationIssues(emitted.validationIssues ?? []);
      setReviewReport(emitted.reviewReport ?? null);
      setActivePane("single");
      setApiOk(true);

      // ── Done ─────────────────────────────────────────────────────────────────
      await sleep(200);
      setPipelineStage("done");
    } catch (err) {
      setPipelineStage("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }


  /**
   * Single-click AI refine: re-emits with ?refine=1 so the backend
   * runs validation → 1 AI call → re-validation, all server-side.
   */
  async function runRefine() {
    if (!irText) { setRefineError("Run the deterministic pipeline first."); return; }
    const errors = validationIssues.filter((i) => i.severity === "error");
    if (errors.length === 0) { setRefineError("No validation errors to refine."); return; }

    try {
      setRefineBusy(true);
      setRefineError(null);
      setRefineResult(null);
      setHasAppliedRefine(false);

      const ir = JSON.parse(irText);
      const res = await fetch(`${API_BASE}/emit?refine=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir, target, multiFile: true }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({ error: "Refine failed" }));
        throw new Error(p.details ?? p.error ?? "Refine failed");
      }
      const emitted = await res.json() as EmitResponse;

      // If the backend refined, apply the result
      if (emitted.refined && emitted.refineResult) {
        setRefineResult(emitted.refineResult);
        // Update output to the refined version
        setSingleFileCode(emitted.code);
        setOutputFiles(emitted.files ?? []);
        setActiveFilePath(emitted.files?.[0]?.path ?? "");
        setWarnings(emitted.warnings ?? []);
        setValidationIssues(emitted.validationIssues ?? []);
        setReviewReport(emitted.reviewReport ?? null);
        setHasAppliedRefine(true);
        setShowCompare(true);
        setActivePane("files");
      } else {
        setRefineError("AI refine ran but no patches were accepted.");
      }
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefineBusy(false);
    }
  }

  function downloadDiagnostics() {
    const blob = new Blob([
      JSON.stringify({ refineResult }, null, 2),
    ], { type: "application/json;charset=utf-8" });
    downloadBlob(`${programName}-${target}-ai-diagnostics.json`, blob);
  }

  const tm = TARGET_META[target];
  const hasOutput = !!(singleFileCode || irText);
  const strictValidated = validationIssues.filter((issue) => issue.severity === "error").length === 0 && hasOutput;
  const isTablet = viewportWidth < 1100;
  const isMobile = viewportWidth < 760;
  const editorHeight = isMobile ? 420 : 560;

  return (
    <main style={{ minHeight: "100vh", background: C.bg, color: C.text }}>

      {/* Ambient bg */}
      <div style={{ position: "fixed", inset: 0, zIndex: -10, overflow: "hidden", pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: "-15%", right: "-5%",  width: "45%", height: "45%", background: "radial-gradient(circle, rgba(245,166,35,0.06) 0%, transparent 70%)" }} />
        <div style={{ position: "absolute", bottom: "10%", left: "-5%", width: "40%", height: "40%", background: "radial-gradient(circle, rgba(14,168,128,0.05) 0%, transparent 70%)"  }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,0.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.018) 1px,transparent 1px)", backgroundSize: "64px 64px" }} />
      </div>

      {/* Nav */}
      <nav style={{ borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, zIndex: 40, background: "rgba(13,15,26,0.88)", backdropFilter: "blur(16px)" }}>
        <div style={{ maxWidth: 1360, margin: "0 auto", padding: isMobile ? "10px 16px" : "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", minHeight: 58 }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: C.textSub, fontSize: 13, fontWeight: 600 }}>
              <ArrowLeft size={14} /> Home
            </Link>
            <div style={{ width: 1, height: 20, background: C.line }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #f5a623, #e8820a)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Sparkles size={15} style={{ color: "#fff" }} />
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: "0.1em", color: C.text }}>ANVIL</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 0 }}>Workbench</div>
              </div>
            </div>
          </div>
          {/* Right: API dot */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, padding: "5px 14px", borderRadius: 100, background: apiOk ? "rgba(14,168,128,0.08)" : "rgba(255,255,255,0.04)", border: `1px solid ${apiOk ? "rgba(14,168,128,0.22)" : C.cardBorder}` }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: apiOk ? C.teal : C.textDim }} />
            <span style={{ color: apiOk ? C.teal : C.textMuted, fontWeight: 600 }}>{apiOk ? "API live" : "API offline"}</span>
          </div>
        </div>
      </nav>

      <div style={{ maxWidth: 1360, margin: "0 auto", padding: isMobile ? "24px 16px 48px" : "32px 28px 64px" }}>

        {/* Page header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "4px 14px", borderRadius: 100, border: "1px solid rgba(245,166,35,0.22)", background: "rgba(245,166,35,0.07)", marginBottom: 14, fontSize: 12, color: C.amber, fontWeight: 700, letterSpacing: "0.12em" }}>
            <Zap size={11} /> ANVIL WORKBENCH
          </div>
          <h1 style={{ margin: 0, fontSize: "clamp(26px, 3vw, 38px)", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1, color: C.text }}>
            Parse, emit, and export generated Solana code
          </h1>
          <p style={{ fontSize: 14, color: C.textSub, marginTop: 10, lineHeight: 1.75 }}>
            Load a demo, paste source, upload a file or folder, or point at a public GitHub repo — then pick your target framework and compile.
          </p>
        </div>

        {/* Two-column layout */}
        <div style={{ display: "grid", gridTemplateColumns: isTablet ? "1fr" : "360px minmax(0,1fr)", gap: 20, alignItems: "start" }}>

          {/* ── LEFT: Input panel ───────────────────────────────────────── */}
          <div style={{ position: isTablet ? "static" : "sticky", top: 70, display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Input source card */}
            <Panel>
              <PanelHead icon={Layers3} title="Input source" />
              <div style={{ padding: "14px 14px 0" }}>
                {/* Mode tabs */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,minmax(0,1fr))" : isTablet ? "repeat(3,minmax(0,1fr))" : "repeat(5,minmax(0,1fr))", gap: 6, marginBottom: 16 }}>
                  {(Object.keys(MODE_META) as InputMode[]).map((m) => {
                    const { icon: Icon, label } = MODE_META[m];
                    const active = mode === m;
                    return (
                      <button key={m} onClick={() => setMode(m)} style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
                        padding: "10px 4px", borderRadius: 12, border: "1px solid",
                        background: active ? "rgba(245,166,35,0.1)" : "rgba(255,255,255,0.02)",
                        borderColor: active ? "rgba(245,166,35,0.35)" : C.cardBorder,
                        color: active ? C.amber : C.textMuted, cursor: "pointer",
                      }}>
                        <Icon size={15} />
                        <span style={{ fontSize: 11, fontWeight: 700 }}>{label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Mode content */}
                <div style={{ paddingBottom: 14 }}>
                  {mode === "demo" && (
                    <div>
                      <InputLabel>Demo program</InputLabel>
                      <select
                        value={demoName}
                        onChange={(e) => setDemoName(e.target.value)}
                        style={selectStyle}
                      >
                        {demoNames.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                  )}

                  {mode === "source" && (
                    <div>
                      <InputLabel>Paste Anchor source</InputLabel>
                      <textarea
                        value={sourceText}
                        onChange={(e) => setSourceText(e.target.value)}
                        placeholder="// Paste a single Anchor lib.rs here..."
                        style={{ ...inputBase, minHeight: 200, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
                      />
                    </div>
                  )}

                  {mode === "file" && (
                    <div>
                      <InputLabel>Local .rs file</InputLabel>
                      <ActionButton icon={Upload} label="Choose file" onClick={() => fileInputRef.current?.click()} />
                      <input ref={fileInputRef} type="file" accept=".rs" onChange={handleLocalFileChange} style={{ display: "none" }} />
                      <Hint>{sourceLabel ?? "No file selected"}</Hint>
                    </div>
                  )}

                  {mode === "folder" && (
                    <div>
                      <InputLabel>Local folder</InputLabel>
                      <ActionButton icon={FolderOpen} label="Choose folder" onClick={() => folderInputRef.current?.click()} />
                      <input
                        ref={folderInputRef} type="file" multiple onChange={handleFolderChange}
                        style={{ display: "none" }}
                        {...({ webkitdirectory: "true", directory: "true" } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
                      />
                      <Hint>{sourceLabel ?? "Upload a folder containing .rs files"}</Hint>
                      {folderCandidates.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <InputLabel>Entry file</InputLabel>
                          <select
                            value={folderCandidate}
                            onChange={(e) => setFolderCandidate(e.target.value)}
                            style={selectStyle}
                          >
                            {folderCandidates.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  )}

                  {mode === "repo" && (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div>
                        <InputLabel>Public GitHub repo URL</InputLabel>
                        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                          placeholder="https://github.com/org/repo or /tree/main/programs/app" style={inputBase} />
                      </div>
                      <div>
                        <InputLabel>Git ref <span style={{ color: C.textDim }}>(optional)</span></InputLabel>
                        <input value={repoRef} onChange={(e) => setRepoRef(e.target.value)}
                          placeholder="branch, tag or commit" style={inputBase} />
                      </div>
                      <div>
                        <InputLabel>Subpath <span style={{ color: C.textDim }}>(optional)</span></InputLabel>
                        <input value={repoSubpath} onChange={(e) => setRepoSubpath(e.target.value)}
                          placeholder="programs/my_program" style={inputBase} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            {/* Target framework card */}
            <Panel>
              <PanelHead icon={Rocket} title="Target framework" />
              <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {TARGETS.map((t) => {
                  const { color, label, tagline } = TARGET_META[t];
                  const active = target === t;
                  return (
                    <button key={t} onClick={() => setTarget(t)} style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
                      borderRadius: 12, border: "1px solid", textAlign: "left", cursor: "pointer",
                      background: active ? `${color}12` : "transparent",
                      borderColor: active ? `${color}45` : C.cardBorder,
                    }}>
                      <div style={{ width: 10, height: 10, borderRadius: "50%", background: active ? color : C.textDim, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: active ? C.text : C.textSub }}>{label}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{tagline}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Panel>

            <Panel>
              <PanelHead icon={Sparkles} title="AI Refine" />
              <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>
                  One-click AI fix for validation errors. Uses a single focused repair-model call with strict acceptance checks.
                </div>

                {/* Refine + Compare + Diagnostics */}
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
                  <button
                    onClick={() => void runRefine()}
                    disabled={refineBusy || !hasOutput || validationIssues.filter((i) => i.severity === "error").length === 0}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      padding: "12px 16px", borderRadius: 12, border: "none", cursor: refineBusy ? "default" : "pointer",
                      fontWeight: 800, fontSize: 14, transition: "all .2s",
                      background: refineBusy ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, rgba(107,123,255,0.9), rgba(14,168,128,0.9))",
                      color: refineBusy ? C.textMuted : "#fff",
                      opacity: (refineBusy || validationIssues.filter((i) => i.severity === "error").length === 0) ? 0.5 : 1,
                    }}
                  >
                    {refineBusy ? <><Loader2 size={14} className="animate-spin" /> Refining…</> : <><Sparkles size={14} /> ✨ Refine</>}
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <OutBtn
                      icon={Layers3}
                      label={showCompare ? "Hide Diff" : "Diff"}
                      onClick={() => setShowCompare((c) => !c)}
                      disabled={!refineResult}
                    />
                    <OutBtn
                      icon={Download}
                      label="JSON"
                      onClick={downloadDiagnostics}
                      disabled={!refineResult}
                    />
                  </div>
                </div>

                {/* Error */}
                {refineError && (
                  <div style={{ padding: 12, borderRadius: 12, background: "rgba(224,90,90,0.1)", border: "1px solid rgba(224,90,90,0.22)", color: "#ffb5b5", fontSize: 12, lineHeight: 1.5 }}>
                    {refineError}
                  </div>
                )}

                {/* Status badges */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Badge label="Strict Validated" active={strictValidated} color={C.teal} />
                  <Badge label="AI Refined" active={hasAppliedRefine} color={C.indigo} />
                </div>

                {/* Refine result summary */}
                {refineResult && (
                  <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: refineResult.patches.some((p) => p.accepted) ? C.teal : C.red, marginBottom: 6 }}>
                      {refineResult.summary}
                    </div>
                    <div style={{ fontSize: 11, color: C.textDim, marginBottom: 6 }}>
                      {refineResult.cached ? "Served from local AI cache" : refineResult.aiCallMade ? "Fresh AI call made" : "No new AI call made"}
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.6, marginBottom: 8 }}>
                      {refineResult.rationale}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
                      {refineResult.patches.map((patch) => (
                        <div
                          key={patch.filePath}
                          style={{
                            padding: "8px 10px", borderRadius: 10, fontSize: 12, cursor: "pointer",
                            border: `1px solid ${patch.accepted ? "rgba(14,168,128,0.3)" : "rgba(224,90,90,0.3)"}`,
                            background: patch.accepted ? "rgba(14,168,128,0.06)" : "rgba(224,90,90,0.06)",
                          }}
                          onClick={() => { setActivePane("files"); setActiveFilePath(patch.filePath); }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontFamily: "var(--font-mono, monospace)", color: C.text }}>{patch.filePath}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: patch.accepted ? C.teal : C.red }}>
                              {patch.accepted ? "✓ accepted" : "✗ rejected"}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{patch.acceptanceReason}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Panel>

            {/* Run button */}
            <button onClick={runPipeline} disabled={isRunning} style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              padding: "15px 20px", borderRadius: 14, border: "none", cursor: isRunning ? "default" : "pointer",
              fontWeight: 800, fontSize: 15, transition: "opacity .15s",
              background: isRunning ? "rgba(255,255,255,0.05)" : "linear-gradient(135deg, #f5a623, #e8820a)",
              color: isRunning ? C.textMuted : "#0a0600",
              opacity: isRunning ? 0.7 : 1,
            }}>
              {isRunning ? <><Loader2 size={16} className="animate-spin" /> Compiling…</> : <><Play size={16} /> Parse + Emit → {tm.label}</>}
            </button>

            {/* Error */}
            {error && (
              <div style={{ padding: 14, borderRadius: 14, background: "rgba(224,90,90,0.1)", border: "1px solid rgba(224,90,90,0.25)", color: "#ffaaaa", fontSize: 13, lineHeight: 1.6 }}>
                ⚠ {error}
              </div>
            )}

            {/* Transform summary */}
            {transformSummary && (
              <Panel>
                <div style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
                  <StatTile label="Transformed" value={transformSummary.transformedCount} color={C.teal} />
                  <StatTile label="Passed through" value={transformSummary.passedThroughCount} color={C.textSub} />
                </div>
              </Panel>
            )}
          </div>

          {/* ── RIGHT: Output panel ─────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>


            <Panel>
              {/* Output header */}
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.line}` }}>
                {/* Title row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>Generated output</div>
                    {hasOutput && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: C.textDim }}>·</span>
                        <span style={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", color: C.textMuted }}>{programName}</span>
                        <span style={{ fontSize: 12, color: C.textDim }}>→</span>
                        <span style={{ fontSize: 12, color: tm.color, fontWeight: 700 }}>{tm.label}</span>
                        {strictValidated && <span style={{ fontSize: 10, color: C.teal, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(14,168,128,0.1)", border: "1px solid rgba(14,168,128,0.2)" }}>✓ valid</span>}
                        {hasAppliedRefine && <span style={{ fontSize: 10, color: C.indigo, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(107,123,255,0.1)", border: "1px solid rgba(107,123,255,0.2)" }}>AI refined</span>}
                      </div>
                    )}
                  </div>
                  {/* Icon actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <IconBtn title={copied ? "Copied!" : "Copy"} onClick={copyActiveContent} disabled={!activeContent} active={copied}>
                      {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                    </IconBtn>
                    <IconBtn title="Download .rs" onClick={downloadSingleFile} disabled={!singleFileCode}>
                      <Download size={14} />
                    </IconBtn>
                    <IconBtn title="Download .tar" onClick={downloadProjectBundle} disabled={!outputFiles.length} primary>
                      <FileArchive size={14} />
                    </IconBtn>
                    {refineResult && (
                      <IconBtn title="Download AI diagnostics" onClick={downloadDiagnostics}>
                        <Sparkles size={14} />
                      </IconBtn>
                    )}
                  </div>
                </div>

                {/* Inline pipeline strip — only shown during/after a run */}
                {pipelineStage !== "idle" && (
                  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
                    {STAGES.map((s, i) => {
                      const cur = STAGE_ORDER[pipelineStage] ?? -1;
                      const isDone   = pipelineStage !== "error" && cur > i;
                      const isActive = pipelineStage !== "error" && cur === i;
                      const isErr    = pipelineStage === "error" && cur === i;
                      const dotColor = isDone ? C.teal : isActive ? C.amber : isErr ? "#e05a5a" : C.textDim;
                      return (
                        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, flex: i < STAGES.length - 1 ? "none" : undefined }}>
                          {/* Dot + label */}
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <div style={{
                              width: 6, height: 6, borderRadius: "50%",
                              background: dotColor,
                              boxShadow: isActive ? `0 0 6px ${C.amber}` : isDone ? `0 0 4px ${C.teal}55` : "none",
                              transition: "all 0.4s",
                              flexShrink: 0,
                            }} />
                            <span style={{
                              fontSize: 11, fontWeight: isActive ? 700 : 500,
                              color: isDone ? C.textMuted : isActive ? C.amber : isErr ? "#e05a5a" : C.textDim,
                              transition: "color 0.3s",
                              whiteSpace: "nowrap",
                            }}>
                              {isActive ? <>{s.label}<span style={{ display: "inline-block", animation: "pulse 1s infinite", opacity: 0.6 }}>…</span></> : s.label}
                            </span>
                          </div>
                          {/* Connector line */}
                          {i < STAGES.length - 1 && (
                            <div style={{
                              flex: 1, height: 1, minWidth: 12, maxWidth: 32,
                              background: isDone ? "rgba(14,168,128,0.4)" : "rgba(255,255,255,0.08)",
                              transition: "background 0.5s",
                            }} />
                          )}
                        </div>
                      );
                    })}
                    {pipelineStage === "error" && (
                      <span style={{ fontSize: 11, color: "#e05a5a", marginLeft: 4 }}>failed</span>
                    )}
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: 4, padding: "10px 20px 0", borderBottom: `1px solid ${C.line}`, overflowX: "auto" }}>
                <PaneTab active={activePane === "single"} onClick={() => setActivePane("single")} label="Single file" />
                <PaneTab active={activePane === "files"}  onClick={() => setActivePane("files")}  label={`Files (${outputFiles.length})`} />
                <PaneTab active={activePane === "ir"}     onClick={() => setActivePane("ir")}     label="IR" />
              </div>

              {/* Content: idle / loading / output */}
              {isRunning ? (
                // Real loading state — shows which stage is actually executing
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: editorHeight, gap: 20 }}>
                  {/* Progress bar */}
                  <div style={{ width: 220, height: 2, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      borderRadius: 2,
                      background: `linear-gradient(90deg, ${C.amber}, ${C.teal})`,
                      width: `${Math.max(6, ((STAGE_ORDER[pipelineStage] ?? 0) / (STAGES.length - 1)) * 100)}%`,
                      transition: "width 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
                    }} />
                  </div>
                  {/* Spinner + stage label */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Loader2 size={16} style={{ color: C.amber }} className="animate-spin" />
                    <span style={{ fontSize: 13, color: C.textSub, fontWeight: 600 }}>
                      {STAGES.find(s => s.id === pipelineStage)?.label ?? "Running"}
                    </span>
                    <span style={{ fontSize: 13, color: C.textDim }}>→ {tm.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.textDim }}>
                    {STAGES.find(s => s.id === pipelineStage)?.sublabel}
                  </div>
                </div>
              ) : !hasOutput ? (
                // Empty state
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: editorHeight, gap: 14 }}>
                  <TerminalSquare size={32} style={{ color: C.textDim }} />
                  <div style={{ fontSize: 14, color: C.textMuted }}>Click &quot;Parse + Emit&quot; to generate {tm.label} code</div>
                  <div style={{ fontSize: 12, color: C.textDim }}>Demo · Paste · File · Folder · GitHub repo</div>
                </div>
              ) : (
                <>
                  {showCompare && activeRefinePatch && (
                    <div style={{ borderBottom: `1px solid ${C.line}`, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr" }}>
                      <div style={{ borderRight: isMobile ? "none" : `1px solid ${C.line}` }}>
                        <div style={{ padding: "10px 14px", fontSize: 12, fontWeight: 700, color: C.textSub }}>Original</div>
                        <Editor height={`${Math.max(280, editorHeight / 2)}px`} language="rust" value={compareOriginalContent} theme="vs-dark" options={MONACO_OPTS} />
                      </div>
                      <div>
                        <div style={{ padding: "10px 14px", fontSize: 12, fontWeight: 700, color: activeRefinePatch.accepted ? C.teal : C.red }}>
                          AI Refined
                        </div>
                        <Editor height={`${Math.max(280, editorHeight / 2)}px`} language="rust" value={comparePatchedContent} theme="vs-dark" options={MONACO_OPTS} />
                      </div>
                    </div>
                  )}

                  {/* Single file tab */}
                  {activePane === "single" && (
                    <div style={{ height: editorHeight }}>
                      <Editor
                        height={`${editorHeight}px`}
                        language="rust"
                        value={singleFileCode}
                        theme="vs-dark"
                        options={MONACO_OPTS}
                      />
                    </div>
                  )}

                  {/* File tree tab */}
                  {activePane === "files" && (
                    outputFiles.length === 0 ? (
                      <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
                        No multi-file output yet. Run the pipeline first.
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "260px minmax(0,1fr)" }}>
                        {/* File tree sidebar */}
                        <div style={{ borderRight: isMobile ? "none" : `1px solid ${C.line}`, borderBottom: isMobile ? `1px solid ${C.line}` : "none", overflowY: "auto", maxHeight: isMobile ? 180 : editorHeight }}>
                          {outputFiles.map((f) => (
                            <button key={f.path} onClick={() => setActiveFilePath(f.path)} style={{
                              width: "100%", textAlign: "left", padding: "11px 16px",
                              border: "none", borderBottom: `1px solid ${C.line}`, cursor: "pointer",
                              display: "flex", alignItems: "center", gap: 10, fontSize: 12,
                              background: activeFilePath === f.path ? `${tm.color}15` : "transparent",
                              color: activeFilePath === f.path ? C.text : C.textSub,
                              fontFamily: "var(--font-mono, monospace)",
                            }}>
                              <FileCode2 size={13} style={{ color: activeFilePath === f.path ? tm.color : C.textDim, flexShrink: 0 }} />
                              {f.path}
                            </button>
                          ))}
                        </div>
                        {/* Editor */}
                        <div style={{ height: editorHeight }}>
                          <Editor
                            height={`${editorHeight}px`}
                            language="rust"
                            value={selectedFileContent}
                            theme="vs-dark"
                            options={MONACO_OPTS}
                          />
                        </div>
                      </div>
                    )
                  )}

                  {/* IR tab */}
                  {activePane === "ir" && (
                    <div style={{ height: editorHeight }}>
                      <Editor
                        height={`${editorHeight}px`}
                        language="json"
                        value={irText}
                        theme="vs-dark"
                        options={MONACO_OPTS}
                      />
                    </div>
                  )}
                </>
              )}
            </Panel>

            {/* Warnings */}
            {warnings.length > 0 && (
              <Panel>
                <div style={{ padding: "14px 20px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.amberLight, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                    <Zap size={13} /> {warnings.length} warning{warnings.length > 1 ? "s" : ""}
                  </div>
                  {warnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 12, color: "#e8d68a", marginBottom: 6, paddingLeft: 6, borderLeft: `2px solid ${C.amber}`, lineHeight: 1.6 }}>{w}</div>
                  ))}
                </div>
              </Panel>
            )}

            {validationIssues.length > 0 && (
              <Panel>
                <div style={{ padding: "14px 20px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: strictValidated ? C.teal : C.red, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                    <CheckCircle2 size={13} /> Validation issues ({validationIssues.length})
                  </div>
                  {validationIssues.map((issue, index) => (
                    <div key={`${issue.path ?? "root"}-${index}`} style={{
                      fontSize: 12,
                      color: issue.severity === "error" ? "#ffb0b0" : "#e8d68a",
                      marginBottom: 6,
                      paddingLeft: 6,
                      borderLeft: `2px solid ${issue.severity === "error" ? C.red : C.amber}`,
                      lineHeight: 1.6,
                    }}>
                      {issue.path ? `${issue.path}: ` : ""}{issue.message}
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {reviewReport && (
              <Panel>
                <div style={{ padding: "14px 20px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: reviewReport.requiresAI ? C.amberLight : C.teal, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                    <Sparkles size={13} /> Deterministic review
                  </div>
                  <div style={{ fontSize: 12, color: C.textSub, marginBottom: 8, lineHeight: 1.6 }}>{reviewReport.summary}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.6 }}>{reviewReport.recommendedAction}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {reviewReport.findings.map((finding, index) => (
                      <div key={`${finding.path ?? "root"}-${index}`} style={{ paddingLeft: 8, borderLeft: `2px solid ${finding.severity === "error" ? C.red : C.amber}` }}>
                        <div style={{ fontSize: 12, color: finding.severity === "error" ? "#ffb0b0" : "#e8d68a", lineHeight: 1.6 }}>
                          {finding.path ? `${finding.path}: ` : ""}{finding.message}
                        </div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, lineHeight: 1.6 }}>
                          Fix: {finding.suggestedFix}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Panel>
            )}

            {/* Capability card */}
            <Panel>
              <div style={{ padding: "16px 20px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", color: C.textDim, marginBottom: 12 }}>WHAT&apos;S SUPPORTED</div>
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
                  {[
                    "Demo programs (counter, vault, escrow, staking, perp)",
                    "Paste raw Anchor source",
                    "Upload a local .rs file",
                    "Upload a local folder — pick entry",
                    "GitHub public repo URL, tree URL, or blob URL + optional ref/subpath",
                    "Deterministic review with suggested fixes before any AI call",
                    "Single-click AI refine with local cache (0-1 fresh model calls)",
                    "Download single combined .rs file",
                    "Download whole generated codebase as .tar",
                    "Browse multi-file output in file tree",
                  ].map((c) => (
                    <div key={c} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>
                      <CheckCircle2 size={12} style={{ color: C.teal, flexShrink: 0, marginTop: 3 }} />
                      {c}
                    </div>
                  ))}
                </div>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ borderRadius: 18, border: `1px solid ${C.cardBorder}`, background: C.card, overflow: "hidden" }}>
      {children}
    </div>
  );
}

function PanelHead({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
      <Icon size={14} style={{ color: C.amber }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: C.textSub }}>{title}</span>
    </div>
  );
}

function InputLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: C.textSub, marginBottom: 8 }}>{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 8, fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>{children}</div>;
}

function ActionButton({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10,
      border: `1px solid ${C.cardBorder}`, background: "rgba(255,255,255,0.03)",
      color: C.textSub, fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%",
    }}>
      <Icon size={14} style={{ color: C.amber }} /> {label}
    </button>
  );
}

function PaneTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 16px", borderRadius: "8px 8px 0 0", fontSize: 13, fontWeight: 600,
      cursor: "pointer", border: "none", marginBottom: -1,
      background: active ? C.card : "transparent",
      color: active ? C.text : C.textSub,
      borderBottom: active ? `2px solid ${C.amber}` : "2px solid transparent",
    }}>
      {label}
    </button>
  );
}

function OutBtn({
  icon: Icon, label, onClick, disabled, active, primary,
}: {
  icon: React.ElementType; label: string; onClick: () => void;
  disabled?: boolean; active?: boolean; primary?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", alignItems: "center", gap: 7, padding: "8px 14px",
      borderRadius: 10, border: `1px solid ${primary ? "rgba(245,166,35,0.35)" : C.cardBorder}`,
      background: primary ? "rgba(245,166,35,0.1)" : active ? "rgba(14,168,128,0.1)" : "rgba(255,255,255,0.03)",
      color: primary ? C.amber : active ? C.teal : disabled ? C.textDim : C.textSub,
      fontSize: 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
    }}>
      <Icon size={13} /> {label}
    </button>
  );
}

function IconBtn({
  children, onClick, disabled, active, primary, title,
}: {
  children: React.ReactNode; onClick: () => void; title?: string;
  disabled?: boolean; active?: boolean; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 30, height: 30, borderRadius: 8, border: `1px solid ${primary ? "rgba(245,166,35,0.3)" : C.cardBorder}`,
        background: primary ? "rgba(245,166,35,0.1)" : active ? "rgba(14,168,128,0.1)" : "rgba(255,255,255,0.03)",
        color: primary ? C.amber : active ? C.teal : disabled ? C.textDim : C.textSub,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.15s",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function Badge({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 10px",
      borderRadius: 999,
      border: `1px solid ${active ? `${color}55` : C.cardBorder}`,
      background: active ? `${color}18` : "rgba(255,255,255,0.03)",
      color: active ? color : C.textMuted,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    }}>
      {label}
    </span>
  );
}

function StatTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center", padding: "8px 0" }}>
      <div style={{ fontSize: 26, fontWeight: 800, color, letterSpacing: "-0.03em", fontFamily: "var(--font-mono, monospace)" }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ─── Shared inline styles ─────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width: "100%", borderRadius: 12, border: `1px solid ${C.cardBorder}`,
  background: "rgba(255,255,255,0.03)", color: C.text,
  padding: "10px 12px", fontSize: 13, outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = {
  ...inputBase, 
  cursor: "pointer",
  backgroundColor: C.card, // Overrides transparent inputBase to give dropdown options a readable background
};
