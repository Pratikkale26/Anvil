/**
 * Scenario JSON schema — the contract between the workbench, the API
 * differential endpoint, the auto-scenario synthesiser, and the CLI's
 * `anvil-sol differential --scenario` flag.
 *
 * One shape, one validator. Every consumer reads through this. When the
 * shape changes, every consumer compile-errors at the same time.
 *
 * Design notes:
 *
 * - Account references are STRING TAGS, not raw pubkeys. The runtime
 *   resolves `"$signer:authority"` to a generated keypair, `"$pda:counter"`
 *   to a derived address, `"$program:system"` to the well-known System
 *   program ID. This lets a single scenario be portable: same JSON works
 *   on any cluster, with any program ID, on any machine.
 *
 * - Args are an ordered map (object) keyed by Anchor parameter name. The
 *   runtime serialises them via the IR's recorded arg types. Numeric
 *   values can be either `number` (JSON-native) or `string` (for u128 /
 *   i128 / large u64 that overflow JSON's safe integer range).
 *
 * - `compare.accounts` lists which accounts to byte-compare after the
 *   scenario completes. `eventLogs` / `msgLogs` / `returnData` are opt-in
 *   surfaces (false by default; enabled by auto-scenario when the IR
 *   includes the corresponding kinds).
 *
 * - `assertions` is the user's hedge against silent-pass-on-revert. They
 *   declare "after step N, account X.field should equal Y." If both
 *   targets succeed byte-equal AND the assertion holds, that's real
 *   verification. If the targets revert byte-equal but the assertion
 *   fails, the verdict UI flags the scenario as not-actually-verifying.
 *
 * - `expectFail` per-step lets the user assert "this step SHOULD revert."
 *   Useful for testing access-control / overflow guards.
 */
import { z } from "zod";

// ─── Account / signer / PDA reference tags ──────────────────────────────────
//
// Tags are strings the runtime parses to resolve at execution time. The Zod
// regex pre-validates the shape so authoring errors surface in the workbench
// before the request fires.

