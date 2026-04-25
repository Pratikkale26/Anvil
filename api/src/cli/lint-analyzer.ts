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
//
// The Metaplex / oracle / DEX / scheduler imports are owned by
// UNSUPPORTED_IMPORT_PATTERNS below — those have per-target verdicts
// (e.g. mpl_core blocks all targets, not just non-native). Don't add
// them here or you'll fire duplicate findings.
const EXTERNAL_BLOCKER_CRATES: Array<{ crate: string; reason: string }> = [
  { crate: "solana_sha256_hasher",     reason: "Native-only hash crate; Pinocchio/Quasar don't ship it." },
  { crate: "solana_keccak_hasher",     reason: "Native-only hash crate; Pinocchio/Quasar don't ship it." },
];

// ─── Unsupported imports / patterns ─────────────────────────────────────────
//
// Patterns Anvil's emitter doesn't structurally rewrite (yet). Detection is
// path-prefix-based against `ir.imports[*]` — `use foo::bar::*` lines that
// match a prefix produce a finding with a per-target verdict. The match uses
// the prefix as written (including `::`) so that
// `anchor_spl::token_interface` doesn't collide with `anchor_spl::token`.
//
// `verdict` is a function of the target: 'blocker' | 'review' | 'ready'.
// `category` keeps the existing taxonomy ('Imports' for source-level imports,
// plus a dedicated 'Unsupported integration' for SDK-blockers).
type TargetVerdict = (target: LintTarget) => LintLevel;

type UnsupportedPattern = {
  /** Path prefix as it appears in `use ...;` — match is substring against the import line. */
  prefix: string;
  category: string;
  /** Concise label, ≤ 120 chars, names the import + intent. */
  title: string;
  /** Longer explanation including the suggested fix (≤ 200 chars on the action). */
  detail: (target: LintTarget) => string;
  verdict: TargetVerdict;
};

