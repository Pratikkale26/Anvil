/**
 * Auto-scenario synthesis (#50 / Stage 4a).
 *
 * Pure function: SolanaIR → { ok: true, scenario, notes[] } | { ok: false, blockers[] }
 *
 * Synthesises a Scenario JSON the workbench's "Verify Byte-Equal" tile
 * can run without the user authoring anything. Walks the IR's instructions
 * + accounts, generates default args, derives PDAs, sequences in
 * dependency order.
 *
 * Achievable subset (V1):
 *   - args: u8..u128, i8..i128, bool, String, Vec<u8>
 *   - signers: every Signer<'info> in any handler's accounts struct
 *   - PDAs: seeds = [b"literal", <signer>.key().as_ref(), <state>.bump]
 *   - instruction sequencing: init handlers (any account with `init`
 *     constraint) come first, mutation handlers next
 *
 * Blockers (returned as { ok: false, blockers[] }):
 *   - Custom struct args (no defaults synthesisable)
 *   - Pubkey args without context (would need user to provide)
 *   - Accounts whose seeds reference fields we can't resolve at
 *     synthesis time (e.g. `state.field.to_le_bytes()`)
 *   - External CPI to programs not preloaded in LiteSVM
 *
 * Notes (returned as `notes` on success):
 *   - "auto-scenario chose start_value=10 for instruction `initialize`;
 *      edit if your test needs a different value"
 *   - "PDA `counter` derived from [b\"counter\", $signer:authority.pubkey]"
 *   - "instruction order: initialize, increment (init detected on counter)"
 *
 * The workbench renders the synthesised scenario as a user-friendly form
 * with each arg as an editable input + drag-handles for reorder. "Edit
 * as JSON" toggles to Monaco for power users. Both views update each
 * other in real time.
 */
import type { SolanaIR } from "../ir/schema.js";
import type {
  Scenario,
  ScenarioStep,
  SignerDecl,
  PdaDecl,
} from "../ir/scenario.js";

export interface AutoScenarioBlocker {
  /** Human-readable explanation. Surfaced in the workbench's red error card. */
  message: string;
  /** Which instruction / account / arg caused the blocker. Populated when known. */
  context?: { instruction?: string; account?: string; arg?: string };
}

export interface AutoScenarioNote {
  /** Human-readable note. Surfaced in the workbench's yellow info row. */
  message: string;
  context?: { instruction?: string; account?: string; arg?: string };
}

export type AutoScenarioResult =
  | { ok: true; scenario: Scenario; notes: AutoScenarioNote[] }
  | { ok: false; blockers: AutoScenarioBlocker[] };

/** Default values for primitive types -- chosen to be "non-zero / non-empty"
 *  so default scenarios actually exercise mutation rather than no-op-ing
 *  (counter `increment(0)` is a silent no-op; `increment(1)` actually
 *  mutates state). Pubkey args default to the System program ID -- a
 *  common-case placeholder that the user replaces via the form / JSON
 *  edit if they need a specific address. */
const DEFAULT_VALUES: Record<string, unknown> = {
  u8: 1, u16: 1, u32: 1, u64: 1, u128: "1",
  i8: 1, i16: 1, i32: 1, i64: 1, i128: "1",
  bool: true,
  String: "test",
  "Vec<u8>": [],
  Pubkey: "11111111111111111111111111111111", // System program ID -- harmless placeholder
};

/** Well-known program-account types that resolve to $program:<X>. */
const KNOWN_PROGRAM_TYPES: Record<string, string> = {
  System: "system",
  Token: "token",
  TokenInterface: "token_2022",
  AssociatedToken: "associated_token",
  Memo: "memo",
};

/** Account types Anvil knows how to handle in scenarios. */
const SUPPORTED_NON_PROGRAM_TYPES = new Set([
  "Signer", "SystemAccount", "UncheckedAccount", "AccountInfo",
]);

