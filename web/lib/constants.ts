import {
  Code2,
  FileCode2,
  FolderOpen,
  GitBranch,
  PlayCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Target = "pinocchio" | "native";
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

// ─── Lint report (mirror of api/src/cli/lint-analyzer.ts) ────────────────────

export type LintLevel = "ready" | "review" | "blocker";

export type LintFinding = {
  level: LintLevel;
  category: string;
  title: string;
  detail: string;
  where?: string;
};

export type LintReport = {
  program: string;
  /** Target the report was computed against — affects external-crate verdicts. */
  target: "pinocchio" | "native";
  counts: { ready: number; review: number; blocker: number };
  readinessScore: number;
  verdict: "ready" | "reviewable" | "blocked";
  findings: LintFinding[];
};

export type CUEstimate = {
  instruction: string;
  anchor: number;
  pinocchio: number;
  native: number;
  savingsPinocchio: string;
};

export type EmitResponse = {
  code: string;
  files?: EmitFile[];
  warnings?: string[];
  programName?: string;
  target: Target;
  transformReport?: { transformedCount: number; passedThroughCount: number };
  /** Per-instruction CU estimate vs the Anchor baseline. */
  cu?: CUEstimate[];
  validationIssues?: Array<{
    severity: "error" | "warning";
    message: string;
    path?: string;
  }>;
  reviewReport?: ReviewReport;
  refined?: boolean;
  refineResult?: RefineResult;
  /** Set when refine was attempted but failed at the provider layer. */
  refineError?: { category: string; message: string };
  /** True when the response includes a full cargo-buildable scaffold
   *  (Cargo.toml + README.md + src/). */
  projectScaffold?: boolean;
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

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd?: number;
};

/**
 * Structured rustc diagnostic returned by /build. One per error or warning
 * cargo check produced. Mirrors the shape the build endpoint returns.
 */
export type BuildError = {
  filePath: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  spanText?: string;
  severity: "error" | "warning";
};

export type BuildResult = {
  ok: boolean;
  durationMs: number;
  errors: BuildError[];
  warnings: BuildError[];
  stderrTail?: string;
};

/**
 * Auto-fix loop response. One iteration per cargo-check + (optional) refine
 * pair. The loop stops on the first green build, exhausted budget, or AI
 * giving up (no patches accepted).
 */
export type AutoFixIteration = {
  iteration: number;
  buildResult: {
    ok: boolean;
    durationMs: number;
    errors: BuildError[];
    warnings: BuildError[];
  };
  refine?: {
    acceptedPatches: number;
    rejectedPatches: number;
    rationale: string;
    estimatedCostUsd: number;
  };
  refineError?: { category: string; message: string };
};

export type AutoFixResponse = {
  ok: boolean;
  stoppedReason:
    | "green"
    | "differential_byte_equal"
    | "max_iterations"
    | "cost_cap"
    | "no_progress"
    | "refine_error"
    | "unsupported_target"
    | "client_closed"
    | "regression_reverted"
    | "daily_spend_cap_hit";
  iterations: AutoFixIteration[];
  finalFiles: { path: string; content: string }[];
  finalOk: boolean;
  totalDurationMs: number;
  totalCostUsd: number;
  /**
   * Top-level differential outcome when the auto-fix request enabled
   * the byte-equal gate (`differential` field on the request body).
   * Undefined when the gate wasn't requested. The badge renders
   * "verified" only when this is explicitly "BYTE_EQUAL".
   */
  differentialVerdict?: "BYTE_EQUAL" | "DIVERGED" | "SCENARIO_FAILED" | "NOT_RUN";
};

export type ErrorDelta = { before: number; after: number };

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
  usage?: ProviderUsage;
  errorDelta?: ErrorDelta;
};

export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
  path?: string;
  /** 1-indexed line number of the offending span (parser warnings carry this
   *  via M1 source-position tracking; validator-emitted issues may include
   *  it when the underlying check captured a line). */
  line?: number;
};

