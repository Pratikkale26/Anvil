/**
 * Lint analyzer — auto-port readiness report.
 *
 * Walks a parsed SolanaIR and classifies patterns as `ready` / `review` /
 * `blocker` so a developer can answer "can I port this program, and what's
 * the cost?" without running the emitter. Reuses the IR the parser already
 * produces; the emitter's transform rules are the source of truth for what
 * translates cleanly and this classifier mirrors those rules.
 *
 * Consumed by `anvil lint <input>`.
 */

import type { SolanaIR, Instruction } from "../ir/schema.js";

/** Target framework the user intends to emit. External crates that block a
 *  pinocchio port are often fine on native (project-scaffold ships the deps),
 *  so lint verdicts have to be target-aware — a one-size-fits-all score
 *  under-sells the native path. */
export type LintTarget = "pinocchio" | "native" | "quasar";

export type LintLevel = "ready" | "review" | "blocker";

export type LintFinding = {
  level: LintLevel;
  category: string;
  title: string;
  detail: string;
  /** Where in the program this finding applies — e.g. "initialize", "Vault". */
  where?: string;
};

export type LintReport = {
  program: string;
  /** Target this report was computed against. */
  target: LintTarget;
  counts: { ready: number; review: number; blocker: number };
  /** 0-100; heuristic: 100 - blockers*25 - reviews*5, clamped. */
  readinessScore: number;
  verdict: "ready" | "reviewable" | "blocked";
  findings: LintFinding[];
};

// Crates the source may import that have no pinocchio/quasar equivalent.
// Native keeps them via project-scaffold, but pinocchio/quasar don't ship
// deps that would resolve these imports, so they block the port.
const EXTERNAL_BLOCKER_CRATES: Array<{ crate: string; reason: string }> = [
  { crate: "mpl_core",                 reason: "Metaplex Core SDK — native-only dep; no pinocchio/quasar equivalent." },
  { crate: "mpl_token_metadata",       reason: "Metaplex token metadata — native-only; CPIs need source-level rewrite." },
  { crate: "pyth_solana_receiver_sdk", reason: "Pyth oracle client — specific to the Pyth receiver program." },
  { crate: "switchboard_on_demand",    reason: "Switchboard oracle — requires the Switchboard SDK." },
  { crate: "solana_sha256_hasher",     reason: "Native-only hash crate; Pinocchio/Quasar don't ship it." },
  { crate: "solana_keccak_hasher",     reason: "Native-only hash crate; Pinocchio/Quasar don't ship it." },
];

export function analyzePortability(ir: SolanaIR, target: LintTarget = "pinocchio"): LintReport {
  const findings: LintFinding[] = [];

  analyzeImports(ir, findings, target);
  analyzeAccounts(ir, findings);
  analyzeInstructions(ir, findings);
  analyzeHelperFunctions(ir, findings, target);
  analyzeCustomTypes(ir, findings);

  const counts = {
    ready: findings.filter((f) => f.level === "ready").length,
    review: findings.filter((f) => f.level === "review").length,
    blocker: findings.filter((f) => f.level === "blocker").length,
  };
  const readinessScore = Math.max(
    0,
    Math.min(100, 100 - counts.blocker * 25 - counts.review * 5),
  );
  const verdict: LintReport["verdict"] =
    counts.blocker > 0 ? "blocked" : counts.review > 0 ? "reviewable" : "ready";

  return { program: ir.name, target, counts, readinessScore, verdict, findings };
}

function analyzeImports(ir: SolanaIR, findings: LintFinding[], target: LintTarget): void {
  // Native's project-scaffold auto-adds deps for the external blocker crates
  // below (mpl-core, pyth, switchboard, solana-sha256-hasher, solana-keccak-
  // hasher, sha2-const-stable, num-derive, num-traits), so they're genuinely
  // fine on native. Pinocchio/Quasar have no equivalent deps, so the same
  // imports block those targets.
  const externalCratesBlock = target !== "native";

  const seen = new Set<string>();
  for (const imp of ir.imports ?? []) {
    for (const { crate, reason } of EXTERNAL_BLOCKER_CRATES) {
      if (!seen.has(crate) && new RegExp(`\\b${crate}\\b`).test(imp)) {
        seen.add(crate);
        if (externalCratesBlock) {
          findings.push({
            level: "blocker",
            category: "External crate",
            title: `Depends on ${crate.replace(/_/g, "-")}`,
            detail: reason,
            where: imp.trim(),
          });
        } else {
          findings.push({
            level: "ready",
            category: "External crate",
            title: `Uses ${crate.replace(/_/g, "-")} (native dep auto-wired)`,
            detail: "Native project-scaffold adds this dep to Cargo.toml automatically; carried-over code resolves against it.",
            where: imp.trim(),
          });
        }
      }
    }
  }

  if ((ir.imports ?? []).some((i) => /anchor_lang/.test(i))) {
    findings.push({
      level: "ready",
      category: "Imports",
      title: "Anchor prelude detected",
      detail: "anchor_lang imports are stripped at emit time and replaced with target-specific equivalents.",
    });
  }
}

