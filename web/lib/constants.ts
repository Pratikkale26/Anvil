import {
  Code2,
  FileCode2,
  FolderOpen,
  GitBranch,
  PlayCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Target = "pinocchio" | "quasar" | "native";
export type InputMode = "demo" | "source" | "file" | "folder" | "repo";
export type PipelineStage =
  | "idle"
  | "resolving"
  | "parsing"
  | "emitting"
  | "validating"
  | "done"
  | "error";

export type ParseResponse = {
  ir: unknown;
  sourcePath: string | null;
  candidates: string[] | null;
  repoUrl?: string | null;
  source?: string | null;
};

export type EmitFile = { path: string; content: string };

export type EmitResponse = {
  code: string;
  files?: EmitFile[];
  warnings?: string[];
  programName?: string;
  target: Target;
  transformReport?: { transformedCount: number; passedThroughCount: number };
  validationIssues?: Array<{
    severity: "error" | "warning";
    message: string;
    path?: string;
  }>;
  reviewReport?: ReviewReport;
  refined?: boolean;
  refineResult?: RefineResult;
};

export type FolderEntry = { path: string; content: string };

export type RefinePatch = {
  filePath: string;
  originalContent: string;
  patchedContent: string;
  accepted: boolean;
  acceptanceReason: string;
};

export type ReviewFinding = {
  severity: "error" | "warning";
  path?: string;
  message: string;
  suggestedFix: string;
};

export type ReviewReport = {
  summary: string;
  findings: ReviewFinding[];
  requiresAI: boolean;
  recommendedAction: string;
};

export type RefineResult = {
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

export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
  path?: string;
};

// ─── Color palette ────────────────────────────────────────────────────────────

export const C = {
  bg: "#0d0f1a",
  card: "#131520",
  cardBorder: "rgba(255,255,255,0.09)",
  card2: "#0f1119",
  text: "#e8ecf4",
  textSub: "#9095b0",
  textMuted: "#5c6080",
  textDim: "#3e4260",
  amber: "#f5a623",
  amberLight: "#ffcf6e",
  teal: "#0ea880",
  indigo: "#6b7bff",
  line: "rgba(255,255,255,0.07)",
  red: "#e05a5a",
} as const;

// ─── Metadata ─────────────────────────────────────────────────────────────────

export const TARGET_META: Record<
  Target,
  { color: string; label: string; tagline: string }
> = {
  pinocchio: {
    color: C.amber,
    label: "Pinocchio",
    tagline: "Zero-copy by Anza",
  },
  quasar: {
    color: C.teal,
    label: "Quasar",
    tagline: "Zero-alloc by Blueshift",
  },
  native: {
    color: C.indigo,
    label: "Native",
    tagline: "Raw solana_program",
  },
};

export const MODE_META: Record<
  InputMode,
  { icon: React.ElementType; label: string }
> = {
  demo: { icon: PlayCircle, label: "Demo" },
  source: { icon: Code2, label: "Source" },
  file: { icon: FileCode2, label: "File" },
  folder: { icon: FolderOpen, label: "Folder" },
  repo: { icon: GitBranch, label: "Repo" },
};

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export const TARGETS: Target[] = ["pinocchio", "quasar", "native"];

export const STAGES: {
  id: PipelineStage;
  label: string;
  sublabel: string;
}[] = [
  { id: "resolving", label: "Resolve input", sublabel: "Load / fetch source" },
  { id: "parsing", label: "Parse IR", sublabel: "Anchor → SolanaIR" },
  { id: "emitting", label: "Emit code", sublabel: "IR → Rust files" },
  { id: "validating", label: "Validate", sublabel: "Structural checks" },
  { id: "done", label: "Complete", sublabel: "Code ready" },
];

export const STAGE_ORDER: Record<string, number> = {
  idle: -1,
  resolving: 0,
  parsing: 1,
  emitting: 2,
  validating: 3,
  done: 4,
  error: -1,
};

// ─── Monaco options ───────────────────────────────────────────────────────────

export const MONACO_OPTS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: "on" as const,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  padding: { top: 16, bottom: 16 },
  folding: true,
  renderLineHighlight: "none" as const,
  fontFamily:
    "SFMono-Regular, 'JetBrains Mono', 'Fira Code', Menlo, monospace",
  theme: "vs-dark",
};