const AccountRefSchema = z.string().regex(
  /^(?:\$signer:[a-zA-Z_][a-zA-Z0-9_]*|\$pda:[a-zA-Z_][a-zA-Z0-9_]*|\$program:(?:system|token|token_2022|associated_token|memo|rent|clock)|\$keypair:[a-zA-Z_][a-zA-Z0-9_]*|\$mint:[a-zA-Z_][a-zA-Z0-9_]*|\$ata:[a-zA-Z_][a-zA-Z0-9_]*|\$state:[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*|\$arg:[a-zA-Z_][a-zA-Z0-9_]*|[1-9A-HJ-NP-Za-km-z]{32,44})$/,
);

// ─── Signer declaration ─────────────────────────────────────────────────────

export const SignerDeclSchema = z.object({
  name: z.string().min(1),
  /** Optional airdrop in lamports. Defaults to 1 SOL when undefined. */
  airdrop: z.number().int().min(0).optional(),
});

// ─── PDA declaration ────────────────────────────────────────────────────────
//
// `seeds` is an ordered list of seed expressions. Each entry is one of:
//   - `b"literal"` style raw bytes (parsed as UTF-8 → bytes)
//   - `"$signer:authority.pubkey"` — pubkey of a declared signer
//   - `"$pda:other.pubkey"` — pubkey of an earlier-declared PDA
//   - `"u8:42"` / `"u64:1000"` / `"i64:-5"` — typed integer encoded little-endian
//
// The auto-scenario synthesiser populates these from the IR's `pdaSeeds`
// + `seeds` constraint values.

export const PdaDeclSchema = z.object({
  name: z.string().min(1),
  seeds: z.array(z.string()).min(1),
  /** Optional explicit bump. When undefined the runtime calls
   *  find_program_address and uses the canonical bump. */
  bump: z.number().int().min(0).max(255).optional(),
});

// ─── SPL Mint declaration ───────────────────────────────────────────────────
//
// Pre-create a real SPL Mint account before step 0 so SPL CPIs (transfer_checked,
// mint_to, burn) succeed at runtime. The runner writes a 82-byte MintLayout-encoded
// account owned by the token program.
//
// Used for externally-supplied Mints — accounts that aren't `init`'d in any
// instruction but are referenced as `Account<'info, Mint>` / `InterfaceAccount<'info, Mint>`.
// Init'd mints (lp_mint in AMM, etc.) are created by the program itself.

export const MintDeclSchema = z.object({
  name: z.string().min(1),
  /** Decimals for the mint. Default 6 (USDC-like). */
  decimals: z.number().int().min(0).max(18).default(6),
  /** Mint authority signer name. Default: first declared signer. */
  mintAuthority: z.string().optional(),
  /** Initial supply (raw amount, not decimals-adjusted). Default 0. */
  supply: z.union([z.number().int().min(0), z.string()]).default(0),
  /** Optional freeze authority signer name. Default: none. */
  freezeAuthority: z.string().optional(),
  /** Token program owner. Default "token" (Token-2022 deferred). */
  program: z.enum(["token", "token_2022"]).default("token"),
});

// ─── SPL Token Account (ATA) declaration ────────────────────────────────────
//
// Pre-create an SPL Token Account before step 0 with a starting balance, so
// transfer_checked / mint_to / burn CPIs against this account succeed at
// runtime. The runner writes a 165-byte AccountLayout-encoded account owned
// by the token program.
//
// `mint` and `owner` are tag references (`$mint:foo` / `$pda:foo` / `$signer:foo`).
// Auto-scenario derives them from the source's `token::mint = X` and
// `token::authority = X` constraints.

export const TokenAccountDeclSchema = z.object({
  name: z.string().min(1),
  /** Mint reference tag, e.g. `$mint:token_mint_a` or `$pda:lp_mint`. */
  mint: z.string(),
  /** Owner reference tag, e.g. `$signer:authority` or `$pda:pool`. */
  owner: z.string(),
  /** Initial token balance (raw amount, not decimals-adjusted). Default 1_000_000_000. */
  balance: z.union([z.number().int().min(0), z.string()]).default(1_000_000_000),
  /** Token program owner. Default "token" (matches the corresponding mint). */
  program: z.enum(["token", "token_2022"]).default("token"),
  /** When true, this entry's pubkey is the deterministic associated_token
   *  derivation `getAssociatedTokenAddress(mint, owner)`, not a fresh
   *  keypair. Required for any TokenAccount with `associated_token::*`
   *  constraints — Anchor verifies the supplied address matches the
   *  derivation on every CPI. */
  derived: z.boolean().default(false),
  /** When true, the runner does NOT pre-install this account — the program's
   *  init CPI creates it at runtime (Anchor's `init` with `associated_token::*`).
   *  When false, the runner installs the account before step 0 so the
   *  program reads it as a pre-existing balance (escrow's maker_ata_a). */
  programInits: z.boolean().default(false),
});

// ─── Instruction args ───────────────────────────────────────────────────────
//
// JSON-native types only. Custom struct args go through nested objects
// matching the source struct field names; arrays go through JSON arrays.
// The runtime validates against the IR's recorded arg types at execution
// time; structurally-invalid args (e.g. string for a u64 field that isn't a
// numeric string) surface as an early scenario-lint error from the workbench.

export const ArgValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.null(),
    z.array(ArgValueSchema),
    z.record(z.string(), ArgValueSchema),
  ]),
);

// ─── Scenario step ──────────────────────────────────────────────────────────

export const ScenarioStepSchema = z.object({
  /** Anchor instruction name as it appears in the source. */
  ix: z.string().min(1),
  /** Args as ordered object keyed by Anchor parameter name. */
  args: z.record(z.string(), ArgValueSchema).default({}),
  /** Account list -- one entry per AccountRef in the Accounts struct.
   *  Order MUST match the IR's `instructions[i].accounts` order. */
  accounts: z.array(AccountRefSchema).min(0),
  /** When true, the runtime ASSERTS this step reverts. Useful for
   *  testing access-control / overflow guards. Either both targets
   *  revert byte-equal (verdict: pass on this step) or one reverts
   *  while the other doesn't (verdict: fail). */
  expectFail: z.boolean().default(false),
  /** Optional human-readable label shown in the verdict UI. */
  label: z.string().optional(),
});

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

// ─── Compare config ─────────────────────────────────────────────────────────

