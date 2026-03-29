"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  FolderOpen,
  Loader2,
  Play,
  Upload,
} from "lucide-react";

type Target = "pinocchio" | "quasar" | "native";
type InputMode = "demo" | "source" | "file" | "folder" | "repo";

type ParseResponse = {
  ir: unknown;
  sourcePath: string | null;
  candidates: string[] | null;
  repoUrl?: string | null;
};

type EmitFile = {
  path: string;
  content: string;
};

type EmitResponse = {
  code: string;
  files?: EmitFile[];
  warnings?: string[];
  programName?: string;
  target: Target;
  transformReport?: {
    transformedCount: number;
    passedThroughCount: number;
  };
};

type FolderEntry = {
  path: string;
  content: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const TARGETS: Target[] = ["pinocchio", "quasar", "native"];
const inputBaseStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.03)",
  color: "#eef2ff",
  padding: "12px 14px",
  fontSize: 14,
  outline: "none",
};

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeString(buffer: Uint8Array, offset: number, length: number, value: string) {
  const bytes = new TextEncoder().encode(value.slice(0, length));
  buffer.set(bytes, offset);
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function makeTar(files: EmitFile[]): Blob {
  const chunks: BlobPart[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const file of files) {
    const content = new TextEncoder().encode(file.content);
    const header = new Uint8Array(512);

    writeString(header, 0, 100, file.path);
    writeString(header, 100, 8, octal(0o644, 8));
    writeString(header, 108, 8, octal(0, 8));
    writeString(header, 116, 8, octal(0, 8));
    writeString(header, 124, 12, octal(content.length, 12));
    writeString(header, 136, 12, octal(now, 12));
    writeString(header, 148, 8, "        ");
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");

    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeString(header, 148, 8, octal(checksum, 8).replace(/\0$/, " "));

    chunks.push(toArrayBuffer(header), toArrayBuffer(content));

    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(toArrayBuffer(new Uint8Array(padding)));
  }

  chunks.push(toArrayBuffer(new Uint8Array(1024)));
  return new Blob(chunks, { type: "application/x-tar" });
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>("demo");
  const [target, setTarget] = useState<Target>("pinocchio");
  const [apiOk, setApiOk] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [demoNames, setDemoNames] = useState<string[]>([]);
  const [demoName, setDemoName] = useState("counter");

  const [sourceText, setSourceText] = useState("");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [folderCandidate, setFolderCandidate] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [repoSubpath, setRepoSubpath] = useState("");

  const [irText, setIrText] = useState("");
  const [singleFileCode, setSingleFileCode] = useState("");
  const [outputFiles, setOutputFiles] = useState<EmitFile[]>([]);
  const [programName, setProgramName] = useState("anvil-output");
  const [activePane, setActivePane] = useState<"single" | "ir" | "files">("single");
  const [activeFilePath, setActiveFilePath] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [transformSummary, setTransformSummary] = useState<{ transformedCount: number; passedThroughCount: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/`, { cache: "no-store" })
      .then((res) => setApiOk(res.ok))
      .catch(() => setApiOk(false));

    fetch(`${API_BASE}/demo`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        const demos = Array.isArray(payload?.demos) ? payload.demos as string[] : [];
        if (demos.length > 0) {
          setDemoNames(demos);
          setDemoName((current) => (demos.includes(current) ? current : demos[0] ?? "counter"));
        }
      })
      .catch(() => {
        setDemoNames(["counter", "vault", "escrow", "staking", "marketplace", "amm"]);
      });
  }, []);

  const folderCandidates = useMemo(() => {
    const paths = folderEntries.map((entry) => entry.path);
    const preferred = paths.filter((path) =>
      /(^|\/)(programs\/[^/]+\/src\/lib\.rs|program\/src\/lib\.rs|src\/lib\.rs|src\/main\.rs)$/.test(path)
    );
    return preferred.length > 0 ? preferred : paths.filter((path) => path.endsWith(".rs"));
  }, [folderEntries]);

  useEffect(() => {
    if (!folderCandidates.length) {
      setFolderCandidate("");
      return;
    }
    setFolderCandidate((current) => (folderCandidates.includes(current) ? current : folderCandidates[0] ?? ""));
  }, [folderCandidates]);

  const selectedFileContent = useMemo(() => {
    if (!activeFilePath) return "";
    return outputFiles.find((file) => file.path === activeFilePath)?.content ?? "";
  }, [activeFilePath, outputFiles]);

  const activeContent = activePane === "ir"
    ? irText
    : activePane === "files"
      ? selectedFileContent
      : singleFileCode;

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

  async function handleLocalFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSourceText(text);
    setSourceLabel(file.name);
    setMode("file");
  }

  async function handleFolderChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const entries = await Promise.all(files
      .filter((file) => file.name.endsWith(".rs"))
      .map(async (file) => ({
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        content: await file.text(),
      })));
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
        const demoRes = await fetch(`${API_BASE}/demo/${demoName}`, { cache: "no-store" });
        if (!demoRes.ok) throw new Error("Failed to load demo source");
        const demoPayload = await demoRes.json();
        parsed = {
          ir: demoPayload.ir,
          sourcePath: `${demoName}.rs`,
          candidates: null,
        };
      } else if (mode === "source" || mode === "file") {
        if (!sourceText.trim()) throw new Error("Provide a Rust source file first");
        const parseRes = await fetch(`${API_BASE}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: sourceText }),
        });
        if (!parseRes.ok) {
          const payload = await parseRes.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(payload.details ?? payload.error ?? "Parse failed");
        }
        parsed = await parseRes.json() as ParseResponse;
      } else if (mode === "folder") {
        if (!folderCandidate) throw new Error("Choose a Rust entry file from the selected folder");
        const chosen = folderEntries.find((entry) => entry.path === folderCandidate);
        if (!chosen) throw new Error("Selected folder entry could not be read");
        const parseRes = await fetch(`${API_BASE}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: chosen.content }),
        });
        if (!parseRes.ok) {
          const payload = await parseRes.json().catch(() => ({ error: "Parse failed" }));
          throw new Error(payload.details ?? payload.error ?? "Parse failed");
        }
        parsed = await parseRes.json() as ParseResponse;
        parsed.sourcePath = folderCandidate;
      } else {
        if (!repoUrl.trim()) throw new Error("Enter a public Git repository URL");
        const parseRes = await fetch(`${API_BASE}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: repoUrl.trim(),
            repoRef: repoRef.trim() || undefined,
            repoSubpath: repoSubpath.trim() || undefined,
          }),
        });
        if (!parseRes.ok) {
          const payload = await parseRes.json().catch(() => ({ error: "Repository parse failed" }));
          throw new Error(payload.details ?? payload.error ?? "Repository parse failed");
        }
        parsed = await parseRes.json() as ParseResponse;
      }

      setIrText(JSON.stringify(parsed.ir, null, 2));

      const emitRes = await fetch(`${API_BASE}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir: parsed.ir,
          target,
          multiFile: true,
        }),
      });
      if (!emitRes.ok) {
        const payload = await emitRes.json().catch(() => ({ error: "Emit failed" }));
        throw new Error(payload.details ?? payload.error ?? "Emit failed");
      }

      const emitted = await emitRes.json() as EmitResponse;
      setSingleFileCode(emitted.code);
      setOutputFiles(emitted.files ?? []);
      setActiveFilePath(emitted.files?.[0]?.path ?? "");
      setProgramName(emitted.programName ?? "anvil-output");
      setWarnings(emitted.warnings ?? []);
      setTransformSummary(emitted.transformReport ?? null);
      setActivePane("single");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0a0d16", color: "#eef2ff" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "32px 24px 56px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 28 }}>
          <div>
            <div style={{ fontSize: 13, letterSpacing: "0.18em", color: "#f5b25d", fontWeight: 700 }}>ANVIL WORKBENCH</div>
            <h1 style={{ margin: "8px 0 0", fontSize: 40, lineHeight: 1.05 }}>Parse, emit, preview, and export generated Solana code</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: apiOk ? "#6ee7b7" : "#fda4af", fontSize: 13 }}>
            <CheckCircle2 size={15} />
            API {apiOk ? "connected" : "offline"}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "380px minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
          <section style={{ border: "1px solid rgba(255,255,255,0.09)", borderRadius: 24, background: "rgba(255,255,255,0.03)", padding: 20, position: "sticky", top: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Input</div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 16 }}>
              {(["demo", "source", "file", "folder", "repo"] as InputMode[]).map((value) => (
                <button
                  key={value}
                  onClick={() => setMode(value)}
                  style={{
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.09)",
                    background: mode === value ? "linear-gradient(135deg, #f59e0b, #fb7185)" : "rgba(255,255,255,0.02)",
                    color: "#fff",
                    padding: "10px 8px",
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: "capitalize",
                    cursor: "pointer",
                  }}
                >
                  {value}
                </button>
              ))}
            </div>

            {mode === "demo" && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Demo program</label>
                <select value={demoName} onChange={(e) => setDemoName(e.target.value)} style={inputBaseStyle}>
                  {demoNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            )}

            {mode === "source" && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Anchor source</label>
                <textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="Paste a single Anchor lib.rs here..."
                  style={{ ...inputBaseStyle, minHeight: 220, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
                />
              </div>
            )}

            {mode === "file" && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Local Rust file</label>
                <button onClick={() => fileInputRef.current?.click()} style={actionButtonStyle("#334155")}>
                  <Upload size={15} /> Choose `.rs` file
                </button>
                <input ref={fileInputRef} type="file" accept=".rs" onChange={handleLocalFileChange} style={{ display: "none" }} />
                <FieldHint value={sourceLabel ?? "No file selected yet"} />
              </div>
            )}

            {mode === "folder" && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Local folder upload</label>
                <button onClick={() => folderInputRef.current?.click()} style={actionButtonStyle("#334155")}>
                  <FolderOpen size={15} /> Choose folder
                </button>
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  onChange={handleFolderChange}
                  style={{ display: "none" }}
                  {...({ webkitdirectory: "true", directory: "true" } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
                />
                <FieldHint value={sourceLabel ?? "Upload a folder that contains one or more Rust entry files"} />
                {folderCandidates.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Entry file</label>
                    <select value={folderCandidate} onChange={(e) => setFolderCandidate(e.target.value)} style={inputBaseStyle}>
                      {folderCandidates.map((path) => <option key={path} value={path}>{path}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {mode === "repo" && (
              <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Public Git repository URL</label>
                  <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" style={inputBaseStyle} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Git ref</label>
                  <input value={repoRef} onChange={(e) => setRepoRef(e.target.value)} placeholder="branch, tag, or commit (optional)" style={inputBaseStyle} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Repo subpath</label>
                  <input value={repoSubpath} onChange={(e) => setRepoSubpath(e.target.value)} placeholder="programs/my_program (optional)" style={inputBaseStyle} />
                </div>
              </div>
            )}

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: "block", fontSize: 13, color: "#a5b0cc", marginBottom: 8 }}>Target</label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {TARGETS.map((value) => (
                  <button
                    key={value}
                    onClick={() => setTarget(value)}
                    style={{
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.09)",
                      background: target === value ? "rgba(59,130,246,0.18)" : "rgba(255,255,255,0.02)",
                      color: "#fff",
                      padding: "11px 10px",
                      fontWeight: 700,
                      cursor: "pointer",
                      textTransform: "capitalize",
                    }}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={runPipeline}
              disabled={isRunning}
              style={{
                width: "100%",
                border: "none",
                borderRadius: 16,
                padding: "14px 16px",
                background: "linear-gradient(135deg, #f59e0b, #fb7185)",
                color: "#fff",
                fontSize: 15,
                fontWeight: 800,
                cursor: isRunning ? "wait" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
              }}
            >
              {isRunning ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />}
              {isRunning ? "Running..." : "Parse + Emit"}
            </button>

            {error && (
              <div style={{ marginTop: 14, borderRadius: 14, padding: 12, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(248,113,113,0.24)", color: "#fecaca", fontSize: 13 }}>
                {error}
              </div>
            )}

            {transformSummary && (
              <div style={{ marginTop: 14, borderRadius: 14, padding: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", fontSize: 13, color: "#cbd5e1" }}>
                <div>Transformed: {transformSummary.transformedCount}</div>
                <div>Passed through: {transformSummary.passedThroughCount}</div>
              </div>
            )}
          </section>

          <section style={{ display: "grid", gap: 18 }}>
            <div style={{ border: "1px solid rgba(255,255,255,0.09)", borderRadius: 24, background: "rgba(255,255,255,0.03)", padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Generated output</div>
                  <div style={{ fontSize: 13, color: "#8da0c2", marginTop: 4 }}>{programName} → {target}</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={copyActiveContent} disabled={!activeContent} style={actionButtonStyle("#1e293b")}>
                    <Copy size={14} /> {copied ? "Copied" : "Copy active"}
                  </button>
                  <button onClick={downloadSingleFile} disabled={!singleFileCode} style={actionButtonStyle("#1e293b")}>
                    <Download size={14} /> Single file
                  </button>
                  <button onClick={downloadProjectBundle} disabled={!outputFiles.length} style={actionButtonStyle("#1e293b")}>
                    <FileArchive size={14} /> Whole codebase
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                <TabButton active={activePane === "single"} onClick={() => setActivePane("single")} label="Single file" />
                <TabButton active={activePane === "files"} onClick={() => setActivePane("files")} label={`Generated files (${outputFiles.length})`} />
                <TabButton active={activePane === "ir"} onClick={() => setActivePane("ir")} label="IR" />
              </div>

              {activePane === "files" && outputFiles.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: 14 }}>
                  <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.08)", overflow: "hidden", maxHeight: 540, overflowY: "auto" }}>
                    {outputFiles.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => setActiveFilePath(file.path)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "12px 14px",
                          border: "none",
                          borderBottom: "1px solid rgba(255,255,255,0.06)",
                          background: activeFilePath === file.path ? "rgba(59,130,246,0.18)" : "transparent",
                          color: "#eef2ff",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          fontSize: 13,
                        }}
                      >
                        <FileCode2 size={14} />
                        {file.path}
                      </button>
                    ))}
                  </div>
                  <CodePane content={selectedFileContent} />
                </div>
              )}

              {activePane === "single" && <CodePane content={singleFileCode} />}
              {activePane === "ir" && <CodePane content={irText} />}
            </div>

            {warnings.length > 0 && (
              <div style={{ border: "1px solid rgba(250,204,21,0.18)", borderRadius: 20, background: "rgba(250,204,21,0.06)", padding: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Warnings</div>
                {warnings.map((warning) => (
                  <div key={warning} style={{ fontSize: 13, color: "#fde68a", marginBottom: 8 }}>{warning}</div>
                ))}
              </div>
            )}

            <div style={{ border: "1px solid rgba(255,255,255,0.09)", borderRadius: 20, background: "rgba(255,255,255,0.02)", padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>What’s covered now</div>
              <div style={{ display: "grid", gap: 8, fontSize: 13, color: "#b8c3da" }}>
                <div>Demo mode for built-in examples from the API.</div>
                <div>Paste raw Anchor source and emit it directly.</div>
                <div>Select a local `.rs` file or upload a local folder and choose the entry file.</div>
                <div>Public Git repo URL parsing with optional ref and subpath.</div>
                <div>Download the combined single file or the whole generated codebase as a tar archive.</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.08)",
        background: active ? "rgba(59,130,246,0.18)" : "rgba(255,255,255,0.03)",
        color: "#fff",
        padding: "10px 12px",
        fontSize: 13,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function FieldHint({ value }: { value: string }) {
  return <div style={{ marginTop: 10, fontSize: 12, color: "#8da0c2" }}>{value}</div>;
}

function CodePane({ content }: { content: string }) {
  return (
    <pre
      style={{
        margin: 0,
        minHeight: 540,
        maxHeight: 540,
        overflow: "auto",
        borderRadius: 18,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "#0b1020",
        padding: 16,
        color: "#dbe7ff",
        fontSize: 12.5,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {content || "Run the pipeline to preview the generated code, IR, and file tree."}
    </pre>
  );
}

function actionButtonStyle(background: string): React.CSSProperties {
  return {
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.08)",
    background,
    color: "#fff",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 8,
  };
}