const UNSUPPORTED_IMPORT_PATTERNS: UnsupportedPattern[] = [
  // ── Metaplex Core ──────────────────────────────────────────────────────
  {
    prefix: "mpl_core",
    category: "Unsupported integration",
    title: "mpl_core / mpl-core-sdk imports",
    detail: (t) =>
      t === "native"
        ? "Native carries the mpl-core dep, but Anvil doesn't structurally rewrite Metaplex Core CPIs yet. Suggested fix: keep the call site verbatim and verify against the mpl-core crate after emit."
        : "No pinocchio_mpl_core / quasar equivalent — the emit will carry imports but stub the CPI. Suggested fix: rewrite Metaplex Core CPIs manually, or run `anvil compile --target native` for crate support.",
    verdict: () => "blocker",
  },
  {
    prefix: "mpl_core_sdk",
    category: "Unsupported integration",
    title: "mpl_core_sdk imports",
    detail: (t) =>
      t === "native"
        ? "Native carries the mpl-core dep, but Anvil doesn't structurally rewrite Metaplex Core CPIs yet. Suggested fix: keep the call site verbatim and verify against the mpl-core crate after emit."
        : "No pinocchio_mpl_core / quasar equivalent — the emit will carry imports but stub the CPI. Suggested fix: rewrite Metaplex Core CPIs manually, or run `anvil compile --target native` for crate support.",
    verdict: () => "blocker",
  },
  // ── Metaplex Token Metadata ────────────────────────────────────────────
  {
    prefix: "mpl_token_metadata",
    category: "Unsupported integration",
    title: "mpl_token_metadata imports",
    detail: () =>
      "Metaplex Token Metadata CPIs aren't transpiled — emitted code carries the import but stubs the call. Suggested fix: replace with manual mpl-token-metadata CPIs after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "anchor_spl::metadata",
    category: "Unsupported integration",
    title: "anchor_spl::metadata imports (Metaplex)",
    detail: () =>
      "anchor_spl's metadata wrappers route to Metaplex Token Metadata, which Anvil doesn't structurally rewrite. Suggested fix: replace with direct mpl-token-metadata CPIs.",
    verdict: () => "blocker",
  },
  // ── Pyth oracle ────────────────────────────────────────────────────────
  {
    prefix: "pyth_solana_receiver_sdk",
    category: "Unsupported integration",
    title: "pyth_solana_receiver_sdk imports",
    detail: () =>
      "Pyth oracle reads (price feed parsing) aren't transpiled. Suggested fix: replace the Pyth feed reads with manual code that mirrors your target's account model after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "pyth_sdk_solana",
    category: "Unsupported integration",
    title: "pyth_sdk_solana imports",
    detail: () =>
      "Legacy Pyth SDK reads aren't transpiled. Suggested fix: migrate to the receiver SDK or write the deserialization manually after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "pythnet_sdk",
    category: "Unsupported integration",
    title: "pythnet_sdk imports",
    detail: () =>
      "Pythnet SDK reads aren't transpiled. Suggested fix: replace the Pythnet feed reads manually after emit.",
    verdict: () => "blocker",
  },
  // ── Switchboard oracle ─────────────────────────────────────────────────
  {
    prefix: "switchboard_v2",
    category: "Unsupported integration",
    title: "switchboard_v2 imports",
    detail: () =>
      "Switchboard V2 oracle reads aren't transpiled. Suggested fix: rewrite the aggregator load + result extraction manually after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "switchboard_solana",
    category: "Unsupported integration",
    title: "switchboard_solana imports",
    detail: () =>
      "Switchboard reads aren't transpiled. Suggested fix: rewrite the aggregator load + result extraction manually after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "switchboard_on_demand",
    category: "Unsupported integration",
    title: "switchboard_on_demand imports",
    detail: () =>
      "Switchboard On-Demand reads aren't transpiled. Suggested fix: rewrite the feed pull + result extraction manually after emit.",
    verdict: () => "blocker",
  },
  // ── Drift ──────────────────────────────────────────────────────────────
  {
    prefix: "drift_program",
    category: "Unsupported integration",
    title: "drift_program imports",
    detail: () =>
      "Drift CPIs aren't transpiled. Suggested fix: rewrite the Drift CPI bodies manually after emit, against the drift crate of the target.",
    verdict: () => "blocker",
  },
  {
    prefix: "drift::",
    category: "Unsupported integration",
    title: "drift imports",
    detail: () =>
      "Drift CPIs aren't transpiled. Suggested fix: rewrite the Drift CPI bodies manually after emit, against the drift crate of the target.",
    verdict: () => "blocker",
  },
  // ── Jupiter ────────────────────────────────────────────────────────────
  {
    prefix: "jupiter_amm_interface",
    category: "Unsupported integration",
    title: "jupiter-amm-interface imports",
    detail: () =>
      "Jupiter aggregator CPIs aren't transpiled. Suggested fix: rewrite the swap CPI body manually after emit, against the jupiter-cpi crate.",
    verdict: () => "blocker",
  },
  {
    prefix: "jupiter_cpi",
    category: "Unsupported integration",
    title: "jupiter-cpi imports",
    detail: () =>
      "Jupiter CPIs aren't transpiled. Suggested fix: rewrite the swap CPI body manually after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "jupiter::",
    category: "Unsupported integration",
    title: "jupiter imports",
    detail: () =>
      "Jupiter CPIs aren't transpiled. Suggested fix: rewrite the swap CPI body manually after emit.",
    verdict: () => "blocker",
  },
  // ── Clockwork ──────────────────────────────────────────────────────────
  {
    prefix: "clockwork_sdk",
    category: "Unsupported integration",
    title: "clockwork_sdk imports",
    detail: () =>
      "Clockwork thread / scheduler CPIs aren't transpiled. Suggested fix: rewrite the thread create / kickoff CPI body manually after emit.",
    verdict: () => "blocker",
  },
  {
    prefix: "clockwork_thread_program",
    category: "Unsupported integration",
    title: "clockwork_thread_program imports",
    detail: () =>
      "Clockwork thread program CPIs aren't transpiled. Suggested fix: rewrite the thread create / kickoff CPI body manually after emit.",
    verdict: () => "blocker",
  },
  // ── Token-2022 / token_interface (extension hooks not transpiled) ──────
  {
    prefix: "anchor_spl::token_interface",
    category: "Token-2022",
    title: "anchor_spl::token_interface imports (Token-2022)",
    detail: (t) =>
      t === "native"
        ? "Native scaffold ships spl-token-2022, but Anvil's body emitter currently routes all SPL token CPIs to `spl_token::instruction::*` regardless of source. For Token-2022 mints you'll hit a runtime program-id mismatch — rewrite the offending CPIs by hand to `spl_token_2022::instruction::transfer_checked / mint_to_checked / burn_checked` after emit, or wait for the IR-level Token-2022 routing pass."
        : "Basic checked variants are supported via pinocchio_token, but extension hooks (transfer hooks, fee config, confidential transfers) aren't transformed. Suggested fix: keep extension paths verbatim and verify the post-emit code by hand.",
    verdict: () => "review",
  },
  // ── Instructions sysvar introspection ──────────────────────────────────
  {
    prefix: "solana_program::sysvar::instructions",
    category: "Sysvar introspection",
    title: "solana_program::sysvar::instructions imports",
    detail: (t) =>
      t === "native"
        ? "Native ships solana-program directly — instructions sysvar reads compile as-is."
        : "Reads of the instructions sysvar (load_current_index, get_instruction_relative) aren't structurally transformed. Suggested fix: keep the call site verbatim and verify the bytecode-level access against the target framework.",
    verdict: (t) => (t === "native" ? "ready" : "review"),
  },
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
  // (sha-256, keccak hashers), so they're genuinely fine on native. Pinocchio
  // /Quasar have no equivalent deps, so the same imports block those targets.
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

  // Unsupported import patterns — Metaplex Core / Token Metadata, Pyth,
  // Switchboard, Drift, Jupiter, Clockwork, Token-2022 extension hooks,
  // instructions sysvar introspection. Path-prefix match against each
  // import line; first matching pattern wins (de-duped per pattern).
  const seenPattern = new Set<string>();
  for (const imp of ir.imports ?? []) {
    for (const pattern of UNSUPPORTED_IMPORT_PATTERNS) {
      if (seenPattern.has(pattern.prefix)) continue;
      // Match the prefix as written (including `::`) so that
      // `anchor_spl::token_interface` doesn't collide with `anchor_spl::token`.
      if (imp.includes(pattern.prefix)) {
        seenPattern.add(pattern.prefix);
        findings.push({
          level: pattern.verdict(target),
          category: pattern.category,
          title: pattern.title,
          detail: pattern.detail(target),
          where: imp.trim(),
        });
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
          level: "ready",
          category: "Account lifecycle",
          title: `init_if_needed on \`${accRef.name}\``,
          detail:
            "Emitted as `if <account>.data_is_empty() { create_program_account(...) }` — the create path is skipped when the account is already allocated.",
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
      // realloc — we emit it fully on native (resize + rent delta top-up)
      // and leave a warning block on pinocchio/quasar (stable realloc isn't
      // available there). So it's ready on native, review elsewhere.
      if (accRef.constraints.some((c) => c.kind === "realloc")) {
        findings.push({
          level: "ready",
          category: "Account lifecycle",
          title: `realloc on \`${accRef.name}\``,
          detail:
            "Anvil emits the native realloc call plus a rent-delta top-up from the first signer. Review the payer if `realloc::payer` differs from the default signer.",
          where: `${instr.name} / ${accRef.name}`,
        });
      }
    }
  }

  // Zero-copy detection. The IR doesn't preserve the `#[account(zero_copy)]`
  // attribute directly on AccountDef (parseAccountDataStruct drops attrs), so
  // we rely on two indirect signals that are 1:1 with zero-copy use:
  //   1. an account is typed `AccountLoader<'info, T>` (Anchor's zero-copy
  //      account wrapper)
  //   2. an instruction body calls `.load()` / `.load_mut()` / `.load_init()`
  //      on a ctx.accounts member (the only way to get at the inner data of
  //      a zero-copy account)
  // Either is a hard blocker — the borsh-based emit won't preserve the
  // #[repr(C)] byte layout zero-copy requires.
  const usesAccountLoader = ir.instructions.some((instr) =>
    instr.accounts.some((a) => /\bAccountLoader\s*</.test(a.accountType)),
  );
  const callsLoad = ir.instructions.some((instr) =>
    instr.body.some(
      (s) =>
        ("code" in s && /ctx\.accounts\.\w+\.load(?:_mut|_init)?\s*\(/.test(s.code ?? "")) ||
        ("rawCode" in s && /ctx\.accounts\.\w+\.load(?:_mut|_init)?\s*\(/.test(s.rawCode ?? "")),
    ),
  );
  // Forward-compat path: parser may eventually preserve `attrs` on AccountDef.
  // If it does, this branch picks up the explicit attribute.
  const explicitAttr =
    ir.accounts?.some((a) =>
      ((a as unknown as { attrs?: string[] }).attrs ?? []).some((attr) =>
        attr.includes("zero_copy"),
      ),
    ) ?? false;
  if (usesAccountLoader || callsLoad || explicitAttr) {
    findings.push({
      level: "blocker",
      category: "Account layout",
      title: "#[account(zero_copy)] detected",
      detail:
        "Zero-copy accounts depend on exact #[repr(C)] byte offsets, which Anvil's borsh-based emit can't preserve. Suggested fix: keep zero-copy accounts in the original Anchor program or rewrite the byte layout manually.",
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