export const CompareConfigSchema = z.object({
  /** Account names (must match `signers[].name` / `pdas[].name`) to
   *  byte-compare after the scenario completes. Empty list means "scenario
   *  is logging-only" -- typical for spl_memo CPIs that don't store state. */
  accounts: z.array(z.string()).default([]),
  lamports: z.boolean().default(true),
  owner: z.boolean().default(true),
  /** Compare event-log payloads (sol_log_data lines). Default false; enable
   *  for programs using emit!(). */
  eventLogs: z.boolean().default(false),
  /** Compare user-emitted msg!() text logs. Default false. */
  msgLogs: z.boolean().default(false),
  /** Compare set_return_data() output across runs. Default false. */
  returnData: z.boolean().default(false),
});

// ─── Sanity assertions ──────────────────────────────────────────────────────
//
// User-declared invariants the runtime checks INDEPENDENTLY of byte-equality.
// Defuses the silent-pass-on-revert failure mode: even if both targets
// succeed byte-equal, the verdict is "not really verified" unless the
// assertions hold. Field path uses `.` notation: `state.count`, `vault.balance`.

export const ScenarioAssertionSchema = z.object({
  afterStep: z.number().int().min(0),
  account: z.string().min(1),
  field: z.string().min(1),
  /** Expected value -- compared via JSON-equality after the runtime
   *  deserialises the account against its IR AccountDef. */
  expectedValue: ArgValueSchema,
  /** Optional human-readable label for the verdict UI. */
  label: z.string().optional(),
});

// ─── Clock pinning ──────────────────────────────────────────────────────────

export const ClockPinSchema = z.object({
  /** Unix timestamp pinned before step 1. Default 1_700_000_000 (2023-11-14). */
  timestamp: z.number().int().min(0).optional(),
  /** Slot height pinned before step 1. Default 1. */
  slot: z.number().int().min(0).optional(),
});

// ─── Root scenario ──────────────────────────────────────────────────────────

