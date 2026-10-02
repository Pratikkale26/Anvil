/**
 * Doctor analyzer — environment and toolchain diagnostics for Anvil.
 *
 * Inspects the local machine's toolchain dependencies across three tiers:
 *   1. Core Transpiler  (Node / Bun, tree-sitter) — required for compile/parse/validate/lint/advise
 *   2. Verification Gate (cargo, cargo-build-sbf, anchor, litesvm) — required for anvil verify & differential
 *   3. Security Audit   (sentio) — optional companion for anvil audit
 *
 * Returns structured diagnostic results with actionable install instructions and
 * copy-pasteable fix commands.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { findSentioBinary, SENTIO_INSTALL_HINT } from "./audit-analyzer.js";

export type DiagnosticStatus = "ok" | "warn" | "missing" | "optional";
export type DiagnosticCategory = "core" | "verification" | "audit";

export interface DiagnosticCheck {
  id: string;
  name: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  required: boolean;
  version?: string | null;
  path?: string | null;
  summary: string;
  installHint?: string | null;
}

export interface DoctorReport {
  ok: boolean;
  coreReady: boolean;
  verificationReady: boolean;
  auditReady: boolean;
  checks: DiagnosticCheck[];
  timestamp: string;
}

function probeCommand(cmd: string, args: string[] = ["--version"]): { ok: boolean; output: string } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf-8",
      timeout: 4000,
      env: { ...process.env },
    });
    if (res.error || res.status !== 0) {
      return { ok: false, output: "" };
    }
    const out = (res.stdout || res.stderr || "").trim();
    return { ok: true, output: out.split("\n")[0] ?? out };
  } catch {
    return { ok: false, output: "" };
  }
}

/** Check Node.js / Bun runtime environment against package engines. */
export function checkRuntime(): DiagnosticCheck {
  const isBun = typeof (process.versions as Record<string, string | undefined>)["bun"] === "string";
  const bunVer = (process.versions as Record<string, string | undefined>)["bun"];
  const nodeVer = process.versions.node;

  if (isBun) {
    return {
      id: "runtime",
      name: "JavaScript Runtime",
      category: "core",
      status: "ok",
      required: true,
      version: `Bun v${bunVer} (Node v${nodeVer} compat)`,
      summary: "Supported high-performance runtime",
    };
  }

  // Parse Node major/minor
  const parts = nodeVer.split(".").map((n) => parseInt(n, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;

  // Engines contract: >=20.19.0 <21 || >=22.12.0
  const isLts20 = major === 20 && minor >= 19;
  const isLts22 = major >= 22 && (major > 22 || minor >= 12);

  if (isLts20 || isLts22) {
    return {
      id: "runtime",
      name: "Node.js Runtime",
      category: "core",
      status: "ok",
      required: true,
      version: `v${nodeVer}`,
      summary: "Matches package engine specification (>=20.19 or >=22.12)",
    };
  }

  return {
    id: "runtime",
    name: "Node.js Runtime",
    category: "core",
    status: "warn",
    required: true,
    version: `v${nodeVer}`,
    summary: `Version v${nodeVer} is outside recommended LTS range (>=20.19 or >=22.12)`,
    installHint: "Upgrade Node: https://nodejs.org or run with bun (https://bun.sh)",
  };
}

/** Check Rust toolchain (cargo). */
export function checkCargo(): DiagnosticCheck {
  const probe = probeCommand("cargo", ["--version"]);
  if (probe.ok) {
    return {
      id: "cargo",
      name: "Rust / Cargo",
      category: "verification",
      status: "ok",
      required: true,
      version: probe.output,
      summary: "Found on PATH — enables cargo build and check gate",
    };
  }
  return {
    id: "cargo",
    name: "Rust / Cargo",
    category: "verification",
    status: "missing",
    required: true,
    summary: "Not found on PATH — needed for compilation and verification gates",
    installHint: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  };
}

/** Check Solana SBF compiler toolchain (cargo-build-sbf). */
export function checkCargoBuildSbf(): DiagnosticCheck {
  const probe = probeCommand("cargo-build-sbf", ["--version"]);
  if (probe.ok) {
    return {
      id: "cargo-build-sbf",
      name: "Solana SBF Compiler (cargo-build-sbf)",
      category: "verification",
      status: "ok",
      required: true,
      version: probe.output,
      summary: "Found on PATH — builds .so binaries for byte-equal verification",
    };
  }
  return {
    id: "cargo-build-sbf",
    name: "Solana SBF Compiler (cargo-build-sbf)",
    category: "verification",
    status: "missing",
    required: true,
    summary: "Not found on PATH — required for 'anvil verify' and differential tests",
    installHint: 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"',
  };
}

/** Check Solana CLI (solana). */
export function checkSolanaCli(): DiagnosticCheck {
  const probe = probeCommand("solana", ["--version"]);
  if (probe.ok) {
    return {
      id: "solana",
      name: "Solana CLI",
      category: "verification",
      status: "ok",
      required: false,
      version: probe.output,
      summary: "Found on PATH — local validator and cluster tooling",
    };
  }
  return {
    id: "solana",
    name: "Solana CLI",
    category: "verification",
    status: "optional",
    required: false,
    summary: "Optional for transpiler; useful for cluster deployment and test validators",
    installHint: 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"',
  };
}

/** Check Anchor CLI (anchor). */
export function checkAnchorCli(): DiagnosticCheck {
  const probe = probeCommand("anchor", ["--version"]);
  if (probe.ok) {
    return {
      id: "anchor",
      name: "Anchor CLI",
      category: "verification",
      status: "ok",
      required: true,
      version: probe.output,
      summary: "Found on PATH — builds Anchor reference binary for verification",
    };
  }
  return {
    id: "anchor",
    name: "Anchor CLI",
    category: "verification",
    status: "missing",
    required: true,
    summary: "Not found on PATH — required for 'anvil verify' to build the reference .so",
    installHint: "cargo install --git https://github.com/coral-xyz/anchor avm --locked --force && avm install latest",
  };
}

/** Check LiteSVM availability for in-process differential testing. */
export function checkLiteSvm(): DiagnosticCheck {
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve("litesvm");
    return {
      id: "litesvm",
      name: "LiteSVM Engine",
      category: "verification",
      status: "ok",
      required: false,
      path: resolved,
      summary: "Available — enables in-process differential byte-equal VM gates",
    };
  } catch {
    return {
      id: "litesvm",
      name: "LiteSVM Engine",
      category: "verification",
      status: "optional",
      required: false,
      summary: "LiteSVM peer dependency not found in current environment",
      installHint: "npm install -g litesvm (or install as peer dependency in project)",
    };
  }
}

/** Check Sentio static scanner for security parity audits. */
export function checkSentio(): DiagnosticCheck {
  const bin = findSentioBinary();
  if (bin) {
    return {
      id: "sentio",
      name: "Sentio Security Scanner",
      category: "audit",
      status: "ok",
      required: false,
      path: bin,
      summary: "Found on PATH / env — enables 'anvil audit' security parity scan",
    };
  }
  return {
    id: "sentio",
    name: "Sentio Security Scanner",
    category: "audit",
    status: "optional",
    required: false,
    summary: "Optional scanner for 'anvil audit' (source vs emit parity checks)",
    installHint: SENTIO_INSTALL_HINT.replace(/\n/g, " "),
  };
}

/** Run all diagnostics and assemble a complete DoctorReport. */
export function runDoctorDiagnostics(): DoctorReport {
  const checks: DiagnosticCheck[] = [
    checkRuntime(),
    checkCargo(),
    checkCargoBuildSbf(),
    checkSolanaCli(),
    checkAnchorCli(),
    checkLiteSvm(),
    checkSentio(),
  ];

  const coreReady = checks
    .filter((c) => c.category === "core")
    .every((c) => c.status === "ok" || c.status === "warn");

  const verificationReady = checks
    .filter((c) => c.category === "verification" && c.required)
    .every((c) => c.status === "ok");

  const auditReady = checks
    .filter((c) => c.category === "audit")
    .some((c) => c.status === "ok");

  const ok = coreReady && verificationReady;

  return {
    ok,
    coreReady,
    verificationReady,
    auditReady,
    checks,
    timestamp: new Date().toISOString(),
  };
}

/** Render ANSI pretty output for interactive terminal display. */
export function renderDoctorPretty(
  report: DoctorReport,
  colors: {
    reset: string;
    bold: string;
    dim: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    cyan: string;
  },
): string {
  const lines: string[] = [];

  const categoryTitles: Record<DiagnosticCategory, string> = {
    core: "Core Transpiler (compile, parse, validate, lint, advise)",
    verification: "Verification Gate (verify, differential)",
    audit: "Security Audit (audit)",
  };

  const categories: DiagnosticCategory[] = ["core", "verification", "audit"];

  for (const cat of categories) {
    const catChecks = report.checks.filter((c) => c.category === cat);
    if (catChecks.length === 0) continue;

    lines.push(`  ${colors.bold}${categoryTitles[cat]}${colors.reset}`);
    lines.push("");

    for (const check of catChecks) {
      let icon = "";
      let statusColor = "";
      if (check.status === "ok") {
        icon = "✓";
        statusColor = colors.green;
      } else if (check.status === "warn") {
        icon = "!";
        statusColor = colors.yellow;
      } else if (check.status === "missing") {
        icon = check.required ? "✗" : "!";
        statusColor = check.required ? colors.red : colors.yellow;
      } else {
        icon = "○";
        statusColor = colors.dim;
      }

      const versionStr = check.version ? ` ${colors.dim}(${check.version})${colors.reset}` : "";
      lines.push(`    ${statusColor}${icon}${colors.reset} ${colors.bold}${check.name}${colors.reset}${versionStr}`);
      lines.push(`      ${colors.dim}${check.summary}${colors.reset}`);

      if (check.installHint && (check.status === "missing" || check.status === "warn" || check.status === "optional")) {
        lines.push(`      ${colors.cyan}Fix:${colors.reset} ${colors.dim}${check.installHint}${colors.reset}`);
      }
      lines.push("");
    }
  }

  // Summary Banner
  lines.push("  ─────────────────────────────────────────────────────────────────");
  if (report.coreReady && report.verificationReady) {
    lines.push(`  ${colors.green}${colors.bold}✓ All systems ready.${colors.reset} Core transpilation and byte-equal verification are operational.`);
  } else if (report.coreReady) {
    lines.push(`  ${colors.yellow}${colors.bold}! Core transpiler ready.${colors.reset} Verification gate requires missing tools (see fix hints above).`);
  } else {
    lines.push(`  ${colors.red}${colors.bold}✗ Environment issues detected.${colors.reset} Resolve missing prerequisites above.`);
  }
  lines.push("");

  return lines.join("\n");
}
