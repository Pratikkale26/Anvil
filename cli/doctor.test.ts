import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  runDoctorDiagnostics,
  renderDoctorPretty,
  checkRuntime,
  checkCargo,
  checkCargoBuildSbf,
  checkAnchorCli,
  checkSolanaCli,
  checkLiteSvm,
  checkSentio,
} from "../api/src/cli/doctor-analyzer.js";

const CLI_PATH = resolve(__dirname, "anvil.ts");

describe("anvil doctor diagnostic suite", () => {
  it("runs individual check functions without throwing", () => {
    const runtime = checkRuntime();
    expect(runtime.id).toBe("runtime");
    expect(runtime.category).toBe("core");
    expect(["ok", "warn"]).toContain(runtime.status);

    const cargo = checkCargo();
    expect(cargo.id).toBe("cargo");
    expect(cargo.category).toBe("verification");

    const sbf = checkCargoBuildSbf();
    expect(sbf.id).toBe("cargo-build-sbf");
    expect(sbf.category).toBe("verification");

    const anchor = checkAnchorCli();
    expect(anchor.id).toBe("anchor");

    const solana = checkSolanaCli();
    expect(solana.id).toBe("solana");

    const litesvm = checkLiteSvm();
    expect(litesvm.id).toBe("litesvm");

    const sentio = checkSentio();
    expect(sentio.id).toBe("sentio");
    expect(sentio.category).toBe("audit");
  });

  it("produces a structured doctor report with all categories", () => {
    const report = runDoctorDiagnostics();
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.coreReady).toBe("boolean");
    expect(typeof report.verificationReady).toBe("boolean");
    expect(typeof report.auditReady).toBe("boolean");
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(7);

    // Verify all expected checks are present
    const checkIds = report.checks.map((c) => c.id);
    expect(checkIds).toContain("runtime");
    expect(checkIds).toContain("cargo");
    expect(checkIds).toContain("cargo-build-sbf");
    expect(checkIds).toContain("solana");
    expect(checkIds).toContain("anchor");
    expect(checkIds).toContain("litesvm");
    expect(checkIds).toContain("sentio");
  });

  it("renders pretty terminal output with summary", () => {
    const report = runDoctorDiagnostics();
    const rendered = renderDoctorPretty(report, {
      reset: "",
      bold: "",
      dim: "",
      red: "",
      green: "",
      yellow: "",
      blue: "",
      cyan: "",
    });

    expect(rendered).toContain("Core Transpiler");
    expect(rendered).toContain("Verification Gate");
    expect(rendered).toContain("Security Audit");
  });

  it("executes CLI `anvil doctor` command successfully", () => {
    const res = spawnSync("bun", [CLI_PATH, "doctor"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Core Transpiler");
    expect(res.stdout).toContain("Verification Gate");
  });

  it("executes CLI `anvil doctor --json` and returns valid JSON", () => {
    const res = spawnSync("bun", [CLI_PATH, "doctor", "--json"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed).toHaveProperty("coreReady");
    expect(parsed).toHaveProperty("checks");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it("executes CLI `anvil doctor --help`", () => {
    const res = spawnSync("bun", [CLI_PATH, "doctor", "--help"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("anvil doctor");
    expect(res.stdout).toContain("DIAGNOSTICS");
  });
});
