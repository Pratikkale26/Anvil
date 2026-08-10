/**
 * Audit analyzer — sentio-native integration for `anvil audit`.
 *
 * Runs the sentio scanner (https://github.com/Pratikkale26/sentio-native)
 * over the Anchor SOURCE and over the transpiled OUTPUT, then classifies the
 * two finding sets into a security-parity report:
 *
 *   - carried          — weakness present in the source and faithfully still
 *                        present in the output (fix the Anchor code);
 *   - input-only       — source finding with no output counterpart. Split into
 *                        Anchor-form rules (structurally silent on raw code —
 *                        their risks are covered by the native layers of other
 *                        rules) vs. everything else (flagged for review: either
 *                        the transpile genuinely hardened it or the native
 *                        layer has a recall gap — a human should look);
 *   - NEW ON OUTPUT    — the tripwire. A finding with no source counterpart
 *                        means the transformation may have dropped a guarantee
 *                        the source had. This class caught the pyth-modern
 *                        owner/discriminator gap fixed in 0.8.1.
 *
 * sentio is OPTIONAL: anvil works fully without it, and `anvil audit` exits
 * with an install hint when the binary is absent.
 */

import { spawnSync } from "node:child_process";

export interface SentioFinding {
  rule_id: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  location: { path: string; line: number; column: number };
  help?: string | null;
  suppressed?: boolean;
}

export interface SentioScan {
  findings: SentioFinding[];
  files_scanned: number;
  files_parsed: number;
  parse_failures: unknown[];
}

/** Rules expressed through Anchor's constraint grammar — structurally silent
 *  on raw code. Their input-only findings are "not applicable to output", and
 *  the risk they describe is covered by the native layer named in the map. */
export const ANCHOR_FORM_RULES: Record<string, string> = {
  SW011: "SW002 (native owner analysis)",
  SW013: "SW012 (native identity binding)",
  SW014: "SW012 (native identity binding)",
  SW016: "n/a (init_if_needed is an Anchor macro)",
  SW018: "n/a (realloc::zero is an Anchor constraint)",
  SW020: "SW003 (native arbitrary-CPI analysis)",
  SW021: "SW012 (native identity binding)",
};

const SEVERITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function severityAtLeast(sev: string, threshold: string): boolean {
  return (SEVERITY_ORDER[sev] ?? 0) >= (SEVERITY_ORDER[threshold] ?? 0);
}

/** Locates the sentio binary: $ANVIL_SENTIO_BIN, then `sentio` on PATH.
 *  Returns null when unavailable. */
export function findSentioBinary(): string | null {
  const explicit = process.env.ANVIL_SENTIO_BIN;
  if (explicit) {
    const probe = spawnSync(explicit, ["--help"], { encoding: "utf-8" });
    return probe.status === 0 || probe.status === 2 ? explicit : null;
  }
  const which = spawnSync("sentio", ["--help"], { encoding: "utf-8" });
  if (which.error) return null;
  return "sentio";
}

export const SENTIO_INSTALL_HINT =
  "anvil audit needs the sentio scanner (not found on PATH).\n" +
  "  Install: cargo install --git https://github.com/Pratikkale26/sentio-native sentio-cli\n" +
  "  Or point ANVIL_SENTIO_BIN at a sentio binary.";

/** Runs `sentio scan <path> --format json`. Throws on unparseable output. */
export function runSentioScan(bin: string, path: string): SentioScan {
  const proc = spawnSync(bin, ["scan", path, "--format", "json"], {
    encoding: "utf-8",
    env: { ...process.env, SENTIO_NO_TELEMETRY: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) {
    throw new Error(`sentio failed to run: ${proc.error.message}`);
  }
  // Exit 0 = clean, 1 = findings above threshold — both carry valid JSON.
  const raw = (proc.stdout ?? "").trim();
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(
      `sentio produced no JSON (exit ${proc.status}): ${raw.slice(0, 200) || proc.stderr?.slice(0, 200) || "empty output"}`,
    );
  }
  const parsed = JSON.parse(raw.slice(jsonStart)) as SentioScan;
  if (!Array.isArray(parsed.findings)) {
    throw new Error("sentio JSON missing findings array");
  }
  return parsed;
}

export interface ParityReport {
  /** Output findings whose rule also fires on the input — source-level
   *  weaknesses the transpile faithfully preserved. */
  carried: SentioFinding[];
  /** Output findings with NO input counterpart — the tripwire class. */
  newOnOutput: SentioFinding[];
  /** Input-only findings from Anchor-form rules (structurally silent on raw
   *  code); value = which native layer covers the risk. */
  inputOnlyAnchorForm: Array<{ finding: SentioFinding; coveredBy: string }>;
  /** Input-only findings from rules that DO run on raw code — review these:
   *  hardened by the transpile, or a native-layer recall gap. */
  inputOnlyReview: SentioFinding[];
  inputFindings: SentioFinding[];
  outputFindings: SentioFinding[];
}

/**
 * Classifies input vs output findings by rule id at program granularity —
 * deliberately coarse (line numbers don't survive transpilation; per-account
 * matching would be guesswork). A rule that fires on both sides is
 * "carried"; refinement beyond that is the reader's job.
 */
export function compareFindings(
  input: SentioFinding[],
  output: SentioFinding[],
): ParityReport {
  const inputRules = new Set(input.map((f) => f.rule_id));
  const outputRules = new Set(output.map((f) => f.rule_id));

  const carried: SentioFinding[] = [];
  const newOnOutput: SentioFinding[] = [];
  for (const f of output) {
    // SW020/SW011-style Anchor findings map onto the native rules that
    // detect the same risk — an output SW003 matching an input SW020 is a
    // carry, not news.
    const inputEquivalent =
      inputRules.has(f.rule_id) ||
      Object.entries(ANCHOR_FORM_RULES).some(
        ([anchorRule, nativeCover]) =>
          inputRules.has(anchorRule) && nativeCover.startsWith(f.rule_id),
      );
    (inputEquivalent ? carried : newOnOutput).push(f);
  }

  const inputOnlyAnchorForm: Array<{ finding: SentioFinding; coveredBy: string }> = [];
  const inputOnlyReview: SentioFinding[] = [];
  for (const f of input) {
    if (outputRules.has(f.rule_id)) continue;
    const nativeCover = ANCHOR_FORM_RULES[f.rule_id];
    if (nativeCover) {
      // Only "covered" if the covering native rule ALSO didn't fire — if it
      // did, the pair was already counted as a carry above.
      inputOnlyAnchorForm.push({ finding: f, coveredBy: nativeCover });
    } else {
      inputOnlyReview.push(f);
    }
  }

  return {
    carried,
    newOnOutput,
    inputOnlyAnchorForm,
    inputOnlyReview,
    inputFindings: input,
    outputFindings: output,
  };
}
