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

type ParseResponse = {
  ir: unknown;
  sourcePath: string | null;
  candidates: string[] | null;
  repoUrl?: string | null;
};

type EmitFile = { path: string; content: string };

type EmitResponse = {
  code: string;
  files?: EmitFile[];
  warnings?: string[];
  programName?: string;
  target: Target;
  transformReport?: { transformedCount: number; passedThroughCount: number };
};

type FolderEntry = { path: string; content: string };

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

  const fileInputRef   = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

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

  const folderCandidates = useMemo(() => {
    const paths = folderEntries.map((e) => e.path);
    const preferred = paths.filter((p) =>
      /(^|\/)( programs\/[^/]+\/src\/lib\.rs|program\/src\/lib\.rs|src\/lib\.rs|src\/main\.rs)$/.test(p)
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

  const activeContent =
    activePane === "ir"    ? irText :
    activePane === "files" ? selectedFileContent :
    singleFileCode;

  const activeLanguage =
    activePane === "ir" ? "json" : "rust";

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
    setIsRunning(true);
    setError(null);
    setWarnings([]);

    try {
      let parsed: ParseResponse;

      if (mode === "demo") {
        const r = await fetch(`${API_BASE}/demo/${demoName}`, { cache: "no-store" });
        if (!r.ok) throw new Error("Failed to load demo source");
        const p = await r.json();
        parsed = { ir: p.ir, sourcePath: `${demoName}.rs`, candidates: null };

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

                  } else if (mode === "folder") {
        if (!folderCandidate) throw new Error("Choose a Rust entry file from the selected folder");
        const r = await fetch(`${API_BASE}/parse`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: folderEntries,
            entryPath: folderCandidate,
          }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(p.details ?? p.error ?? "Parse failed");
        }
        parsed = await r.json() as ParseResponse;
        parsed.sourcePath = folderCandidate;

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
      }

      setIrText(JSON.stringify(parsed.ir, null, 2));

      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: parsed.ir, target, multiFile: true }),
      });
      if (!emitRes.ok) {
        const p = await emitRes.json().catch(() => ({ error: "Emit failed" }));
        throw new Error(p.details ?? p.error ?? "Emit failed");
      }
      const emitted = await emitRes.json() as EmitResponse;
      setSingleFileCode(emitted.code);
      setOutputFiles(emitted.files ?? []);
      setActiveFilePath(emitted.files?.[0]?.path ?? "");
      setProgramName(emitted.programName ?? "anvil-output");
      setWarnings(emitted.warnings ?? []);
      setTransformSummary(emitted.transformReport ?? null);
      setActivePane("single");
      setApiOk(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }

  const tm = TARGET_META[target];
  const hasOutput = !!(singleFileCode || irText);

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
        <div style={{ maxWidth: 1360, margin: "0 auto", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 58 }}>
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

      <div style={{ maxWidth: 1360, margin: "0 auto", padding: "32px 28px 64px" }}>

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
        <div style={{ display: "grid", gridTemplateColumns: "360px minmax(0,1fr)", gap: 20, alignItems: "start" }}>

          {/* ── LEFT: Input panel ───────────────────────────────────────── */}
          <div style={{ position: "sticky", top: 70, display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Input source card */}
            <Panel>
              <PanelHead icon={Layers3} title="Input source" />
              <div style={{ padding: "14px 14px 0" }}>
                {/* Mode tabs */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 6, marginBottom: 16 }}>
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
                          placeholder="https://github.com/org/repo" style={inputBase} />
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
                <div style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
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
              <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>Generated output</div>
                  <div style={{ fontSize: 13, color: C.textSub, marginTop: 3, display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{programName}</span>
                    <span style={{ color: C.textDim }}>→</span>
                    <span style={{ color: tm.color, fontWeight: 700 }}>{tm.label}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <OutBtn icon={Copy} label={copied ? "Copied!" : "Copy"} onClick={copyActiveContent} disabled={!activeContent} active={copied} />
                  <OutBtn icon={Download} label="Download .rs" onClick={downloadSingleFile} disabled={!singleFileCode} />
                  <OutBtn icon={FileArchive} label="Download .tar" onClick={downloadProjectBundle} disabled={!outputFiles.length} primary />
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: 4, padding: "12px 20px 0", borderBottom: `1px solid ${C.line}` }}>
                <PaneTab active={activePane === "single"} onClick={() => setActivePane("single")} label="Single file" />
                <PaneTab active={activePane === "files"}  onClick={() => setActivePane("files")}  label={`File tree (${outputFiles.length})`} />
                <PaneTab active={activePane === "ir"}     onClick={() => setActivePane("ir")}     label="IR (JSON)" />
              </div>

              {/* Content */}
              {!hasOutput && !isRunning ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 480, gap: 14 }}>
                  <TerminalSquare size={36} style={{ color: C.textDim }} />
                  <div style={{ fontSize: 14, color: C.textMuted }}>Click "Parse + Emit" to generate {tm.label} code</div>
                  <div style={{ fontSize: 12, color: C.textDim }}>Supports demo, paste, file upload, folder upload, and GitHub repo</div>
                </div>
              ) : isRunning && !hasOutput ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 480, gap: 14 }}>
                  <Loader2 size={32} style={{ color: C.amber }} className="animate-spin" />
                  <div style={{ fontSize: 14, color: C.textSub }}>Compiling → {tm.label}…</div>
                </div>
              ) : (
                <>
                  {/* Single file tab */}
                  {activePane === "single" && (
                    <div style={{ height: 560 }}>
                      <Editor
                        height="560px"
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
                      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)" }}>
                        {/* File tree sidebar */}
                        <div style={{ borderRight: `1px solid ${C.line}`, overflowY: "auto", maxHeight: 560 }}>
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
                        <div style={{ height: 560 }}>
                          <Editor
                            height="560px"
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
                    <div style={{ height: 560 }}>
                      <Editor
                        height="560px"
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

            {/* Capability card */}
            <Panel>
              <div style={{ padding: "16px 20px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", color: C.textDim, marginBottom: 12 }}>WHAT'S SUPPORTED</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    "Demo programs (counter, vault)",
                    "Paste raw Anchor source",
                    "Upload a local .rs file",
                    "Upload a local folder — pick entry",
                    "GitHub public repo URL + optional ref/subpath",
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