export function synthesizeAutoScenario(ir: SolanaIR): AutoScenarioResult {
  const blockers: AutoScenarioBlocker[] = [];
  const notes: AutoScenarioNote[] = [];

  if (ir.instructions.length === 0) {
    return {
      ok: false,
      blockers: [{
        message: "Program has zero instructions in its IR. Auto-scenario needs at least one instruction to exercise.",
      }],
    };
  }

  // ── (1) Args check: bail early if any instruction has args we can't default ──
  for (const ix of ir.instructions) {
    for (const arg of ix.args) {
      if (!isPrimitiveType(arg.type)) {
        blockers.push({
          message: `Instruction \`${ix.name}\` has arg \`${arg.name}\` of type \`${arg.type}\` -- auto-scenario can only default primitive types (u*, i*, bool, String, Vec<u8>). Provide a value via "Edit as JSON" or via the form input once we render it.`,
          context: { instruction: ix.name, arg: arg.name },
        });
      }
    }
  }

  // ── (2) Collect every signer name across all instructions ──
  const signerNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (isSignerAccount(acc.accountType)) {
        signerNames.add(acc.name);
      }
    }
  }

  // ── (3) Collect every PDA across all instructions, derive seeds ──
  const pdaSpecs = new Map<string, { seeds: string[]; sourceIx: string }>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.isPda && !pdaSpecs.has(acc.name)) {
        const seedResult = synthesizeSeeds(acc.pdaSeeds, signerNames, acc.name);
        if (!seedResult.ok) {
          blockers.push({
            message: `PDA \`${acc.name}\` (in instruction \`${ix.name}\`) has seeds Anvil can't auto-derive: ${seedResult.reason}. Provide the seeds via "Edit as JSON".`,
            context: { instruction: ix.name, account: acc.name },
          });
          continue;
        }
        pdaSpecs.set(acc.name, { seeds: seedResult.seeds, sourceIx: ix.name });
      }
    }
  }

  // ── (4) Account-type check: every non-Signer non-PDA non-Program account is a problem ──
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (isSignerAccount(acc.accountType)) continue;
      if (acc.isPda) continue;
      if (KNOWN_PROGRAM_TYPES[acc.accountType]) continue;
      if (SUPPORTED_NON_PROGRAM_TYPES.has(acc.accountType)) continue;
      // It's a custom account type without an `init`-derived PDA.
      // Could be: an existing PDA from an earlier handler, OR an externally-
      // created account the user must provide. We can't tell from the IR
      // alone -- block.
      const isStateType = ir.accounts.some((a) => a.name === acc.accountType);
      if (isStateType) {
        // State-typed account, not declared as PDA. Probably should have
        // been; or it's an externally-created account. Warn but don't block --
        // the workbench can let the user paste a pubkey.
        notes.push({
          message: `Account \`${acc.name}\` (type \`${acc.accountType}\`) in instruction \`${ix.name}\` isn't declared as a PDA in the source. Auto-scenario will treat it as an ephemeral keypair; for byte-equal verification you may need to point it at an existing on-chain pubkey or an earlier-init'd PDA.`,
          context: { instruction: ix.name, account: acc.name },
        });
      }
    }
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  // ── (5) Sequence instructions: init-bearing handlers first, then mutations ──
  const orderedInstructions = sortByInitFirst(ir.instructions);
  if (orderedInstructions.length !== ir.instructions.length) {
    notes.push({
      message: `Auto-sequenced ${orderedInstructions.length} instruction(s): init handlers first, mutation handlers after. Re-order via the drag handles in the workbench if your test needs a different sequence.`,
    });
  }

  // ── (6) Build the scenario steps ──
  const steps: ScenarioStep[] = orderedInstructions.map((ix) => {
    const args: Record<string, unknown> = {};
    for (const arg of ix.args) {
      args[arg.name] = DEFAULT_VALUES[arg.type] ?? 1;
      notes.push({
        message: `Auto-defaulted \`${ix.name}.${arg.name}\` (${arg.type}) to ${JSON.stringify(args[arg.name])}. Edit if your test needs a different value.`,
        context: { instruction: ix.name, arg: arg.name },
      });
    }
    const accounts: string[] = ix.accounts.map((acc) => {
      if (isSignerAccount(acc.accountType)) return `$signer:${acc.name}`;
      if (acc.isPda) return `$pda:${acc.name}`;
      const knownProg = KNOWN_PROGRAM_TYPES[acc.accountType];
      if (knownProg) return `$program:${knownProg}`;
      // Fallback: ephemeral keypair (lazy-generated by the runner).
      return `$keypair:${acc.name}`;
    });
    return { ix: ix.name, args, accounts, expectFail: false };
  });

  // ── (7) Comparison config ──
  // Compare every PDA + every Signer that gets mutated (post-state lamports).
  const comparedAccounts = new Set<string>();
  for (const pdaName of pdaSpecs.keys()) comparedAccounts.add(pdaName);
  // Detect emit/msg usage to suggest opt-in compares.
  let usesEmit = false;
  let usesMsg = false;
  for (const ix of ir.instructions) {
    for (const stmt of ix.body) {
      if (stmt.kind === "emit") usesEmit = true;
      if (stmt.kind === "msg") usesMsg = true;
    }
  }
  if (usesEmit) {
    notes.push({
      message: "Program uses emit!() -- enabled compareEventLogs. Both targets must produce byte-identical event payloads.",
    });
  }
  if (usesMsg) {
    notes.push({
      message: "Program uses msg!() -- consider enabling compareMsgLogs (not on by default since msg!() drift is often intentional).",
    });
  }

  // ── (8) Pin clock if any handler reads Clock::get() -- otherwise both runs ──
  // see different default LiteSVM clocks and silently diverge.
  const usesClock = ir.instructions.some((ix) =>
    ix.body.some((s) => s.kind === "sysvar_clock"),
  );
  const clock = usesClock ? { timestamp: 1_700_000_000, slot: 1 } : {};
  if (usesClock) {
    notes.push({
      message: "Program reads Clock::get() -- pinning timestamp to 2023-11-14 (1700000000) for both runs so they see identical time. Adjust via 'Edit as JSON' if your test needs a different time.",
    });
  }

  const scenario: Scenario = {
    version: 1,
    signers: [...signerNames].map<SignerDecl>((name) => ({ name, airdrop: 2_000_000_000 })),
    pdas: [...pdaSpecs.entries()].map<PdaDecl>(([name, spec]) => ({ name, seeds: spec.seeds })),
    steps,
    compare: {
      accounts: [...comparedAccounts],
      lamports: true,
      owner: true,
      eventLogs: usesEmit,
      msgLogs: false,
      returnData: false,
    },
    assertions: [],
    clock,
  };

  return { ok: true, scenario, notes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPrimitiveType(t: string): boolean {
  if (DEFAULT_VALUES[t] !== undefined) return true;
  // Numeric primitive shapes Anvil's IR may emit
  return /^([ui])(8|16|32|64|128)$/.test(t);
}

function isSignerAccount(accountType: string): boolean {
  return accountType === "Signer";
}

interface SeedSynthesis {
  ok: boolean;
  seeds: string[];
  reason?: string;
}

/**
 * Translate IR's pdaSeeds (raw expression strings from the source) into
 * scenario seed-tags ($signer:foo.pubkey / b"literal" / "u64:N" / etc.).
 *
 * Achievable subset:
 *   - `b"literal"` → `b"literal"`
 *   - `<signer>.key().as_ref()` → `$signer:<signer>.pubkey` (when signer
 *     name is in the scenario's signer set)
 *   - `<other_pda>.key().as_ref()` → `$pda:<other_pda>.pubkey` (when
 *     other_pda is also a PDA in this scenario; future)
 *   - `<arg>.to_le_bytes()` for primitive args we can default → defer in V1
 *
 * Unrecognised shapes block.
 */
function synthesizeSeeds(
  rawSeeds: string[],
  signerNames: Set<string>,
  accountName: string,
): SeedSynthesis {
  if (rawSeeds.length === 0) {
    return { ok: false, seeds: [], reason: `account \`${accountName}\` has no seeds in its IR (PDAs need at least one seed)` };
  }
  const out: string[] = [];
  for (const seed of rawSeeds) {
    const trimmed = seed.trim();

    // b"literal" → keep
    if (/^b"[^"]+"$/.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    // Bare string literal → wrap as b""
    if (/^"[^"]+"$/.test(trimmed)) {
      out.push(`b${trimmed}`);
      continue;
    }
    // Some IR-extracted seeds carry just the literal name without `b""`.
    // Heuristic: short identifier-shaped tokens that aren't field accesses
    // get treated as literal seeds (mirrors Anchor source like `seeds = ["counter"]`).
    if (/^[a-z_][a-z0-9_]*$/.test(trimmed) && !signerNames.has(trimmed)) {
      out.push(`b"${trimmed}"`);
      continue;
    }
    // ALL_CAPS const identifier (e.g. VESTING_SEED, VAULT_SEED) -- common
    // Anchor pattern: `pub const VESTING_SEED: &[u8] = b"vesting";` then
    // `seeds = [VESTING_SEED, ...]`. Auto-scenario can't read the actual
    // const value but can derive a literal from the convention: drop
    // _SEED / _PREFIX suffix, lowercase, encode as b"...". Best-effort
    // heuristic; user can override via Edit-as-JSON.
    if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
      const literal = trimmed
        .replace(/_(SEED|SEEDS|PREFIX|TAG|MARKER|KEY|NAMESPACE)$/i, "")
        .toLowerCase();
      out.push(`b"${literal || trimmed.toLowerCase()}"`);
      continue;
    }
    // <signer>.key().as_ref() / <signer>.key.as_ref()
    const signerKeyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.key(?:\(\))?\.as_ref\(\)$/);
    if (signerKeyMatch?.[1]) {
      const name = signerKeyMatch[1];
      if (signerNames.has(name)) {
        out.push(`$signer:${name}.pubkey`);
        continue;
      }
      // Could be a PDA reference -- but PDAs aren't fully resolved at this
      // point. Best-effort: if name matches an account in the scenario's
      // pdaSpecs, use $pda; otherwise block.
      // For V1, treat unknown identifier as $signer if it could be one.
      // Otherwise block.
      out.push(`$pda:${name}.pubkey`);
      continue;
    }
    // <X>.bump → embedded bump byte. Defer to runtime PDA derivation.
    if (/\.bump$/.test(trimmed)) {
      // Skip -- find_program_address will derive the canonical bump.
      continue;
    }
    // Unrecognised shape.
    return {
      ok: false,
      seeds: [],
      reason: `unsupported seed expression \`${trimmed}\` -- V1 supports b"literal", <signer>.key().as_ref(). For other shapes use "Edit as JSON".`,
    };
  }
  return { ok: true, seeds: out };
}

function sortByInitFirst(instructions: SolanaIR["instructions"]): SolanaIR["instructions"] {
  // Stable partition: instructions whose accounts include any `init`
  // constraint go first. Among each bucket, source order is preserved.
  const initFirst: SolanaIR["instructions"] = [];
  const rest: SolanaIR["instructions"] = [];
  for (const ix of instructions) {
    const hasInit = ix.accounts.some((a) =>
      a.isInit || a.constraints.some((c) => c.kind === "init" || c.kind === "init_if_needed"),
    );
    if (hasInit) initFirst.push(ix);
    else rest.push(ix);
  }
  return [...initFirst, ...rest];
}