function analyzeAccounts(ir: SolanaIR, findings: LintFinding[]): void {
  for (const instr of ir.instructions) {
    for (const accRef of instr.accounts) {
      if (accRef.constraints.some((c) => c.kind === "init_if_needed")) {
        findings.push({
          level: "review",
          category: "Account lifecycle",
          title: `init_if_needed on \`${accRef.name}\``,
          detail:
            "The emitter currently treats this as unconditional init. Verify the skip-if-exists path, or gate the instruction from the client when the account exists.",
          where: `${instr.name} / ${accRef.name}`,
        });
      }
      if (accRef.constraints.some((c) => c.kind === "close" && c.value)) {
        findings.push({
          level: "ready",
          category: "Account lifecycle",
          title: `close on \`${accRef.name}\``,
          detail:
            "Anvil emits a close_program_account helper that zeroes data + reassigns lamports to the close target.",
          where: `${instr.name} / ${accRef.name}`,
        });
      }
      if (accRef.isPda && (accRef.pdaSeeds?.length ?? 0) > 0) {
        findings.push({
          level: "ready",
          category: "PDA",
          title: `PDA seeds on \`${accRef.name}\``,
          detail: `Seeds translate cleanly. bump_seed() helper is emitted automatically.`,
          where: `${instr.name} / ${accRef.name}`,
        });
      }
    }
  }

  const hasZeroCopy =
    ir.accounts?.some((a) =>
      ((a as unknown as { attrs?: string[] }).attrs ?? []).some((attr) =>
        attr.includes("zero_copy"),
      ),
    ) ?? false;
  if (hasZeroCopy) {
    findings.push({
      level: "blocker",
      category: "Account layout",
      title: "#[account(zero_copy)] detected",
      detail:
        "Zero-copy accounts depend on exact #[repr(C)] byte offsets. Anvil's borsh-based emit won't preserve that layout.",
    });
  }
}