// ─── Differential / byte-equal verification (Track B Stage 1+2+5) ────────────

/** Scenario shape mirrors the API's Zod ScenarioSchema (api/src/ir/scenario.ts).
 *  Kept untyped at the workbench level (ad-hoc Record<string, unknown>) since
 *  the schema is the source of truth -- the API validates on receipt. */
export interface ScenarioShape {
  version: number;
  programId?: string;
  signers: Array<{ name: string; airdrop?: number }>;
  pdas: Array<{ name: string; seeds: string[]; bump?: number }>;
  steps: Array<{
    ix: string;
    args: Record<string, unknown>;
    accounts: string[];
    expectFail?: boolean;
    label?: string;
  }>;
  compare: {
    accounts: string[];
    lamports: boolean;
    owner: boolean;
    eventLogs: boolean;
    msgLogs: boolean;
    returnData: boolean;
  };
  assertions: Array<{
    afterStep: number;
    account: string;
    field: string;
    expectedValue: unknown;
    label?: string;
  }>;
  clock: { timestamp?: number; slot?: number };
}

export interface AutoScenarioBlocker {
  message: string;
  context?: { instruction?: string; account?: string; arg?: string };
}

export interface AutoScenarioNote {
  message: string;
  context?: { instruction?: string; account?: string; arg?: string };
}

export type AutoScenarioResponse =
  | { ok: true; scenario: ScenarioShape; notes: AutoScenarioNote[] }
  | { ok: false; blockers: AutoScenarioBlocker[] };

export interface DifferentialQuota {
  available: boolean;
  allowed: boolean;
  used: number;
  cap: number;
  resetInSec: number;
  reason?: string;
  authMode: "anonymous" | "github";
}

export interface AccountDiff {
  name: string;
  status: "equal" | "diverged" | "missing";
  firstDiffByte?: number;
  lamportsDiff?: { anchor: string; anvil: string };
  ownerDiff?: { anchor: string; anvil: string };
  fieldDiffs?: Array<{
    field: string;
    anchor: unknown;
    anvil: unknown;
    equal: boolean;
    sourceLink?: { instruction: string; line: number; column: number };
  }>;
  anchorHex?: string;
  anvilHex?: string;
}

export interface AssertionResult {
  assertion: { afterStep: number; account: string; field: string; expectedValue: unknown; label?: string };
  passed: boolean;
  actualAnvil?: unknown;
  actualAnchor?: unknown;
  message?: string;
}

export interface SanityWarning {
  kind:
    | "all_steps_reverted"
    | "zero_mutation"
    | "no_compare_targets"
    | "partial_compare_scope"
    | "discriminator_mismatch";
  message: string;
}

export interface StepOutcome {
  index: number;
  ix: string;
  label?: string;
  ok: boolean;
  error?: string;
  logs: string[];
  expectedFail: boolean;
}

export interface DifferentialVerdict {
  verdict: "BYTE_EQUAL" | "DIVERGED" | "SCENARIO_FAILED";
  durationMs: number;
  steps: { anchor: StepOutcome[]; anvil: StepOutcome[] };
  accountDiffs: AccountDiff[];
  assertions: AssertionResult[];
  sanityWarnings: SanityWarning[];
  eventLogDiff?: { anchor: string[]; anvil: string[]; diverged: boolean };
  msgLogDiff?: { anchor: string[]; anvil: string[]; diverged: boolean };
  cacheState?: { anchor: "hit" | "miss"; anvil: "hit" | "miss" };
  lintWarnings?: Array<{ severity: "error" | "warning"; message: string }>;
  quota?: DifferentialQuota;
}

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
  { color: string; label: string; tagline: string; experimental?: boolean }
> = {
  pinocchio: {
    color: C.amber,
    label: "Pinocchio",
    tagline: "Zero-copy by Anza",
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

export const TARGETS: Target[] = ["pinocchio", "native"];

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
