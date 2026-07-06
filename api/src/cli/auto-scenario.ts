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
import { typeSize } from "../emitter/emitter-utils.js";
import type {
  Scenario,
  ScenarioStep,
  SignerDecl,
  PdaDecl,
  MintDecl,
  TokenAccountDecl,
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

/** Auto-scenario pins clock.timestamp to this when any handler reads
 *  Clock::get(). Timestamp args ride on top of this so `require!(start_ts >=
 *  clock.unix_timestamp)` and `require!(end_ts > cliff_ts)` patterns pass
 *  without manual editing. Mirrors the value at scenario.clock.timestamp. */
const PINNED_CLOCK_TIMESTAMP = 1_700_000_000;

/** Resolve a more contextually-useful default for ordered timestamp args
 *  by scanning the arg name. start < cliff < end ordering covers the AMM /
 *  vesting / lock-up shape; generic _ts / _time / _at args nudge above
 *  the pinned clock so the typical `require!(ts >= clock.unix_timestamp)`
 *  passes. Returns undefined when no name pattern matches — caller falls
 *  back to DEFAULT_VALUES. */
function defaultForTimestampArg(argName: string): number | undefined {
  const n = argName.toLowerCase();
  // start = clock + 1 — must satisfy `start_ts >= clock.unix_timestamp`.
  if (/(^|_)(start)(_ts|_time|_at|_unix|_seconds|_secs)?$/.test(n)) return PINNED_CLOCK_TIMESTAMP + 1;
  if (/(^|_)(cliff)(_ts|_time|_at|_unix|_seconds|_secs)?$/.test(n)) return PINNED_CLOCK_TIMESTAMP + 100;
  if (/(^|_)(end|expiry|expiration|deadline|finish|maturity|unlock)(_ts|_time|_at|_unix|_seconds|_secs)?$/.test(n)) return PINNED_CLOCK_TIMESTAMP + 1000;
  if (/_(ts|time|at|unix|seconds|secs)$/.test(n) || /^(timestamp|time|now)$/.test(n)) return PINNED_CLOCK_TIMESTAMP + 10;
  return undefined;
}

/** Default for token-amount args. Names matching `amount`, `_in`, `size`,
 *  `qty`, `value`, `tokens` get bumped to 1 unit at 6dp (1_000_000) so
 *  AMM-style scenarios actually exercise transfers + don't drain reserves
 *  after a single round trip. Slippage / lower-bound args (`_min`, `min_`)
 *  stay at the default 1 so the bounds checks pass. The `lp_amount` /
 *  `amount_*_min` shapes deliberately fall through (default 1) so a
 *  remove_liquidity step doesn't withdraw every token deposited.
 *  Returns undefined when no pattern matches — caller falls through to
 *  DEFAULT_VALUES. */
function defaultForAmountArg(argName: string): number | undefined {
  const n = argName.toLowerCase();
  // Keep small: lower-bound / minimum-out / lp burn shapes.
  if (/^min_|_min$|^minimum_|_minimum$/.test(n)) return undefined;
  if (n === "lp_amount" || /_lp_amount$/.test(n)) return undefined;
  if (/^max_|_max$|^maximum_|_maximum$/.test(n)) return undefined;
  // Fee/rate/bps patterns are basis-point shaped; small values are correct.
  if (/_rate$|^rate_|_bps$|^bps_|fee_rate|_fee$/.test(n)) return undefined;
  // Bump: amount-ish, size-ish, supply-ish.
  if (/(^|_)(amount|amt|size|qty|tokens?|value|supply|balance|deposit|stake|liquidity|reserve|notional|collateral)(_|$)/.test(n)) return 1_000_000;
  if (/_(in|out)$/.test(n)) return 1_000_000;
  if (/_desired$/.test(n)) return 1_000_000;
  // Lamports-named amounts (e.g. fund_lamports). 1 SOL is comfortably
  // above rent-exempt thresholds for typical sub-1KB account allocations
  // and leaves headroom for downstream transfers.
  if (/(^|_)lamports(_|$)/.test(n)) return 1_000_000_000;
  return undefined;
}

/**
 * Recursively synthesise a default value for a custom struct / enum arg
 * by walking its TypeDef.fields. Returns undefined when the type isn't
 * in the IR types catalog or when its fields contain unsupported shapes.
 *
 * Stage 4b: previously custom structs were a hard blocker. Now we look
 * up the TypeDef, walk each field, and recurse for nested types. Enums
 * default to the first variant (best-effort heuristic).
 */
function synthesizeCustomTypeDefault(
  typeName: string,
  ir: SolanaIR,
  visited: Set<string> = new Set(),
): unknown | undefined {
  // Recursion guard for self-referential types.
  if (visited.has(typeName)) return null;
  const next = new Set(visited).add(typeName);

  const typeDef = ir.types.find((t) => t.name === typeName);
  if (!typeDef) return undefined;

  if (typeDef.kind === "enum") {
    // Default to the first variant by name. Tagged-union with payload
    // is too rich to default; fall back to the variant name string.
    const firstVariant = typeDef.variants?.[0];
    return firstVariant ?? null;
  }

  // Struct: synthesise each field
  const out: Record<string, unknown> = {};
  for (const f of typeDef.fields ?? []) {
    if (DEFAULT_VALUES[f.type] !== undefined) {
      out[f.name] = DEFAULT_VALUES[f.type];
    } else if (/^([ui])(8|16|32|64|128)$/.test(f.type)) {
      out[f.name] = 1;
    } else {
      // Recurse for nested custom type
      const nested = synthesizeCustomTypeDefault(f.type, ir, next);
      if (nested !== undefined) {
        out[f.name] = nested;
      } else {
        // Unknown field type -- bail with a sentinel the user can replace.
        out[f.name] = null;
      }
    }
  }
  return out;
}

/** Well-known program-account types that resolve to $program:<X>.
 *  `Sysvar<X>` shapes resolve via the same $program: tag — the runner's
 *  KNOWN_PROGRAMS map already includes rent + clock pubkeys. Older
 *  Anchor programs (escrow.rs uses one) explicitly list these in their
 *  accounts struct. */
const KNOWN_PROGRAM_TYPES: Record<string, string> = {
  System: "system",
  Token: "token",
  TokenInterface: "token_2022",
  AssociatedToken: "associated_token",
  Memo: "memo",
  Metadata: "mpl_token_metadata",
  "Sysvar<Rent>": "rent",
  "Sysvar<Clock>": "clock",
  "Sysvar<StakeHistory>": "stake_history",
  "Sysvar<SlotHashes>": "slot_hashes",
  "Sysvar<SlotHistory>": "slot_history",
  "Sysvar<EpochSchedule>": "epoch_schedule",
  "Sysvar<EpochRewards>": "epoch_rewards",
  "Sysvar<Instructions>": "instructions",
  "Sysvar<RecentBlockhashes>": "recent_blockhashes",
  "Sysvar<Rewards>": "rewards",
  "Sysvar<Fees>": "fees",
  "Sysvar<LastRestartSlot>": "last_restart_slot",
};

/** Account types Anvil knows how to handle in scenarios. */
const SUPPORTED_NON_PROGRAM_TYPES = new Set([
  "Signer", "SystemAccount", "UncheckedAccount", "AccountInfo",
]);

/** Options controlling what the synthesiser emits beyond the happy path. */
export interface AutoScenarioOptions {
  /**
   * #14 — interleave guard-violating `expectFail` steps ("negative probes")
   * before each target instruction's happy step. Off by default so plain
   * synthesis stays happy-path-only (stable for snapshots/regression); the
   * differential verification entrypoints (CLI `--auto-scenario`, API
   * `/build/differential`) turn it ON so a dropped access-control guard is
   * actually exercised. See `buildHasOneNegativeProbe`.
   */
  negativeProbes?: boolean;
}

/** Signer name used for the unauthorized caller in has_one negative probes. */
const NEGATIVE_PROBE_ATTACKER = "__unauthorized";
/** Dedicated fee payer for missing-signer probes: it pays (and signs) the tx so
 *  the de-signed account is NOT forced-signer via the fee-payer slot. Declared
 *  as scenario.signers[0] so the runner's no-step-signer fallback lands on it. */
const NEGATIVE_PROBE_PAYER = "__probe_payer";

export function synthesizeAutoScenario(
  ir: SolanaIR,
  opts: AutoScenarioOptions = {},
): AutoScenarioResult {
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
  // Stage 4b: custom struct args are now synthesisable when their TypeDef is
  // in the IR (the workbench user can edit the defaulted values via the
  // form). Truly-unsynthesisable shapes (external types not in IR.types)
  // still block.
  for (const ix of ir.instructions) {
    for (const arg of ix.args) {
      if (isPrimitiveType(arg.type)) continue;
      // Custom type — does the IR have a TypeDef for it?
      const synthesized = synthesizeCustomTypeDefault(arg.type, ir);
      if (synthesized === undefined) {
        blockers.push({
          message: `Instruction \`${ix.name}\` has arg \`${arg.name}\` of type \`${arg.type}\` which isn't in the IR's types catalog. External types aren't synthesisable; use "Edit as JSON" to provide a value.`,
          context: { instruction: ix.name, arg: arg.name },
        });
      } else {
        notes.push({
          message: `Defaulted custom-type arg \`${ix.name}.${arg.name}\` (\`${arg.type}\`) by walking its TypeDef fields. Edit the values inline if your test needs different ones.`,
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

  // ── (2b) Collect non-init Mint accounts. These are externally-supplied
  // SPL Mints that must be pre-created before step 0. The runner reads
  // scenario.mints[] and writes a real MintLayout-encoded account via
  // setAccount so transfer_checked / mint_to / burn CPIs succeed.
  // Mints that are `init` in *any* instruction are excluded — the program
  // creates those (AMM's lp_mint is init in initialize_pool but referenced
  // as bare Account<'info, Mint> in add_liquidity/swap/etc).
  const initdMintNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.accountType === "Mint" && acc.isInit) initdMintNames.add(acc.name);
    }
  }
  const mintNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.accountType === "Mint" && !acc.isInit && !acc.isPda && !initdMintNames.has(acc.name)) {
        mintNames.add(acc.name);
      }
    }
  }
  if (mintNames.size > 0) {
    notes.push({
      message: `Auto-synthesized ${mintNames.size} SPL Mint account(s): ${[...mintNames].join(", ")}. Pre-created with decimals=6, supply=0, mint authority = first signer. Edit scenario.mints[] for different defaults.`,
    });
  }

  // ── (2-pre) Pre-compute PDA names so tagFor() in (2d) can reference them.
  const allPdaNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.isPda) allPdaNames.add(acc.name);
    }
  }

  // ── (2c) Build state-field-map: for each `<acc>.<field> = ctx.accounts.<src>.key()`
  // body assignment, record what `<src>` resolves to. Lets us translate state-derived
  // PDA seeds (`pool.token_mint_a.as_ref()`) AND state-derived ATA mint constraints
  // (`token::mint = pool.token_mint_a`) back to their source-account tags.
  // Without this, AMM's add_liquidity / swap PDAs would block with "state-derived"
  // errors even though the post-init value is statically determinable from
  // initialize_pool's body.
  const stateFieldMap = new Map<string, Map<string, string>>(); // account → field → source-name
  for (const ix of ir.instructions) {
    for (const stmt of ix.body) {
      if (stmt.kind !== "state_field_assign") continue;
      const m = stmt.value.trim().match(/^ctx\.accounts\.([a-zA-Z_][a-zA-Z0-9_]*)\.key\(\)$/);
      if (!m?.[1]) continue;
      let inner = stateFieldMap.get(stmt.account);
      if (!inner) { inner = new Map(); stateFieldMap.set(stmt.account, inner); }
      if (!inner.has(stmt.field)) inner.set(stmt.field, m[1]);
    }
  }

  // ── (2d) Collect non-init non-PDA TokenAccount accounts. These are user-side
  // ATAs (or generic SPL token accounts) that must be pre-created with a starting
  // balance so transfer_checked CPIs succeed.
  // Mint resolution: read the `token::mint` constraint. Direct ident → tagFor(name).
  // State-derived (`pool.token_mint_a`) → look up stateFieldMap.
  // Owner: `token::authority` constraint or first signer fallback.
  const tokenAccountSpecs = new Map<string, { mint: string; owner: string; sourceIx: string; derived: boolean; programInits: boolean }>();
  const taBlockers: AutoScenarioBlocker[] = [];

  const tagFor = (name: string): string | undefined => {
    if (signerNames.has(name)) return `$signer:${name}`;
    if (allPdaNames.has(name)) return `$pda:${name}`;
    if (mintNames.has(name)) return `$mint:${name}`;
    return undefined;
  };

  const resolveStateDerivedTag = (expr: string): string | undefined => {
    const m = expr.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (!m?.[1] || !m[2]) return undefined;
    const src = stateFieldMap.get(m[1])?.get(m[2]);
    if (!src) return undefined;
    return tagFor(src);
  };

  // Pre-scan: TokenAccount names that are init'd in *any* instruction. These
  // are program-created and shouldn't be pre-synthesized as ATAs even when
  // a later instruction references them as non-init (marketplace's `vault`).
  const initdTokenAccountNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.accountType === "TokenAccount" && acc.isInit) {
        initdTokenAccountNames.add(acc.name);
      }
    }
  }

  // B2f bucket fix — accounts that are init'd in some instruction AND not
  // themselves PDAs need a fresh ephemeral keypair at scenario-run time
  // (the program creates the account with this keypair as signer). When
  // such an account is referenced in a PDA's seed (e.g. nft-minter's
  // `metadata` PDA is seeded by `mint_account.key().as_ref()` where
  // `mint_account` is init'd with a fresh keypair), the seed must resolve
  // to that keypair's pubkey. We pass this set into synthesizeSeeds so it
  // can emit `$keypair:<name>.pubkey` instead of blocking.
  const initdEphemeralNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (!acc.isInit) continue;
      if (acc.isPda) continue; // PDA init'd accounts go through find_program_address
      initdEphemeralNames.add(acc.name);
    }
  }

  // B2f bucket fix (state-account form) — when a seed references a state-typed
  // account (e.g. zero-copy: `seeds = [authority.key().as_ref(), foo.key().as_ref()]`
  // where `foo: AccountLoader<Foo>` and Foo is a user-defined state struct in
  // ir.accounts), the scenario runner pre-creates a fresh keypair for that
  // account regardless of whether any instruction marks it `init`. Both
  // targets see the same keypair pubkey → same derived PDA → byte-equal.
  // Names of accounts whose type matches a user-defined state struct.
  const stateAccountTypes = new Set(ir.accounts.map((a) => a.name));
  const stateTypeNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.isPda) continue;
      if (acc.isInit) continue; // already in initdEphemeralNames
      if (stateAccountTypes.has(acc.accountType)) stateTypeNames.add(acc.name);
    }
  }

  // Pass A — derived ATAs: accounts init'd with associated_token::*. The
  // ATA program derives the address from (owner, mint, token_program); the
  // runner pre-derives the pubkey and does NOT pre-install (the program's
  // init CPI creates it). marketplace's buyer_ata is the canonical case.
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.accountType !== "TokenAccount") continue;
      if (!acc.isInit) continue;
      if (tokenAccountSpecs.has(acc.name)) continue;
      const ataMint = acc.constraints.find((c) => c.kind === "associated_token::mint" && c.value);
      const ataAuth = acc.constraints.find((c) => c.kind === "associated_token::authority" && c.value);
      if (!ataMint?.value || !ataAuth?.value) continue;
      const mintTagOpt = (() => {
        const v = ataMint.value.trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) return tagFor(v) ?? `$keypair:${v}`;
        return resolveStateDerivedTag(v);
      })();
      const ownerTagOpt = (() => {
        const v = ataAuth.value.trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) return tagFor(v) ?? `$keypair:${v}`;
        return resolveStateDerivedTag(v);
      })();
      if (!mintTagOpt || !ownerTagOpt) continue;
      tokenAccountSpecs.set(acc.name, { mint: mintTagOpt, owner: ownerTagOpt, sourceIx: ix.name, derived: true, programInits: true });
      notes.push({
        message: `Detected associated_token init on \`${acc.name}\` (in \`${ix.name}\`). Pre-deriving the ATA address from (owner=${ownerTagOpt}, mint=${mintTagOpt}); the program's init CPI creates the account at runtime.`,
        context: { instruction: ix.name, account: acc.name },
      });
    }
  }

  // Pass B — non-init user-side TokenAccounts (existing logic).
  for (const ix of ir.instructions) {
    // Per-instruction tracker: how many unconstrained TAs we've routed.
    // Drives swap-shape mint routing (alternate through declared mints
    // when there are multiple, instead of defaulting all to the first).
    let unconstrainedRoutingCounter = 0;
    for (const acc of ix.accounts) {
      if (acc.accountType !== "TokenAccount") continue;
      if (acc.isInit || acc.isPda) continue;
      if (initdTokenAccountNames.has(acc.name)) continue;
      if (tokenAccountSpecs.has(acc.name)) continue;

      const mintConstraint = acc.constraints.find((c) => c.kind === "token::mint" || c.kind === "associated_token::mint");
      const authorityConstraint = acc.constraints.find((c) => c.kind === "token::authority" || c.kind === "associated_token::authority");

      // Resolve mint
      let mintTag: string | undefined;
      let mintWasDefaulted = false;
      if (mintConstraint?.value) {
        const v = mintConstraint.value.trim();
        // Direct ident: lp_mint, token_mint_a, etc.
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) {
          mintTag = tagFor(v) ?? `$keypair:${v}`;
        } else {
          // State-derived: pool.token_mint_a → look up in stateFieldMap.
          mintTag = resolveStateDerivedTag(v);
        }
      }
      if (!mintTag) {
        // No explicit token::mint constraint, OR an unrecognised expression.
        // Common pattern: user-side TokenAccounts where the program checks
        // mint identity manually in the body (spl-transfer / spl-burn / AMM swap).
        // Routing strategy: when multiple mints are declared, alternate
        // through them in declared order (first unconstrained TA → mintNames[0],
        // second → mintNames[1], etc., wrapping). AMM swap's user_token_in /
        // user_token_out → token_mint_a / token_mint_b in this order.
        // When only one mint is declared, all default to it (existing behavior).
        // If no Mint is declared anywhere, synthesize an implicit default mint.
        const declaredMints = [...mintNames];
        if (declaredMints.length === 0) {
          declaredMints.push("__default_mint");
          mintNames.add("__default_mint");
        }
        const pickedMint = declaredMints[unconstrainedRoutingCounter % declaredMints.length]!;
        unconstrainedRoutingCounter++;
        mintTag = `$mint:${pickedMint}`;
        mintWasDefaulted = true;
      }

      // Resolve owner
      let ownerTag: string | undefined;
      if (authorityConstraint?.value) {
        const v = authorityConstraint.value.trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) {
          ownerTag = tagFor(v) ?? `$keypair:${v}`;
        } else {
          ownerTag = resolveStateDerivedTag(v);
        }
      }
      if (!ownerTag) {
        // Fall back to first signer (typical user-token-account pattern).
        const firstSigner = [...signerNames][0];
        if (!firstSigner) {
          taBlockers.push({
            message: `Token account \`${acc.name}\` (in instruction \`${ix.name}\`) has no \`token::authority\` constraint and no signer is declared in the scenario.`,
            context: { instruction: ix.name, account: acc.name },
          });
          continue;
        }
        ownerTag = `$signer:${firstSigner}`;
      }

      // ATA-shape detection: when the user-side TokenAccount carries
      // associated_token::* constraints (vs token::*), Anchor verifies the
      // supplied address equals the deterministic ATA derivation on every
      // CPI. Mark derived=true so the runner installs at the derived
      // address rather than a random keypair (escrow's maker_ata_a).
      const isAtaShape = acc.constraints.some((c) => c.kind === "associated_token::mint")
        && acc.constraints.some((c) => c.kind === "associated_token::authority");
      tokenAccountSpecs.set(acc.name, { mint: mintTag, owner: ownerTag, sourceIx: ix.name, derived: isAtaShape, programInits: false });
      if (mintWasDefaulted) {
        notes.push({
          message: `Defaulted token::mint for \`${acc.name}\` to \`${mintTag}\` (no explicit constraint in source). Both targets see the same default — byte-equal verdict still valid. Edit scenario.tokenAccounts[].mint if your test needs a specific mint.`,
          context: { instruction: ix.name, account: acc.name },
        });
      }
    }
  }
  if (taBlockers.length > 0) blockers.push(...taBlockers);
  if (tokenAccountSpecs.size > 0) {
    notes.push({
      message: `Auto-synthesized ${tokenAccountSpecs.size} SPL Token Account(s): ${[...tokenAccountSpecs.keys()].join(", ")}. Pre-created with balance=1_000_000_000 each. Edit scenario.tokenAccounts[] for different balances.`,
    });
  }

  // ── (3a) Build state-numeric-field map: `<acc>.<field> = <arg>` body
  // assignments where <arg> is a numeric instruction arg. Seeds shaped
  // `<acc>.<field>.to_le_bytes()` resolve to the arg's auto-defaulted
  // value (Track 3 — numeric state-field seed resolution).
  const stateNumericFieldMap = new Map<string, Map<string, { argName: string; argType: string; defaultValue: number }>>();
  for (const ix of ir.instructions) {
    const argByName = new Map<string, string>();
    for (const a of ix.args) argByName.set(a.name, a.type);
    for (const stmt of ix.body) {
      if (stmt.kind !== "state_field_assign") continue;
      const argName = stmt.value.trim();
      const argType = argByName.get(argName);
      if (!argType) continue;
      if (!/^([ui])(8|16|32|64)$/.test(argType)) continue;
      const tsDefault = defaultForTimestampArg(argName);
      const defaultValue = tsDefault ?? 1;
      let inner = stateNumericFieldMap.get(stmt.account);
      if (!inner) { inner = new Map(); stateNumericFieldMap.set(stmt.account, inner); }
      if (!inner.has(stmt.field)) inner.set(stmt.field, { argName, argType, defaultValue });
    }
  }

  // ── (3) Derive PDA seeds for every PDA collected above ──
  // Build TypeName::CONST_NAME → byte-string-literal lookup from impl items
  // of every account + type def. Anchor programs commonly declare
  // `impl Foo { pub const SEED_PREFIX: &'static [u8; N] = b"literal"; }`
  // and reference it from a PDA seeds = [Foo::SEED_PREFIX, ...] block.
  // Synthesizer can't read const arithmetic, but b"..." literals fold to a
  // single bytes value we can emit as a seed verbatim.
  const sourceConstLookup = new Map<string, string>();
  const collectConsts = (typeName: string, implItems: string[] | undefined) => {
    for (const item of implItems ?? []) {
      for (const m of item.matchAll(/\bpub\s+const\s+([A-Z][A-Z0-9_]*)\s*:\s*&'?(?:'static)?\s*\[u8\s*;\s*\d+\]\s*=\s*b"([^"]+)"\s*;/g)) {
        if (m[1] && m[2]) sourceConstLookup.set(`${typeName}::${m[1]}`, `b"${m[2]}"`);
      }
      // Also accept the &[u8] (no length) form.
      for (const m of item.matchAll(/\bpub\s+const\s+([A-Z][A-Z0-9_]*)\s*:\s*&'?(?:'static)?\s*\[u8\]\s*=\s*b"([^"]+)"\s*;/g)) {
        if (m[1] && m[2]) sourceConstLookup.set(`${typeName}::${m[1]}`, `b"${m[2]}"`);
      }
    }
  };
  for (const ad of ir.accounts) collectConsts(ad.name, ad.implItems);
  for (const td of ir.types) collectConsts(td.name, td.implItems);

  const pdaSpecs = new Map<string, { seeds: string[]; sourceIx: string; programOverride?: string }>();
  // Pre-compute known-program account-name → program-tag map. PDA seeds
  // shaped `token_metadata_program.key().as_ref()` route through this so
  // the seed encoder can emit `$program:mpl_token_metadata.pubkey`
  // (the canonical Metaplex Token Metadata program ID) instead of an
  // unresolved-account block.
  const knownProgramAccountNames = new Map<string, string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      const tag = KNOWN_PROGRAM_TYPES[acc.accountType];
      if (tag && !knownProgramAccountNames.has(acc.name)) {
        knownProgramAccountNames.set(acc.name, tag);
      }
    }
  }
  for (const ix of ir.instructions) {
    // Build per-instruction arg-type map so synthesizeSeeds can resolve
    // arg-derived seed expressions (`<arg>.to_le_bytes()`, `<arg>.as_ref()`)
    // to typed-int / bytes:0x literals using the auto-defaulted arg values.
    const ixArgTypes = new Map<string, string>();
    for (const a of ix.args) ixArgTypes.set(a.name, a.type);
    for (const acc of ix.accounts) {
      if (acc.isPda && !pdaSpecs.has(acc.name)) {
        const seedResult = synthesizeSeeds(
          acc.pdaSeeds,
          signerNames,
          allPdaNames,
          mintNames,
          stateFieldMap,
          ixArgTypes,
          acc.name,
          stateNumericFieldMap,
          initdEphemeralNames,
          stateTypeNames,
          sourceConstLookup,
          knownProgramAccountNames,
        );
        if (!seedResult.ok) {
          blockers.push({
            message: `PDA \`${acc.name}\` (in instruction \`${ix.name}\`) has seeds Anvil can't auto-derive: ${seedResult.reason}. Provide the seeds via "Edit as JSON".`,
            context: { instruction: ix.name, account: acc.name },
          });
          continue;
        }
        // Detect `seeds::program = <expr>` constraint and resolve to a
        // program-tag override (Metaplex metadata PDAs are derived
        // against the Metaplex Token Metadata program ID, not the
        // current program).
        const seedsProgramC = acc.constraints?.find((c) => c.kind === "seeds::program");
        let programOverride: string | undefined;
        if (seedsProgramC?.value) {
          const v = seedsProgramC.value.trim();
          // Common shape: `<account_name>.key()`. Resolve to the known
          // program tag if the account is a known program.
          const m = v.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.key\(\)$/);
          if (m?.[1]) {
            const tag = knownProgramAccountNames.get(m[1]);
            if (tag) programOverride = `$program:${tag}.pubkey`;
          }
        }
        pdaSpecs.set(acc.name, { seeds: seedResult.seeds, sourceIx: ix.name, programOverride });
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
      // Non-init Mints are handled by $mint synthesis (S1).
      if (acc.accountType === "Mint" && !acc.isInit) continue;
      // Non-init TokenAccounts are handled by $ata synthesis (S2).
      if (acc.accountType === "TokenAccount" && !acc.isInit && tokenAccountSpecs.has(acc.name)) continue;
      // It's a custom account type without an `init`-derived PDA.
      // Could be: an existing PDA from an earlier handler, OR an externally-
      // created account the user must provide. We can't tell from the IR
      // alone -- block.
      const isStateType = ir.accounts.some((a) => a.name === acc.accountType);
      if (isStateType) {
        // State-typed account, not declared as PDA in this slot. If an
        // earlier instruction did declare it as a PDA, we'll route to
        // $pda:name at scenario-build time (cross-instruction PDA reuse)
        // — no warning needed. Otherwise it's an externally-created
        // account the user must point at; warn but don't block.
        if (pdaSpecs.has(acc.name)) continue;
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

  // ── (4a) Detect Signers that are `to` targets of system_program::create_account ──
  // These signers must have 0 lamports at scenario start. Anchor's `init`
  // constraint generates this CPI internally; user-level create_account in
  // a pass_through body (rent-pe / create-account / pda-rent-payer-pe) does
  // it explicitly. The to-account must be empty for SystemProgram to
  // allocate it. If we airdrop, create_account fails with InvalidAccountData.
  // Detection: regex over pass_through bodies for `to: ctx.accounts.<NAME>.to_account_info()`
  // inside a system_program::CreateAccount struct literal, OR within an
  // invoke(&system_instruction::create_account(...)) form.
  const createAccountTargetNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const stmt of ix.body) {
      if (stmt.kind !== "pass_through") continue;
      const code = stmt.code;
      // Anchor wrapper shape: CreateAccount { from: ..., to: ctx.accounts.X.to_account_info() }
      const m1 = code.matchAll(/CreateAccount\s*\{[^}]*?\bto\s*:\s*ctx\.accounts\.([a-zA-Z_][a-zA-Z0-9_]*)\.to_account_info\(\)/gs);
      for (const m of m1) {
        if (m[1] && signerNames.has(m[1])) createAccountTargetNames.add(m[1]);
      }
      // system_instruction::create_account(&from_pk, &to_pk, ...) form — `to_pk`
      // typically resolves through a let binding the same instruction sets up.
      // For our 32-fixture corpus the Anchor CreateAccount wrapper covers
      // every case; leaving the second shape for a follow-up if needed.
    }
  }
  // When a Signer is ALSO the first signer (fee payer) of some instruction
  // AND a create_account target, it can't be airdrop=0 — the tx-fee
  // deduction needs lamports to come from somewhere. But airdrop=10 SOL
  // breaks the create_account CPI which requires `to` lamports == 0.
  // Compromise: airdrop exactly the single-signature tx fee (5000 lamports);
  // after the fee deduction during txn processing the account hits 0
  // lamports and create_account succeeds (pda-rent-payer-pe pattern).
  const firstSignerNames = new Set<string>();
  for (const ix of ir.instructions) {
    const first = ix.accounts.find((a) => isSignerAccount(a.accountType));
    if (first) firstSignerNames.add(first.name);
  }
  const createAccountTargetsFeePayer = new Set<string>();
  for (const name of createAccountTargetNames) {
    if (firstSignerNames.has(name)) createAccountTargetsFeePayer.add(name);
  }
  for (const fn of createAccountTargetsFeePayer) createAccountTargetNames.delete(fn);

  // ── (4a2) Detect `#[account(zero)]` state-typed accounts ──
  // Anchor's `zero` constraint requires the account to be (a) owned by the
  // program, (b) have a zero discriminator, and (c) have enough data to
  // hold the serialized state. The offchain client typically pre-creates
  // these via system_program::create_account before submitting. The runner
  // installs a zeroed buffer of the right size + owner=programId.
  const preZeroedAccounts: Array<{ name: string; size: number }> = [];
  const accountDefByName = new Map(ir.accounts.map((a) => [a.name, a]));
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      const hasZeroC = acc.constraints?.some((c) => c.kind === "zero");
      if (!hasZeroC) continue;
      // Must be state-typed (matches a struct in ir.accounts). Anchor's
      // `zero` only makes sense on Account<'info, T> shapes.
      const ad = accountDefByName.get(acc.accountType);
      if (!ad) continue;
      // Already collected (same name across instructions): skip.
      if (preZeroedAccounts.some((p) => p.name === acc.name)) continue;
      // Compute byte size: 8 (disc) + sum of field sizes.
      const bodySize = ad.fields.reduce(
        (sum, f) => sum + typeSize(f.type, f.maxLen),
        0,
      );
      preZeroedAccounts.push({ name: acc.name, size: 8 + bodySize });
    }
  }

  // ── (4b) Identify $keypair: accounts with `owner = id()` constraint ──
  // Anchor's runtime constraint check rejects System-Program-owned accounts
  // against `owner = id()`. The runner pre-creates these as program-owned
  // via svm.setAccount before step 0; otherwise we hit ConstraintOwner (2004).
  // Limit to non-PDA non-Signer non-program ephemeral keypairs — PDAs are
  // already program-owned by derivation, and the other types have explicit
  // owners enforced by the runner.
  const preOwnedKeypairs = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.isPda) continue;
      if (isSignerAccount(acc.accountType)) continue;
      if (KNOWN_PROGRAM_TYPES[acc.accountType]) continue;
      if (acc.accountType === "Mint") continue;
      if (acc.accountType === "TokenAccount") continue;
      const ownerC = acc.constraints?.find((c) => c.kind === "owner");
      if (!ownerC) continue;
      // Common shapes for "owned by this program": id(), crate::id(), &id(), ID, crate::ID.
      const v = (ownerC.value ?? "").replace(/\s|&/g, "");
      if (/^(crate::)?id\(\)$/i.test(v) || /^(crate::)?ID$/.test(v)) {
        preOwnedKeypairs.add(acc.name);
      }
    }
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
      // Timestamp args (`*_ts`, `start`, `cliff`, `end`, etc.) get
      // ordering-aware defaults derived from the pinned clock so the
      // common `require!(start_ts >= clock.unix_timestamp)` /
      // `require!(end_ts > cliff_ts)` patterns pass without editing.
      // Amount-shaped args (`amount`, `_in`, `size`, etc.) bump to 1
      // unit at 6dp so AMM-style flows don't drain reserves.
      const isInt = /^([ui])(8|16|32|64)$/.test(arg.type);
      const tsDefault = isInt ? defaultForTimestampArg(arg.name) : undefined;
      const amountDefault = isInt && tsDefault === undefined ? defaultForAmountArg(arg.name) : undefined;
      if (tsDefault !== undefined) {
        args[arg.name] = tsDefault;
      } else if (amountDefault !== undefined) {
        args[arg.name] = amountDefault;
      } else if (DEFAULT_VALUES[arg.type] !== undefined) {
        args[arg.name] = DEFAULT_VALUES[arg.type];
      } else if (/^([ui])(8|16|32|64|128)$/.test(arg.type)) {
        args[arg.name] = 1;
      } else if (/^Vec<(.+)>$/.test(arg.type) && isPrimitiveType(arg.type)) {
        args[arg.name] = defaultPrimitiveValue(arg.type);
      } else {
        // Custom type -- attempt to walk the TypeDef. synthesizeCustomTypeDefault
        // returns undefined when the type isn't in IR.types; the (1) blocker
        // pass above already filtered those, so this should always succeed
        // here. Fall back to null as a sentinel the user can replace.
        const synthesized = synthesizeCustomTypeDefault(arg.type, ir);
        args[arg.name] = synthesized ?? null;
      }
      notes.push({
        message: `Auto-defaulted \`${ix.name}.${arg.name}\` (${arg.type}) to ${JSON.stringify(args[arg.name])}. Edit if your test needs a different value.`,
        context: { instruction: ix.name, arg: arg.name },
      });
    }
    const accounts: string[] = ix.accounts.map((acc) => {
      if (isSignerAccount(acc.accountType)) return `$signer:${acc.name}`;
      if (acc.isPda) return `$pda:${acc.name}`;
      // Same-named PDA reused across instructions: when an earlier ix
      // declared `market` with `seeds=[…]` and a later ix references
      // `pub market: Account<'info, Market>` (no seeds — Anchor just
      // needs a perp-funding-owned account), the later slot lacks the
      // PDA flag but still refers to the same on-chain pubkey. Without
      // this, the synthesizer routes the second slot to $keypair:market
      // (fresh random pubkey) and Anchor rejects with
      // AccountOwnedByWrongProgram (Left=system, Right=program).
      if (pdaSpecs.has(acc.name)) return `$pda:${acc.name}`;
      if (acc.accountType === "Mint" && !acc.isInit && mintNames.has(acc.name)) {
        return `$mint:${acc.name}`;
      }
      if (acc.accountType === "TokenAccount" && tokenAccountSpecs.has(acc.name)) {
        // Init'd-non-derived TokenAccounts that are in tokenAccountSpecs
        // shouldn't reach here — the spec is only populated for derived
        // ATAs (init'd) or non-init user TAs. But guard the !isInit ||
        // derived shape just in case future synth changes loosen it.
        const spec = tokenAccountSpecs.get(acc.name)!;
        if (!acc.isInit || spec.derived) return `$ata:${acc.name}`;
      }
      const knownProg = KNOWN_PROGRAM_TYPES[acc.accountType];
      if (knownProg) return `$program:${knownProg}`;
      // Fallback: ephemeral keypair (lazy-generated by the runner).
      return `$keypair:${acc.name}`;
    });
    return { ix: ix.name, args, accounts, expectFail: false };
  });

  // ── (6b) Negative/expectFail probes (#14) ──
  // Happy-path-only scenarios can't see a DROPPED access-control guard: a
  // transpile that silently removed `has_one = owner` still passes every valid
  // call. For each instruction with a violatable has_one guard we insert an
  // `expectFail` step BEFORE its happy step that re-invokes it with an
  // unauthorized signer. Both targets MUST revert (Anchor: ConstraintHasOne).
  // If the transpile dropped the check, Anvil ACCEPTS the caller Anchor
  // REJECTS → the served comparator's revert-parity (#13) flags DIVERGED.
  // Inserted before (not after) the happy step so the guarded account is set
  // up but not yet consumed, and a dropped-guard Anvil would genuinely succeed.
  let effectiveSteps = steps;
  let attackerNeeded = false;
  let payerNeeded = false;
  if (opts.negativeProbes) {
    const interleaved: ScenarioStep[] = [];
    for (const happy of steps) {
      const ix = ir.instructions.find((i) => i.name === happy.ix);
      if (ix) {
        // (a) has_one guard — unauthorized (wrong) but SIGNING caller.
        const hasOneProbe = buildHasOneNegativeProbe(ix, happy, NEGATIVE_PROBE_ATTACKER);
        if (hasOneProbe) {
          interleaved.push(hasOneProbe.step);
          attackerNeeded = true;
          notes.push({
            message: `Negative probe before \`${happy.ix}\`: re-invokes it with an unauthorized \`${hasOneProbe.field}\` (has_one guard) and asserts BOTH targets revert. A transpile that dropped the check lets Anvil accept a caller Anchor rejects → DIVERGED.`,
            context: { instruction: happy.ix },
          });
        }
        // (b) signer guard — the RIGHT account, but it didn't sign. Catches the
        // dropped-`Signer`/`#[account(signer)]` class (#30) that has_one misses.
        const signerProbe = buildMissingSignerProbe(ix, happy);
        if (signerProbe) {
          interleaved.push(signerProbe.step);
          payerNeeded = true;
          notes.push({
            message: `Negative probe before \`${happy.ix}\`: re-invokes it with \`${signerProbe.field}\` present but NOT signing, and asserts BOTH targets revert. A transpile that dropped the signer check lets Anvil accept an unsigned caller Anchor rejects → DIVERGED.`,
            context: { instruction: happy.ix },
          });
        }
      }
      interleaved.push(happy);
    }
    effectiveSteps = interleaved;
  }

  // ── (7) Comparison config ──
  // Compare every PDA + every program-managed account whose state can
  // diverge between targets:
  //   - PDAs (state, vaults) — emit-quality of state writes
  //   - Mints we synthesize ($mint:foo) — pre-state is byte-identical, but
  //     a program may mint/burn against them, shifting supply
  //   - ATAs we synthesize ($ata:foo) — most common divergence surface
  //     (transfer_checked / mint_to / burn results)
  //   - $keypair:foo refs that are init'd by some instruction (AMM's
  //     lp_mint pattern) — without these, an emitter that drops Mint init
  //     entirely produces a passing verdict because nothing in the compare
  //     set looked at the un-init'd account
  // Use tagged names ($mint:foo etc) so the runner's snapshot lookup can
  // disambiguate buckets when names overlap.
  const comparedAccounts = new Set<string>();
  for (const pdaName of pdaSpecs.keys()) comparedAccounts.add(pdaName);
  for (const mintName of mintNames) comparedAccounts.add(`$mint:${mintName}`);
  for (const taName of tokenAccountSpecs.keys()) comparedAccounts.add(`$ata:${taName}`);
  // Init'd-non-PDA accounts referenced in any step come back as $keypair:foo
  // — capture those too. Excludes mint/ata names already added above.
  const initdKeypairCompareNames = new Set<string>();
  for (const ix of ir.instructions) {
    for (const acc of ix.accounts) {
      if (acc.isInit && !acc.isPda && !mintNames.has(acc.name) && !tokenAccountSpecs.has(acc.name)) {
        initdKeypairCompareNames.add(acc.name);
      }
    }
  }
  for (const name of initdKeypairCompareNames) comparedAccounts.add(`$keypair:${name}`);
  // Signers — both targets pay rent for init'd accounts and the same fees,
  // so post-step lamport balance is deterministic. Adding them widens the
  // verifiable claim to the full account set the scenario touches.
  for (const name of signerNames) comparedAccounts.add(`$signer:${name}`);
  // Compare the negative-probe attacker too. It only ever pays a reverted
  // probe tx's base fee (deterministic, identical on both targets), so its
  // post-run balance byte-equals — and comparing it keeps the scenario from
  // tripping the partial_compare_scope sanity check (which would downgrade an
  // otherwise-clean BYTE_EQUAL to WITH_WARNINGS just because the probe added a
  // touched-but-uncompared signer).
  if (attackerNeeded) comparedAccounts.add(`$signer:${NEGATIVE_PROBE_ATTACKER}`);
  if (payerNeeded) comparedAccounts.add(`$signer:${NEGATIVE_PROBE_PAYER}`);
  // Detect emit/msg usage to suggest opt-in compares.
  let usesEmit = false;
  let usesEmitCpi = false;
  let usesMsg = false;
  for (const ix of ir.instructions) {
    for (const stmt of ix.body) {
      if (stmt.kind === "emit") {
        usesEmit = true;
        if ((stmt as { viaCpi?: boolean }).viaCpi) usesEmitCpi = true;
      }
      if (stmt.kind === "msg") usesMsg = true;
    }
  }
  // emit!() events ARE byte-equal across targets (same sol_log_data), so
  // comparing them is a real signal. emit_cpi!() is NOT: Anvil collapses it to
  // a direct log while Anchor self-CPIs to the event_authority PDA, so the
  // event stream + step success diverge -> false DIVERGED. Only compare events
  // when the program uses emit!() and NOT emit_cpi!().
  const compareEventLogs = usesEmit && !usesEmitCpi;
  if (compareEventLogs) {
    notes.push({
      message: "Program uses emit!() -- enabled compareEventLogs. Both targets must produce byte-identical event payloads.",
    });
  } else if (usesEmitCpi) {
    notes.push({
      message: "Program uses emit_cpi!() -- left compareEventLogs OFF. Anvil emits a direct log while Anchor self-CPIs to the event_authority PDA, so event streams legitimately differ; comparing them would be a false divergence.",
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

  // Ensure at least one signer exists — every Solana tx needs a fee
  // payer. Programs with zero Signer<'info> accounts in their handlers
  // (hello-world, anchor-sysvars, processing-instructions, etc.) still
  // need someone to sign the outer transaction, otherwise the runner
  // refuses with "no signer available to pay fees".
  const allSigners = [...signerNames];
  // Declare the unauthorized-caller keypair used by negative probes so the
  // runner can generate + airdrop it. (It's also added to compare.accounts
  // above — its reverted-tx fee is deterministic, so comparing it is safe.)
  if (attackerNeeded) allSigners.push(NEGATIVE_PROBE_ATTACKER);
  // The missing-signer probe's dedicated fee payer MUST be signers[0] so the
  // runner's "no step signer → scenario.signers[0]" fallback pays the tx
  // instead of the de-signed account (which would otherwise be forced-signer
  // via the fee-payer slot, defeating the probe). unshift = index 0.
  if (payerNeeded) allSigners.unshift(NEGATIVE_PROBE_PAYER);
  if (allSigners.length === 0) {
    allSigners.push("__fee_payer");
    notes.push({
      message:
        "Auto-scenario added a synthetic `__fee_payer` signer because the program declares no Signer<'info> accounts. This signer pays the transaction fee but isn't referenced by any instruction handler.",
    });
    // Compare the synthetic fee payer too — without this, trivial
    // single-step programs report "byte-equal 0 accts compared" which
    // is a false-positive (nothing was compared, so equality is
    // trivial). The fee payer's lamport balance after the step is the
    // smallest non-trivial verifiable invariant.
    comparedAccounts.add(`$signer:__fee_payer`);
  }
  const scenario: Scenario = {
    version: 1,
    // 10 SOL airdrop per signer. The 2 SOL default surfaced as InsufficientFunds
    // on programs that init multiple large accounts via system::create_account
    // (pda-rent-payer-pe, anchor-bench-style benchmarks). Each rent-exempt
    // account costs ~1-7M lamports; 10 SOL is comfortably above the realistic
    // worst case for the 32-fixture corpus.
    signers: allSigners.map<SignerDecl>((name) => ({
      name,
      // Signers that show up as `to:` in system_program::create_account must
      // start at 0 lamports — the CPI fails otherwise. See (4a) above.
      // If the same signer is the fee payer somewhere, airdrop the single-sig
      // tx fee (5000 lamports) so the post-fee balance hits 0 and the CPI
      // still succeeds.
      airdrop: createAccountTargetNames.has(name)
        ? 0
        : createAccountTargetsFeePayer.has(name)
          ? 5_000
          : 10_000_000_000,
    })),
    pdas: [...pdaSpecs.entries()].map<PdaDecl>(([name, spec]) =>
      spec.programOverride
        ? { name, seeds: spec.seeds, programOverride: spec.programOverride }
        : { name, seeds: spec.seeds }),
    mints: [...mintNames].map<MintDecl>((name) => ({
      name,
      decimals: 6,
      supply: 0,
      program: "token",
      // mintAuthority defaults to first signer at runtime.
    })),
    tokenAccounts: [...tokenAccountSpecs.entries()].map<TokenAccountDecl>(([name, spec]) => ({
      name,
      mint: spec.mint,
      owner: spec.owner,
      // Program-creates accounts start at 0 (the init CPI sets up the layout).
      // Pre-installed accounts (whether derived ATA or random keypair) get
      // the default 1B balance so transfer_checked / mint_to CPIs succeed.
      balance: spec.programInits ? 0 : 1_000_000_000,
      program: "token",
      derived: spec.derived,
      programInits: spec.programInits,
    })),
    steps: effectiveSteps,
    preOwnedKeypairs: [...preOwnedKeypairs],
    preZeroedAccounts,
    compare: {
      accounts: [...comparedAccounts],
      lamports: true,
      owner: true,
      eventLogs: compareEventLogs,
      msgLogs: false,
      returnData: false,
    },
    assertions: [],
    clock,
  };

  return { ok: true, scenario, notes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * #14 — Build a negative/expectFail probe for a `has_one` access-control guard.
 *
 * Given an instruction with `#[account(has_one = X)]` where X is a Signer,
 * clone its happy step but pass a fresh unauthorized signer (`attackerSigner`)
 * in X's slot. Both targets MUST revert (Anchor: ConstraintHasOne). If the
 * transpile silently dropped the has_one check, Anvil ACCEPTS the unauthorized
 * caller while Anchor REJECTS it → the comparator's revert-parity (#13) flips
 * the verdict to DIVERGED. Returns null when no safe probe can be built.
 *
 * Conservative on purpose — only emits when the swap is type-preserving and the
 * revert is attributable to the guard, so a CORRECT transpile always reverts on
 * BOTH sides (no false DIVERGED):
 *   - init handlers are skipped (re-invoking reverts for already-initialized
 *     reasons, not the guard — a dropped guard wouldn't diverge);
 *   - only a `has_one` target that is itself a Signer is swapped (keeps a
 *     Signer<'info> slot filled by a signer — only identity changes);
 *   - the happy step must reference that slot cleanly as `$signer:<target>`.
 */
function buildHasOneNegativeProbe(
  ix: SolanaIR["instructions"][number],
  happyStep: ScenarioStep,
  attackerSigner: string,
): { step: ScenarioStep; field: string } | null {
  if (ix.accounts.some((a) => a.isInit)) return null;

  for (const acc of ix.accounts) {
    for (const c of acc.constraints) {
      if (c.kind !== "has_one" || !c.value) continue;
      const targetName = c.value;
      const targetIdx = ix.accounts.findIndex((a) => a.name === targetName);
      if (targetIdx < 0) continue;
      const target = ix.accounts[targetIdx]!;
      if (!target.isSigner) continue;
      if (happyStep.accounts[targetIdx] !== `$signer:${targetName}`) continue;

      const accounts = [...happyStep.accounts];
      accounts[targetIdx] = `$signer:${attackerSigner}`;
      return {
        field: targetName,
        step: {
          ix: ix.name,
          args: happyStep.args,
          accounts,
          expectFail: true,
          label: `unauthorized ${targetName} (has_one) on ${ix.name} — must revert`,
        },
      };
    }
  }
  return null;
}

/**
 * #14 — Build a negative/expectFail probe for a signer guard (`Signer<'info>`
 * or `#[account(signer)]`).
 *
 * Given a non-init instruction with a signer account passed cleanly as
 * `$signer:X`, clone the happy step but pass that slot as `$unsigned:X` — the
 * SAME account, present and legitimate, but not signing. Anchor's signer check
 * must reject it; a transpile that dropped the check (the #30 auth-bypass class,
 * which the has_one probe does NOT cover) accepts an unsigned caller → the
 * revert-parity comparator flags DIVERGED. Returns null when no safe probe can
 * be built.
 *
 * De-signs the FIRST signer slot only (one probe per instruction). The runner
 * pairs this with the `__probe_payer` fee payer so the de-signed account isn't
 * forced-signer via the fee-payer slot. Init handlers are skipped (re-invoking
 * reverts for already-initialized reasons, not the guard).
 */
function buildMissingSignerProbe(
  ix: SolanaIR["instructions"][number],
  happyStep: ScenarioStep,
): { step: ScenarioStep; field: string } | null {
  if (ix.accounts.some((a) => a.isInit)) return null;

  for (let slot = 0; slot < ix.accounts.length; slot++) {
    const acc = ix.accounts[slot]!;
    if (!acc.isSigner) continue;
    if (happyStep.accounts[slot] !== `$signer:${acc.name}`) continue;

    const accounts = [...happyStep.accounts];
    accounts[slot] = `$unsigned:${acc.name}`;
    return {
      field: acc.name,
      step: {
        ix: ix.name,
        args: happyStep.args,
        accounts,
        expectFail: true,
        label: `missing signature for ${acc.name} on ${ix.name} — must revert`,
      },
    };
  }
  return null;
}

function isPrimitiveType(t: string): boolean {
  if (DEFAULT_VALUES[t] !== undefined) return true;
  // Numeric primitive shapes Anvil's IR may emit
  if (/^([ui])(8|16|32|64|128)$/.test(t)) return true;
  // Vec<T> where T is itself a primitive — synth can default these
  // (empty array for Vec<integer>, single-element placeholder for
  // Vec<Pubkey>). Inner type is checked recursively.
  const vecMatch = t.match(/^Vec<(.+)>$/);
  if (vecMatch?.[1]) return isPrimitiveType(vecMatch[1]);
  // Option<T> where T is primitive — synth defaults to None (1 byte
  // borsh tag = 0x00). cashiers-check uses Option<String>. Both
  // targets serialize None identically.
  const optMatch = t.match(/^Option<(.+)>$/);
  if (optMatch?.[1]) return isPrimitiveType(optMatch[1]);
  return false;
}

/** Synthesize a default value for a primitive type. Mirrors DEFAULT_VALUES
 *  but handles generic Vec<T> recursively. Vec<Pubkey> gets a single
 *  System-program placeholder so multisig-style threshold checks
 *  (threshold ≤ owners.len()) at least pass at step 0; downstream steps
 *  whose semantics expect specific pubkeys still need manual edits. */
function defaultPrimitiveValue(type: string): unknown {
  if (DEFAULT_VALUES[type] !== undefined) return DEFAULT_VALUES[type];
  if (/^([ui])(8|16|32|64|128)$/.test(type)) {
    return /128$/.test(type) ? "1" : 1;
  }
  const vecMatch = type.match(/^Vec<(.+)>$/);
  if (vecMatch?.[1]) {
    const inner = vecMatch[1];
    if (inner === "Pubkey") return ["11111111111111111111111111111111"];
    return [];
  }
  // Option<T> → None (null in the synthesized JSON; borsh serializes
  // None as a single 0x00 tag byte. Both targets produce identical bytes.)
  if (/^Option<(.+)>$/.test(type)) return null;
  return undefined;
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
  pdaNames: Set<string>,
  mintNames: Set<string>,
  stateFieldMap: Map<string, Map<string, string>>,
  argTypes: Map<string, string>,
  accountName: string,
  stateNumericFieldMap: Map<string, Map<string, { argName: string; argType: string; defaultValue: number }>>,
  initdEphemeralNames: Set<string> = new Set(),
  stateTypeNames: Set<string> = new Set(),
  sourceConstLookup: Map<string, string> = new Map(),
  knownProgramAccountNames: Map<string, string> = new Map(),
): SeedSynthesis {
  const resolveStateNumericField = (
    accName: string,
    fieldName: string,
  ): string | undefined => {
    const entry = stateNumericFieldMap.get(accName)?.get(fieldName);
    if (!entry) return undefined;
    return `${entry.argType}:${entry.defaultValue}`;
  };

  if (rawSeeds.length === 0) {
    return { ok: false, seeds: [], reason: `account \`${accountName}\` has no seeds in its IR (PDAs need at least one seed)` };
  }
  const out: string[] = [];
  for (const seed of rawSeeds) {
    // Strip leading `&` — common in Rust seed-arrays e.g. `&seed.to_le_bytes()`.
    // Auto-scenario synthesis is value-level, so the borrow is irrelevant.
    const trimmed = seed.trim().replace(/^&\s*/, "");

    // b"literal" → keep
    if (/^b"[^"]+"$/.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    // b"literal".as_ref() / b"literal".as_bytes() → the literal. The byte-slice
    // view of a byte-string literal is the literal itself; idiomatic in seed
    // arrays (`seeds = [b"poll".as_ref(), ...]`). Without this, any program
    // that writes the .as_ref() form blocks auto-scenario byte-equal.
    const byteLitChain = trimmed.match(/^(b"[^"]+")\.(?:as_ref|as_bytes)\(\)$/);
    if (byteLitChain?.[1]) {
      out.push(byteLitChain[1]);
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
    // Qualified const path: `TypeName::CONST_NAME` (e.g. PageVisits::SEED_PREFIX).
    // The const declarations live in ir.accounts[].implItems /
    // ir.types[].implItems; collectConsts scanned them for byte-literal
    // values. If we have the exact const declared as a b"..." literal,
    // substitute. Falls through to the convention-based ALL_CAPS heuristic
    // below when unresolved.
    if (/^[A-Z][A-Za-z0-9_]*::[A-Z][A-Z0-9_]+$/.test(trimmed)) {
      const lit = sourceConstLookup.get(trimmed);
      if (lit) { out.push(lit); continue; }
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
    // <signer>.key().as_ref() / <signer>.key.as_ref() / <pda>.key().as_ref() / <mint>.key().as_ref()
    // Also accept the .to_account_info().key shape (cashiers-check pattern):
    // `check.to_account_info().key.as_ref()` is semantically identical to
    // `check.key().as_ref()` — both yield the account's pubkey.
    const signerKeyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.to_account_info\(\))?\.key(?:\(\))?\.as_ref\(\)$/);
    if (signerKeyMatch?.[1]) {
      const name = signerKeyMatch[1];
      if (signerNames.has(name)) {
        out.push(`$signer:${name}.pubkey`);
        continue;
      }
      if (pdaNames.has(name)) {
        out.push(`$pda:${name}.pubkey`);
        continue;
      }
      if (mintNames.has(name)) {
        out.push(`$mint:${name}.pubkey`);
        continue;
      }
      // Known-program account references (e.g. `token_metadata_program.key()
      // .as_ref()`). The account is a Program<'info, Metadata>; its pubkey
      // is the canonical program ID (metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
      // for Metaplex). Emit `$program:<tag>.pubkey` — runner resolves to
      // the program's stable pubkey.
      const programTag = knownProgramAccountNames.get(name);
      if (programTag) {
        out.push(`$program:${programTag}.pubkey`);
        continue;
      }
      // B2f fix — init'd Mint / TokenAccount / state account referenced in
      // a seed. The program creates the account at scenario-run time with
      // a fresh ephemeral keypair as signer; the seed must resolve to that
      // keypair's pubkey. Common shape: nft-minter / pda-mint-authority
      // where `mint_account` is init'd and `metadata` is a PDA seeded by
      // `mint_account.key().as_ref()`.
      if (initdEphemeralNames.has(name)) {
        out.push(`$keypair:${name}.pubkey`);
        continue;
      }
      // B2f fix (state-account form) — zero-copy / similar: `foo: AccountLoader<Foo>`
      // where Foo is a user-defined state struct. Scenario runner pre-creates a
      // fresh keypair. Both targets see the same pubkey → byte-equal PDA derivation.
      if (stateTypeNames.has(name)) {
        out.push(`$keypair:${name}.pubkey`);
        continue;
      }
      // Cross-account seed reference to something that is neither a signer,
      // PDA, nor pre-creatable Mint. Block with a clear pointer to the
      // manual JSON-edit path.
      return {
        ok: false,
        seeds: [],
        reason: `seed references account \`${name}\` which isn't a signer, PDA, or pre-creatable Mint in this program. Auto-scenario can't pre-create externally-supplied accounts of unknown type; author the scenario manually via "Edit as JSON".`,
      };
    }
    // <X>.bump → embedded bump byte. Defer to runtime PDA derivation.
    if (/\.bump$/.test(trimmed)) {
      // Skip -- find_program_address will derive the canonical bump.
      continue;
    }
    // <state>.field.as_ref() / <state>.field.to_le_bytes() -- state-derived
    // seed reference. We resolve at synthesis time by walking the IR's
    // body for `<state>.<field> = ctx.accounts.<src>.key()` assignments and
    // mapping back to the source account's tag. AMM's add_liquidity has
    // seeds = [b"pool", pool.token_mint_a.as_ref(), pool.token_mint_b.as_ref()]
    // — initialize_pool's body sets pool.token_mint_a = ctx.accounts.token_mint_a.key(),
    // so we emit `$mint:token_mint_a.pubkey` (same value the program will
    // see at runtime).
    //
    // .to_le_bytes() shapes (numeric state fields) aren't handled — those
    // would need to know the value at synthesis time, which we don't.
    const stateFieldMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\.as_ref\(\)$/);
    if (stateFieldMatch?.[1] && stateFieldMatch[2]) {
      const src = stateFieldMap.get(stateFieldMatch[1])?.get(stateFieldMatch[2]);
      if (src) {
        if (signerNames.has(src)) { out.push(`$signer:${src}.pubkey`); continue; }
        if (pdaNames.has(src)) { out.push(`$pda:${src}.pubkey`); continue; }
        if (mintNames.has(src)) { out.push(`$mint:${src}.pubkey`); continue; }
      }
      return {
        ok: false,
        seeds: [],
        reason: `seed \`${trimmed}\` is state-derived (reads field \`${stateFieldMatch[2]}\` of account \`${stateFieldMatch[1]}\`). Auto-scenario traced the source assignment but couldn't resolve it to a known signer/PDA/mint. Author the seed manually via "Edit as JSON".`,
      };
    }
    // <state>.field.to_le_bytes() / <state>.field.to_le_bytes().as_ref() —
    // numeric state field. Resolve at synthesis time when the source
    // assignment in any instruction's body is `<state>.<field> = <arg>`
    // and <arg> is an instruction arg with a known auto-defaulted value
    // — both targets serialize that value identically, byte-equal seed.
    const stateNumericMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\.(to_le_bytes\(\)|to_le_bytes\(\)\.as_ref\(\))$/);
    if (stateNumericMatch?.[1] && stateNumericMatch[2]) {
      const resolved = resolveStateNumericField(stateNumericMatch[1], stateNumericMatch[2]);
      if (resolved) {
        out.push(resolved);
        continue;
      }
      return {
        ok: false,
        seeds: [],
        reason: `seed \`${trimmed}\` reads numeric state field \`${stateNumericMatch[2]}\` of account \`${stateNumericMatch[1]}\`; auto-scenario could not trace its value to a defaulted instruction arg. Replace with explicit \`bytes:0x…\` via "Edit as JSON".`,
      };
    }
    // <arg>.<chain>: single-segment receiver followed by one or two of
    // {as_ref(), to_le_bytes()}. State-derived shapes (`<acc>.<field>.<chain>`)
    // are matched ABOVE this branch.
    //
    // Resolution: if the receiver is an instruction arg, we know its
    // auto-defaulted value (1 for ints, System program ID for Pubkey, etc).
    // Emit a typed-int / bytes:0x literal so both targets see the same seed
    // bytes at runtime. Both targets get the same default args, so the PDA
    // derived from these seeds is deterministic across runs.
    const argRefMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(as_ref\(\)|to_le_bytes\(\)|to_le_bytes\(\)\.as_ref\(\)|as_bytes\(\))$/);
    if (argRefMatch?.[1]) {
      const argName = argRefMatch[1];
      const chain = argRefMatch[2]!;
      const argType = argTypes.get(argName);
      if (argType) {
        // Numeric: <arg>.to_le_bytes() → "u64:1" / "i32:1" / etc.
        // Both targets serialize the auto-defaulted u64=1 the same way.
        const intMatch = argType.match(/^([ui])(8|16|32|64|128)$/);
        if (intMatch && (chain === "to_le_bytes()" || chain === "to_le_bytes().as_ref()")) {
          out.push(`${argType}:1`);
          continue;
        }
        // Pubkey: <arg>.as_ref() → bytes:0x<system_program_id_bytes>.
        // Auto-scenario defaults Pubkey args to System program ID — encode
        // its 32-byte representation as hex.
        if (argType === "Pubkey" && chain === "as_ref()") {
          // System program ID is all-zero (32 bytes of 0x00).
          out.push(`bytes:0x${"00".repeat(32)}`);
          continue;
        }
        // String: <arg>.as_bytes() / <arg>.as_ref() → bytes:0x<utf8 bytes of
        // default string>. Auto-scenario defaults String args to "test" (4
        // bytes). t22-basics uses `_token_name.as_bytes()`; the voting-style
        // `candidate.as_ref()` form is identical (String: AsRef<[u8]> yields
        // the UTF-8 bytes), so both chains resolve the same way.
        if (argType === "String" && (chain === "as_bytes()" || chain === "as_ref()")) {
          const defaultStr = "test";
          const hex = [...defaultStr].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
          out.push(`bytes:0x${hex}`);
          continue;
        }
      }
      return {
        ok: false,
        seeds: [],
        reason: `seed \`${trimmed}\` is arg-derived (reads instruction arg \`${argName}\`, type ${argType ?? "<unknown>"}) and the chain shape \`${chain}\` isn't auto-resolvable yet. Replace with explicit \`bytes:0x…\` via "Edit as JSON".`,
      };
    }
    // Unrecognised shape.
    return {
      ok: false,
      seeds: [],
      reason: `unsupported seed expression \`${trimmed}\` -- supported: b"literal", <signer>.key().as_ref(), <other_pda>.key().as_ref(), bytes:0x<hex>, u<N>:<num>. Use "Edit as JSON" for other shapes.`,
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