function analyzeInstructions(ir: SolanaIR, findings: LintFinding[]): void {
  for (const instr of ir.instructions) {
    const bodyText = serializeBody(instr);

    // Impl-method calls (ctx.accounts.foo()) aren't inlined yet.
    const implCalls = [
      ...new Set(
        [...bodyText.matchAll(/ctx\.accounts\.(\w+)\s*\([^)]*\)/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];
    if (implCalls.length > 0) {
      findings.push({
        level: "blocker",
        category: "Impl-method calls",
        title: `${instr.name}() calls ctx.accounts methods: ${implCalls.join(", ")}`,
        detail:
          "Anvil captures `impl X { fn <method> }` bodies in the IR but doesn't yet inline them at the call site. Flatten the method body into the instruction handler, or wait for impl-inlining support.",
        where: instr.name,
      });
    }

    const hasSplOrSystemCpi = instr.body.some(
      (s) =>
        s.kind === "cpi_system_transfer" ||
        s.kind === "cpi_spl_transfer" ||
        s.kind === "cpi_spl_mint_to" ||
        s.kind === "cpi_spl_burn" ||
        s.kind === "cpi_spl_close_account",
    );
    if (hasSplOrSystemCpi) {
      findings.push({
        level: "ready",
        category: "CPI",
        title: `${instr.name} uses SPL / system CPIs`,
        detail: "Transforms to native SPL / system helpers on both pinocchio and native targets.",
        where: instr.name,
      });
    }

    if (instr.body.some((s) => s.kind === "cpi_custom")) {
      findings.push({
        level: "review",
        category: "CPI",
        title: `${instr.name} uses a custom CPI`,
        detail:
          "Non-SPL / non-system CPIs pass through as raw code. Verify the target program is reachable from the new framework (e.g., mpl-core, pyth).",
        where: instr.name,
      });
    }

    if (instr.body.some((s) => s.kind === "bumps_access")) {
      findings.push({
        level: "ready",
        category: "PDA",
        title: `${instr.name} reads ctx.bumps`,
        detail: "Rewritten to a bump_seed() derivation that re-derives the bump from seeds at call time.",
        where: instr.name,
      });
    }
  }
}

function analyzeHelperFunctions(ir: SolanaIR, findings: LintFinding[], target: LintTarget): void {
  for (const helper of ir.helperFns ?? []) {
    const code = helper.rawCode ?? "";
    if (/\bctx\s*:\s*(?:&\s*mut\s+)?Context\s*</.test(code)) {
      findings.push({
        level: "review",
        category: "Helpers",
        title: `${helper.name}() detected as an inlined Anchor handler`,
        detail:
          "Anvil recognizes this as an instruction handler (Context<X> signature) and skips it in the carry-over. If you meant for it to be a user helper, rename it.",
        where: helper.name,
      });
      continue;
    }
    // A carried helper that references solana_program:: is fine on native
    // (the dep ships) but needs review on pinocchio/quasar (they don't).
    const usesSolanaProgram = /\bsolana_program\b/.test(code);
    if (target === "native" && !usesSolanaProgram) {
      // Pure helper — no framework-specific calls. Ready on native.
      findings.push({
        level: "ready",
        category: "Helpers",
        title: `${helper.name}() carries cleanly`,
        detail: "User helper has no framework-specific types; copies over and builds on native.",
        where: helper.name,
      });
      continue;
    }
    if (target === "native" && usesSolanaProgram) {
      findings.push({
        level: "ready",
        category: "Helpers",
        title: `${helper.name}() uses solana-program`,
        detail: "Target is native — solana-program is already a direct dep, so the helper compiles as-is.",
        where: helper.name,
      });
      continue;
    }
    findings.push({
      level: "review",
      category: "Helpers",
      title: `${helper.name}() carried verbatim`,
      detail:
        "User helpers are copied into the emit with a ⚠️ Anvil: Review banner. Verify it compiles against the target (especially if it uses solana-program types on pinocchio).",
      where: helper.name,
    });
  }
}

function analyzeCustomTypes(ir: SolanaIR, findings: LintFinding[]): void {
  for (const t of ir.types ?? []) {
    if (t.kind === "enum" && (t.rawCode ?? "").includes("=")) {
      findings.push({
        level: "ready",
        category: "Custom types",
        title: `enum ${t.name} uses explicit discriminants`,
        detail: "Anvil adds #[borsh(use_discriminant = true)] so borsh stays consistent with declared values.",
        where: t.name,
      });
    }
  }
}

function serializeBody(instr: Instruction): string {
  return instr.body
    .map((s) => {
      if ("code" in s) return s.code ?? "";
      if ("rawCode" in s) return s.rawCode ?? "";
      return "";
    })
    .join("\n");
}

/** Render a LintReport to Markdown. */
export function renderLintMarkdown(report: LintReport): string {
  const emoji =
    report.verdict === "ready" ? "✅" : report.verdict === "reviewable" ? "🟡" : "🔴";
  const lines: string[] = [];
  lines.push(`# Anvil lint — ${report.program}`);
  lines.push("");
  lines.push(
    `${emoji} **${report.verdict.toUpperCase()}** · readiness score **${report.readinessScore}/100**`,
  );
  lines.push("");
  lines.push(
    `- Ready: ${report.counts.ready} · Review: ${report.counts.review} · Blocker: ${report.counts.blocker}`,
  );
  lines.push("");

  const levels: LintLevel[] = ["blocker", "review", "ready"];
  const heading: Record<LintLevel, string> = {
    blocker: "Blockers — manual rewrite required",
    review:  "Review — translates with caveats",
    ready:   "Ready — clean port",
  };
  const sym: Record<LintLevel, string> = { blocker: "✗", review: "⚠", ready: "✓" };

  for (const level of levels) {
    const rows = report.findings.filter((f) => f.level === level);
    if (rows.length === 0) continue;
    lines.push(`## ${heading[level]}`);
    lines.push("");
    for (const f of rows) {
      lines.push(`${sym[level]} **${f.title}**${f.where ? `  \n  _(${f.where})_` : ""}`);
      lines.push(`  ${f.detail}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