export const ScenarioSchema = z.object({
  /** Scenario format version. Bumped when the schema's contract changes
   *  in a backwards-incompatible way. Workbench refuses unknown versions. */
  version: z.literal(1).default(1),
  /** Optional base58 program ID. When undefined the runtime uses whatever
   *  ID the source's `declare_id!` declares. */
  programId: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  /** Signer keypairs the runtime generates and shares across steps. */
  signers: z.array(SignerDeclSchema).default([]),
  /** PDAs the runtime derives once (seeds resolved against the signers + program ID). */
  pdas: z.array(PdaDeclSchema).default([]),
  /** SPL Mints the runtime pre-creates before step 0. Auto-scenario synthesizes
   *  these from non-init `Account<'info, Mint>` references. */
  mints: z.array(MintDeclSchema).default([]),
  /** SPL Token Accounts the runtime pre-creates before step 0 with a starting
   *  balance. Auto-scenario synthesizes these from non-init `Account<'info, TokenAccount>`
   *  references using their token::mint / token::authority constraints. */
  tokenAccounts: z.array(TokenAccountDeclSchema).default([]),
  /** Ordered instruction sequence. Steps execute in array order. */
  steps: z.array(ScenarioStepSchema).min(1),
  compare: CompareConfigSchema.default({
    accounts: [],
    lamports: true,
    owner: true,
    eventLogs: false,
    msgLogs: false,
    returnData: false,
  }),
  assertions: z.array(ScenarioAssertionSchema).default([]),
  clock: ClockPinSchema.default({}),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type SignerDecl = z.infer<typeof SignerDeclSchema>;
export type PdaDecl = z.infer<typeof PdaDeclSchema>;
export type MintDecl = z.infer<typeof MintDeclSchema>;
export type TokenAccountDecl = z.infer<typeof TokenAccountDeclSchema>;
export type CompareConfig = z.infer<typeof CompareConfigSchema>;
export type ScenarioAssertion = z.infer<typeof ScenarioAssertionSchema>;
export type ClockPin = z.infer<typeof ClockPinSchema>;

// ─── Static lint -- runs client-side AND server-side ────────────────────────
//
// Catches authoring mistakes BEFORE the build fires. Cheap, deterministic,
// shared between workbench (pre-flight) and API (server-side sanity check).
//
// Returns a list of human-readable problem strings. Empty list = scenario
// passes lint. The verdict UI surfaces these inline as red error cards
// before the user can hit "Run".

export interface ScenarioLintIssue {
  severity: "error" | "warning";
  message: string;
  /** Optional pointer back to the offending step / signer / pda by index. */
  stepIndex?: number;
  signerIndex?: number;
  pdaIndex?: number;
}

export function lintScenario(scenario: Scenario): ScenarioLintIssue[] {
  const issues: ScenarioLintIssue[] = [];

  // (1) Signer + PDA names must be unique within the scenario.
  const signerNames = new Set<string>();
  for (const [i, s] of scenario.signers.entries()) {
    if (signerNames.has(s.name)) {
      issues.push({ severity: "error", message: `Duplicate signer name '${s.name}'.`, signerIndex: i });
    }
    signerNames.add(s.name);
  }
  const pdaNames = new Set<string>();
  for (const [i, p] of scenario.pdas.entries()) {
    if (pdaNames.has(p.name)) {
      issues.push({ severity: "error", message: `Duplicate PDA name '${p.name}'.`, pdaIndex: i });
    }
    pdaNames.add(p.name);
  }
  const mintNames = new Set<string>();
  for (const m of scenario.mints) {
    if (mintNames.has(m.name)) {
      issues.push({ severity: "error", message: `Duplicate mint name '${m.name}'.` });
    }
    mintNames.add(m.name);
    if (m.mintAuthority && !signerNames.has(m.mintAuthority)) {
      issues.push({ severity: "error", message: `Mint '${m.name}' references mintAuthority signer '${m.mintAuthority}' which isn't declared.` });
    }
    if (m.freezeAuthority && !signerNames.has(m.freezeAuthority)) {
      issues.push({ severity: "error", message: `Mint '${m.name}' references freezeAuthority signer '${m.freezeAuthority}' which isn't declared.` });
    }
  }
  const tokenAccountNames = new Set<string>();
  for (const ta of scenario.tokenAccounts) {
    if (tokenAccountNames.has(ta.name)) {
      issues.push({ severity: "error", message: `Duplicate tokenAccount name '${ta.name}'.` });
    }
    tokenAccountNames.add(ta.name);
  }

  // (2) Every $signer / $pda / $mint reference must resolve to a declared name.
  const isRef = (s: string, prefix: string) => s.startsWith(`${prefix}:`);
  const refName = (s: string, prefix: string) => s.slice(prefix.length + 1).split(".")[0]!;

  const checkRef = (acc: string, location: { stepIndex?: number; pdaIndex?: number }) => {
    if (isRef(acc, "$signer")) {
      const name = refName(acc, "$signer");
      if (!signerNames.has(name)) {
        issues.push({ severity: "error", message: `Account reference '${acc}' points at signer '${name}' which isn't declared.`, ...location });
      }
    } else if (isRef(acc, "$pda")) {
      const name = refName(acc, "$pda");
      if (!pdaNames.has(name)) {
        issues.push({ severity: "error", message: `Account reference '${acc}' points at PDA '${name}' which isn't declared.`, ...location });
      }
    } else if (isRef(acc, "$mint")) {
      const name = refName(acc, "$mint");
      if (!mintNames.has(name)) {
        issues.push({ severity: "error", message: `Account reference '${acc}' points at mint '${name}' which isn't declared in scenario.mints[].`, ...location });
      }
    } else if (isRef(acc, "$ata")) {
      const name = refName(acc, "$ata");
      if (!tokenAccountNames.has(name)) {
        issues.push({ severity: "error", message: `Account reference '${acc}' points at tokenAccount '${name}' which isn't declared in scenario.tokenAccounts[].`, ...location });
      }
    } else if (isRef(acc, "$keypair")) {
      // $keypair is a runtime-generated throwaway -- no need to declare.
    } else if (isRef(acc, "$program")) {
      // Validated by the regex above.
    }
  };
  for (const [i, step] of scenario.steps.entries()) {
    for (const acc of step.accounts) checkRef(acc, { stepIndex: i });
  }
  // PDA seeds may also reference signers / earlier PDAs / mints.
  for (const [i, pda] of scenario.pdas.entries()) {
    for (const seed of pda.seeds) {
      if (seed.startsWith("$signer:") || seed.startsWith("$pda:") || seed.startsWith("$mint:")) {
        checkRef(seed.split(".")[0]!, { pdaIndex: i });
      }
    }
  }

  // (3) compare.accounts must reference a declared bucket. Bare names map
  // to signers/PDAs/mints/tokenAccounts; tagged names ($mint:foo, $ata:foo,
  // $keypair:foo) pin a bucket — useful when names overlap or when a
  // $keypair ref only appears inside step.accounts (e.g. AMM's lp_mint
  // is init'd via $keypair, not declared in scenario.mints).
  for (const acc of scenario.compare.accounts) {
    if (acc.startsWith("$signer:")) {
      const n = acc.slice("$signer:".length);
      if (!signerNames.has(n)) issues.push({ severity: "error", message: `compare.accounts references '${acc}' but no signer '${n}' is declared.` });
      continue;
    }
    if (acc.startsWith("$pda:")) {
      const n = acc.slice("$pda:".length);
      if (!pdaNames.has(n)) issues.push({ severity: "error", message: `compare.accounts references '${acc}' but no PDA '${n}' is declared.` });
      continue;
    }
    if (acc.startsWith("$mint:")) {
      const n = acc.slice("$mint:".length);
      if (!mintNames.has(n)) issues.push({ severity: "error", message: `compare.accounts references '${acc}' but no mint '${n}' is declared.` });
      continue;
    }
    if (acc.startsWith("$ata:")) {
      const n = acc.slice("$ata:".length);
      if (!tokenAccountNames.has(n)) issues.push({ severity: "error", message: `compare.accounts references '${acc}' but no tokenAccount '${n}' is declared.` });
      continue;
    }
    if (acc.startsWith("$keypair:")) {
      // $keypair refs are dynamic (pre-materialized at runtime from
      // step.accounts). Lint accepts them; runtime resolution catches
      // missing names at that point.
      continue;
    }
    if (signerNames.has(acc)) continue;
    if (pdaNames.has(acc)) continue;
    if (mintNames.has(acc)) continue;
    if (tokenAccountNames.has(acc)) continue;
    issues.push({
      severity: "error",
      message: `compare.accounts references '${acc}' which isn't a declared signer, PDA, mint, or tokenAccount.`,
    });
  }

  // (4) assertions reference declared accounts and an in-range step.
  for (const a of scenario.assertions) {
    if (a.afterStep >= scenario.steps.length) {
      issues.push({
        severity: "error",
        message: `Assertion 'afterStep: ${a.afterStep}' is out of range (scenario has ${scenario.steps.length} steps).`,
      });
    }
    if (!signerNames.has(a.account) && !pdaNames.has(a.account)) {
      issues.push({
        severity: "error",
        message: `Assertion references account '${a.account}' which isn't a declared signer or PDA.`,
      });
    }
  }

  // (5) Warn on scenarios with zero compare accounts AND no assertions --
  //     these can pass byte-equal trivially (no state to compare).
  if (scenario.compare.accounts.length === 0 && scenario.assertions.length === 0
    && !scenario.compare.eventLogs && !scenario.compare.msgLogs && !scenario.compare.returnData) {
    issues.push({
      severity: "warning",
      message: "Scenario has no compare.accounts, no assertions, and no eventLogs/msgLogs/returnData. Byte-equal will trivially pass without verifying anything.",
    });
  }

  // (6) B2 — warn when a $keypair is used as the apparent fee payer.
  // The runtime now lazily airdrops $keypair refs (1 SOL each by default),
  // so the worst case is no longer "tx fails for InsufficientFunds." Still
  // a usability hint: the user might have meant to declare it as a
  // $signer (which gets the explicit airdrop config), and using a
  // throwaway keypair as fee payer makes the scenario harder to reason
  // about.
  for (const [i, step] of scenario.steps.entries()) {
    const firstAccount = step.accounts[0];
    if (firstAccount?.startsWith("$keypair:") && !step.accounts.some((a) => a.startsWith("$signer:"))) {
      issues.push({
        severity: "warning",
        message: `Step ${i} (${step.ix}) uses an ephemeral $keypair as the apparent fee payer. The runtime will airdrop 1 SOL automatically, but consider declaring this as a $signer in scenario.signers[] for explicit control over the airdrop amount.`,
        stepIndex: i,
      });
    }
  }

  return issues;
}
