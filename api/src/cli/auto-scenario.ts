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
  "Sysvar<Rent>": "rent",
  "Sysvar<Clock>": "clock",
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
  const pdaSpecs = new Map<string, { seeds: string[]; sourceIx: string }>();
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
        );
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
  pdaNames: Set<string>,
  mintNames: Set<string>,
  stateFieldMap: Map<string, Map<string, string>>,
  argTypes: Map<string, string>,
  accountName: string,
  stateNumericFieldMap: Map<string, Map<string, { argName: string; argType: string; defaultValue: number }>>,
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
    // <signer>.key().as_ref() / <signer>.key.as_ref() / <pda>.key().as_ref() / <mint>.key().as_ref()
    const signerKeyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.key(?:\(\))?\.as_ref\(\)$/);
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
    const argRefMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(as_ref\(\)|to_le_bytes\(\)|to_le_bytes\(\)\.as_ref\(\))$/);
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
