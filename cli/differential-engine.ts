/**
 * Unified CLI differential engine.
 *
 * The CLI historically shipped its OWN scenario runner (cli/scenario-runner.ts)
 * with a shape (programId / instructions / compare[]) that diverged from the
 * workbench/API engine and — critically — could not resolve $mint:/$ata:/
 * ephemeral-keypair accounts, so it could not byte-equal-verify SPL programs the
 * hosted workbench could. It also couldn't consume `synthesizeAutoScenario`'s
 * output (the workbench shape), so `differential --auto-scenario` crashed.
 *
 * This module makes the CLI drive the SAME pure engine the workbench uses
 * (api/src/build/scenario-runner.ts): the CLI still builds both `.so` files
 * itself, then hands the buffers to runScenarioOnSo + compareScenarioRuns. The
 * CLI now inherits SPL support, the anti-vacuous verdict guard, and every future
 * workbench improvement for free.
 *
 * Backward-compat: a legacy CLI-shape scenario JSON (`instructions`/`compare[]`)
 * is converted to the workbench shape at load; the new/auto shape (`steps`/
 * `compare{}`) passes through. The heavy LiteSVM/web3 deps are dynamic-imported
 * inside runUnifiedDifferential so the module stays cheap to load.
 */
import { ScenarioSchema, type Scenario } from "../api/src/ir/scenario.js";
import type { SolanaIR } from "../api/src/ir/schema.js";
import type { ScenarioVerdict } from "../api/src/build/scenario-runner.js";

/** Legacy CLI program-account name → workbench `$program:` short tag. */
const CLI_PROGRAM_TAGS: Record<string, string> = {
  system_program: "system",
  token_program: "token",
  token_2022_program: "token_2022",
  associated_token_program: "associated_token",
  memo_program: "memo",
  rent: "rent",
  clock: "clock",
};

function isCliShape(raw: any): boolean {
  return raw && Array.isArray(raw.instructions) && !Array.isArray(raw.steps);
}

/**
 * Convert a legacy CLI-shape scenario to the workbench shape. Pure — no I/O, no
 * heavy deps — so it's unit-testable without a toolchain.
 */
export function cliScenarioToWorkbench(cli: any): unknown {
  const signerNames = new Set<string>((cli.signers ?? []).map((s: any) => s.name));
  const pdaNames = new Set<string>((cli.pdas ?? []).map((p: any) => p.name));

  const refToWorkbench = (name: string): string => {
    if (name in CLI_PROGRAM_TAGS) return `$program:${CLI_PROGRAM_TAGS[name]}`;
    if (signerNames.has(name)) return `$signer:${name}`;
    if (pdaNames.has(name)) return `$pda:${name}`;
    // Unknown bare name → ephemeral keypair (the runner lazily materializes it).
    return `$keypair:${name}`;
  };

  // CLI seed `"$authority.pubkey"` → workbench `"$signer:authority.pubkey"`
  // (or $pda: when the name is a declared PDA). Bare literals pass through.
  const seedToWorkbench = (seed: string): string => {
    const m = seed.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)\.pubkey$/);
    if (!m) return seed;
    const n = m[1]!;
    if (pdaNames.has(n)) return `$pda:${n}.pubkey`;
    return `$signer:${n}.pubkey`;
  };

  return {
    version: 1,
    signers: (cli.signers ?? []).map((s: any) => ({
      name: s.name,
      ...(s.airdrop != null ? { airdrop: s.airdrop } : {}),
    })),
    pdas: (cli.pdas ?? []).map((p: any) => ({
      name: p.name,
      seeds: (p.seeds ?? []).map(seedToWorkbench),
    })),
    mints: [],
    tokenAccounts: [],
    steps: (cli.instructions ?? []).map((i: any) => ({
      ix: i.ix,
      args: i.args ?? {},
      accounts: (i.accounts ?? []).map(refToWorkbench),
      expectFail: false,
    })),
    compare: {
      accounts: (cli.compare ?? []).map((c: any) => c.name),
      lamports: true,
      owner: true,
      eventLogs: false,
      msgLogs: false,
      returnData: false,
    },
    assertions: [],
    clock: {
      ...(cli.pinClockTimestamp != null ? { timestamp: cli.pinClockTimestamp } : {}),
      ...(cli.pinClockSlot != null ? { slot: cli.pinClockSlot } : {}),
    },
  };
}

/**
 * Normalize any accepted scenario input (auto-synthesized object, workbench
 * JSON, or legacy CLI JSON) into a validated workbench `Scenario`.
 */
export function toWorkbenchScenario(raw: unknown): Scenario {
  const shaped = isCliShape(raw) ? cliScenarioToWorkbench(raw) : raw;
  return ScenarioSchema.parse(shaped);
}

/**
 * The base58 program id to deploy BOTH `.so` at inside LiteSVM. The CLI builds
 * each `.so` with the source's own `declare_id!`, so the deploy id must equal
 * that id (else the program's `crate::ID` owner checks fail). Legacy CLI JSON
 * carries it explicitly; otherwise it comes from the parsed IR.
 */
export function deriveDeployProgramId(raw: any, ir: SolanaIR): string {
  const id = (isCliShape(raw) ? raw.programId : undefined) ?? ir.programId;
  if (typeof id !== "string" || id.length < 32) {
    throw new Error(
      "could not determine the program id to deploy at — the parsed IR has no declare_id!(). " +
        "Pass a --scenario JSON with a \"programId\", or ensure the source declares one.",
    );
  }
  return id;
}

/**
 * Drive the workbench engine: resolve context, run the scenario against both
 * pre-built `.so` buffers, and compare. Heavy deps are dynamic-imported here.
 */
export async function runUnifiedDifferential(opts: {
  ir: SolanaIR;
  rawScenario: unknown;
  anchorSo: Buffer;
  anvilSo: Buffer;
  durationMs?: number;
  /** CLI --compare-events / --compare-msg-logs / --compare-return-data flags:
   *  opt-in comparison surfaces the engine reads off scenario.compare. */
  compareEventLogs?: boolean;
  compareMsgLogs?: boolean;
  compareReturnData?: boolean;
}): Promise<{ verdict: ScenarioVerdict; scenario: Scenario }> {
  // Dynamic-import the engine so its heavy deps (litesvm / web3 / spl-token)
  // resolve on the api side, NOT from cli/node_modules. The CLI never imports
  // web3.js directly — programId crosses the boundary as a base58 string.
  const { runDifferentialFromSoBuffers } = await import("../api/src/build/scenario-runner.js");

  const scenario = toWorkbenchScenario(opts.rawScenario);
  // Honor CLI compare-surface flags by overriding the normalized scenario.
  if (opts.compareEventLogs !== undefined) scenario.compare.eventLogs = opts.compareEventLogs;
  if (opts.compareMsgLogs !== undefined) scenario.compare.msgLogs = opts.compareMsgLogs;
  if (opts.compareReturnData !== undefined) scenario.compare.returnData = opts.compareReturnData;
  const verdict = runDifferentialFromSoBuffers({
    scenario,
    ir: opts.ir,
    programIdBase58: deriveDeployProgramId(opts.rawScenario, opts.ir),
    anchorSo: opts.anchorSo,
    anvilSo: opts.anvilSo,
    durationMs: opts.durationMs,
  });
  return { verdict, scenario };
}
