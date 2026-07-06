/**
 * Anchor Parser — tree-sitter AST-based
 *
 * Parses raw Anchor .rs source files into SolanaIR using tree-sitter-rust
 * for reliable AST extraction. Replaces the previous regex-based parser.
 *
 * Key advantages over regex:
 *   - Correct handling of nested generics (Account<'info, TokenAccount>)
 *   - Reliable field expression chain resolution (ctx.accounts.X)
 *   - Proper CPI detection (inline CpiContext, multi-line expressions)
 *   - No false positives from text patterns inside strings/comments
 *
 * The parser extracts:
 *   - Program name and ID
 *   - Instructions (name, signature, accounts, args, classified body)
 *   - Account data structs (#[account] structs)
 *   - Error enums (#[error_code])
 *   - Helper functions (non-instruction fns)
 *   - Custom types/structs
 *   - Import statements
 */

import {
  SolanaIRSchema,
} from "../ir/schema.js";
import type {
  SolanaIR,
} from "../ir/schema.js";
import { getParser, withParseDeadline, parseGuarded, ParseTimeoutError } from "./ts-init.js";
import type { SyntaxNode } from "./ts-init.js";
import {
  hasAttribute,
  hasCfgTestAttribute,
  hasDeriveAttribute,
  findDescendant,
} from "./ast-helpers.js";
import { parseInstructions, extractImplTargetName, parseFromImplDeclaration, type FromImplCatalogEntry } from "./instruction-parser.js";
import { parseAccountDataStruct, extractByteArrayConsts } from "./account-parser.js";
import { parseErrorEnum, parseHelperFn, parseCustomType, extractImports, extractProgramId, countProgramIdMacros, detectProtocolVersionMismatches } from "./type-parser.js";
import { createWarningCollector } from "./warning-collector.js";
import { buildHelperCpiCatalog } from "./helper-cpi-catalog.js";
import { rewriteErrMacroToExplicit, expandPubkeyMacro, vendorExternalProgramIDs, rewriteAnchorRequireMacros } from "./project-source.js";
import { parseExternalIdlMap, rewriteDeclareProgramCpis } from "./external-cpi.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ParseResult {
  ok: true;
  ir: SolanaIR;
}

export interface ParseError {
  ok: false;
  error: string;
  details?: string;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Parse an Anchor Rust source file into SolanaIR using tree-sitter.
 *
 * This is the main parser entry point. It takes raw Anchor-style Rust source,
 * builds a tree-sitter AST, classifies top-level items (program module,
 * account structs, error enums, etc.), and produces a validated `SolanaIR`.
 *
 * Async because tree-sitter WASM initialization is async on first call.
 *
 * @param source - Raw Rust source code containing Anchor constructs
 * @returns `ParseResult` with the IR on success, or `ParseError` with
 *          a human-readable error message and optional details on failure
 *
 * @example
 * ```ts
 * const result = await parseAnchor(anchorSource);
 * if (result.ok) {
 *   console.log(result.ir.instructions.length, "instructions parsed");
 * } else {
 *   console.error(result.error, result.details);
 * }
 * ```
 */
/**
 * Sliding-scale parse deadline. Tree-sitter's parse cost is roughly
 * linear in source size, so a single-cliff 10s/60s split (the previous
 * SW3 fix) was too coarse — Mango v4 (37k LoC) parses comfortably under
 * the 60s ceiling but the prior 10s default would have timed it out;
 * Drift (67k LoC) genuinely needs more time than the median program.
 *
 * Formula: `floor(LoC * MS_PER_LINE)` clamped to `[BASE, MAX]`.
 *  - 1k LoC →  10s (BASE)
 *  - 5k LoC →  10s (BASE — small program, cheap parse)
 *  - 25k LoC → 50s
 *  - 50k LoC → 100s
 *  - 67k LoC → 120s (MAX — Drift's main program)
 *
 * This means: small programs keep the responsive 10s deadline; mega-
 * programs get a deadline proportional to actual work. The MAX cap
 * (120s) bounds worst-case server-side request latency.
 *
 * Operator can still override via `opts.timeoutMs`.
 */
const PARSE_TIMEOUT_BASE_MS = 10_000;
const PARSE_TIMEOUT_MAX_MS = 120_000;
const PARSE_TIMEOUT_MS_PER_LINE = 2;

function computeParseTimeout(lineCount: number): number {
  const scaled = lineCount * PARSE_TIMEOUT_MS_PER_LINE;
  return Math.min(PARSE_TIMEOUT_MAX_MS, Math.max(PARSE_TIMEOUT_BASE_MS, scaled));
}

/**
 * G18 — strip `#[access_control(...)]` attributes paren-balanced.
 *
 * Drift uses multi-line access_control attributes with multiple function
 * calls and no comma separation — a shape tree-sitter's rust grammar
 * cannot parse, propagating into ERROR top-level nodes that mask the
 * entire surrounding #[program] block.
 *
 * Walk the source, find each `#[access_control(`, paren-balance
 * (string-aware), strip the whole attribute including `]`. Idempotent
 * on already-stripped sources.
 */
interface DroppedAccessControl {
  /** The guard expression(s) inside `#[access_control(...)]`, verbatim. */
  guard: string;
  /** The handler fn the guard sits above, when resolvable from source order. */
  fnName: string | null;
}

function stripAccessControlAttrs(source: string): {
  source: string;
  dropped: DroppedAccessControl[];
} {
  let out = "";
  let i = 0;
  const dropped: DroppedAccessControl[] = [];
  while (i < source.length) {
    const idx = source.indexOf("#[", i);
    if (idx === -1) { out += source.slice(i); break; }
    out += source.slice(i, idx);
    // Match a leading whitespace pattern `#[\s*access_control\s*\(`.
    const probe = source.slice(idx, idx + 50);
    const m = probe.match(/^#\[\s*access_control\s*\(/);
    if (!m) {
      out += "#[";
      i = idx + 2;
      continue;
    }
    const parenStart = idx + m[0].length - 1; // position of `(`
    let depth = 1;
    let inStr = false;
    let j = parenStart + 1;
    for (; j < source.length; j++) {
      const ch = source[j];
      if (inStr) {
        if (ch === "\\" && j + 1 < source.length) { j++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) {
      // Unbalanced — keep verbatim, bail.
      out += "#[";
      i = idx + 2;
      continue;
    }
    // Expect closing `]` after `)` (with optional whitespace).
    let k = j + 1;
    while (k < source.length && /\s/.test(source[k] ?? "")) k++;
    if (source[k] !== "]") {
      out += "#[";
      i = idx + 2;
      continue;
    }
    // Capture the guard body + the handler it guards (scan forward for the
    // next `fn <name>`, skipping any intervening attributes) so the dropped
    // authorization check can be surfaced loudly and bound to its instruction.
    const guard = source.slice(parenStart + 1, j).trim();
    const fnMatch = source.slice(k + 1, k + 1 + 400).match(/\bfn\s+([A-Za-z_]\w*)/);
    dropped.push({ guard, fnName: fnMatch ? fnMatch[1]! : null });
    // Strip the whole attribute (don't append anything for it).
    i = k + 1;
  }
  return { source: out, dropped };
}

export interface ParseOptions {
  timeoutMs?: number;
  /**
   * B9 — items dropped during project-source flattening due to inactive
   * `#[cfg(feature = "...")]` predicates. Surfaced as
   * `cfg_gated_item_dropped` ParserWarnings on the resulting IR so users
   * see what disappeared from their emit. Empty / undefined means no
   * such items were dropped.
   */
  cfgDrops?: import("./project-source.js").CfgGatedDrop[];
  /**
   * Truthy when source has already been flattened via
   * buildProjectSourceGraph. The flag suppresses the "single-file shim
   * detected" warning that fires when raw `mod X;` decls leak through to
   * the parser — those decls survive intentionally on the flatten path
   * (they're replaced inline) but represent a real gap on the
   * single-file path. Set this from any caller that already walked the
   * module graph.
   */
  wasFlattened?: boolean;
  /**
   * #2 / S4 — raw Anchor IDL JSON for crates imported via declare_program!(X),
   * keyed by crate name (e.g. { lever: <idl.json> }). When present, a pre-parse
   * rewrite turns `<crate>::cpi::<fn>(CpiContext::new(prog, Accounts{...}), args)`
   * into the hand-built Instruction + invoke shape the generic-CPI path already
   * handles. Absent ⇒ no-op (declare_program! CPIs keep their loud-refuse).
   */
  externalIdls?: Record<string, unknown>;
}

export async function parseAnchor(
  source: string,
  opts?: ParseOptions,
): Promise<ParseResult | ParseError> {
  // Apply Anchor-macro source rewrites BEFORE tree-sitter parses. The
  // multi-file `buildProjectSource` flow already does this; pre-fix, the
  // single-file `/parse` route bypassed it, leaving `err!()` / `error!()`
  // calls in pass_through statements that don't compile on Pinocchio
  // ("cannot find macro `err`"). Idempotent — running twice on already-
  // rewritten source is a no-op (the rewriter scans for the source-shape
  // macros only).
  source = rewriteErrMacroToExplicit(source);
  source = rewriteAnchorRequireMacros(source);
  // #2 / S4 — declare_program! cross-program CPI: pre-parse rewrite into the
  // generic-CPI Instruction+invoke shape (no-op unless externalIdls supplied).
  if (opts?.externalIdls) {
    source = await rewriteDeclareProgramCpis(source, parseExternalIdlMap(opts.externalIdls));
  }
  // G11 — Arcium framework support. Source uses `#[arcium_program]` +
  // sibling attribute macros (`#[arcium_callback]`,
  // `#[queue_computation_accounts]`, `#[callback_accounts]`,
  // `#[init_computation_definition_accounts]`) which Anvil's parser
  // doesn't recognize. The bare swap to `#[program]` makes parsing
  // succeed (downstream issues like `use arcium_anchor::*` filtering
  // get handled by the standard import scrubber + unsalvageable-
  // helper commentout). Bodies that call arcium runtime fns are
  // expected to be unsalvageable — manual port required.
  source = source.replace(/#\[\s*arcium_program\s*\]/g, "#[program]");
  source = source.replace(/#\[\s*arcium_callback\s*\([^)]*\)\s*\]/g, "");
  source = source.replace(/#\[\s*queue_computation_accounts\s*\([^)]*\)\s*\]/g, "");
  source = source.replace(/#\[\s*callback_accounts\s*\([^)]*\)\s*\]/g, "");
  source = source.replace(/#\[\s*init_computation_definition_accounts\s*\([^)]*\)\s*\]/g, "");
  // G22c — convert `pub use X::Y as Z;` to `pub type Z = X::Y;` so the
  // alias survives parse + emit. Without this, the alias is lost
  // because Anvil's parser drops `pub use` statements. Kamino's
  // `pub use fixed::types::U68F60 as Fraction;` (referenced 401 times)
  // and similar patterns benefit. Conservative regex: only matches
  // single-segment alias names with explicit path-prefix-style imports.
  // Doesn't match block-form `pub use X::{Y as Z, W as V};` (rare).
  source = source.replace(
    /\bpub\s+use\s+((?:[A-Za-z_]\w*::)+[A-Za-z_]\w*(?:<[^;{}]*>)?)\s+as\s+([A-Za-z_]\w*)\s*;/g,
    "pub type $2 = $1;",
  );
  // G18 — strip `#[access_control(...)]` attributes paren-balanced.
  // Drift's source has:
  //   #[access_control(
  //       perp_market_valid(&ctx.accounts.perp_market)
  //       valid_oracle_for_perp_market(&ctx.accounts.oracle, ...)
  //   )]
  // — multi-line, two function calls without comma separation. Tree-sitter
  // can't parse this attribute shape; the whole top-level item gets
  // classified as ERROR. Anvil's instruction parser already extracts
  // access_control info from `attrs` via a separate pass; the runtime
  // check itself isn't transpiled today. Strip the attribute pre-parse
  // so tree-sitter can see the surrounding fn / mod_item. The guards are NOT
  // discarded — they're captured here and surfaced as loud warnings + a
  // validator-error emit marker below (B1) so a dropped authorization check
  // can never ship silently.
  const acStrip = stripAccessControlAttrs(source);
  source = acStrip.source;
  const droppedAccessControl = acStrip.dropped;
  // task #41 — same fix for `pubkey!("...")` macro. Anchor's prelude
  // provides it; Pinocchio doesn't. Single-file parseAnchor was bypassing
  // buildProjectSource's expansion; surfaced by diff-arc on pda-derivation
  // ("cannot find macro `pubkey`"). Both targets accept the expanded
  // `Pubkey::new_from_array([...])` form.
  source = expandPubkeyMacro(source);
  // G77 attempted to collapse 4-lifetime `Context<'_, '_, 'info, 'info,
  // T<'info>>` to `Context<T<'info>>` so tree-sitter could parse it.
  // The naïve regex truncated the inner generic at the first `>` and
  // didn't change cohort counts — the grammar gap is deeper than just
  // the lifetime count. Reverted; deferred behind the G32 rescue path
  // that already handles the surrounding ERROR node.
  // Vendor well-known external program ID constants (mpl_core::ID etc.).
  // The `use mpl_core::{...}` source line is dropped by filteredSourceImports
  // at emit, so any `MPL_CORE_PROGRAM_ID` alias would otherwise leave the
  // body unresolved. Append `pub const MPL_CORE_PROGRAM_ID: Pubkey = ...;`
  // here so the parser captures it as a top-level const and the emitter
  // re-emits it.
  source = vendorExternalProgramIDs(source);

  // Auto-scale deadline by source size unless caller pinned one. Skip the
  // .split() on small sources (cheaper to assume small).
  const lineCount = source.length > 50_000 ? source.split("\n").length : 0;
  const timeoutMs = opts?.timeoutMs ?? computeParseTimeout(lineCount);
  try {
    return await withParseDeadline(timeoutMs, async () => {
      const parser = await getParser();
      let tree;
      try {
        tree = parseGuarded(parser, source);
      } catch (err) {
        if (err instanceof ParseTimeoutError) {
          return {
            ok: false as const,
            error: "Parse timed out",
            details: err.message,
          };
        }
        throw err;
      }
      const root = tree.rootNode;

    // ── Walk top-level items and classify by attributes ──
    const topLevel = classifyTopLevel(root);

    if (!topLevel.programModule) {
      return {
        ok: false,
        error: "No Anchor #[program] module found",
        details: "This parser currently supports Anchor entry files. Native multi-file Solana programs like many SPL crates are not transpiled yet.",
      };
    }

    // ── Extract program name ──
    const programName = extractModuleName(topLevel.programModule.node);

    // ── Extract program ID from declare_id!("...") ──
    const programId = extractProgramId(root);

    // ── Extract imports ──
    const imports = extractImports(root);

    // ── Per-parse warning collector (loud parser-degradation signal) ──
    // Created early (before account/event parsing) so #60's discriminator-
    // override warnings can be raised inline. Drained into `irRaw.warnings`
    // after instruction classification.
    const warningCollector = createWarningCollector();

    // first-declare_id-wins: extractProgramId returns the first macro in source
    // order regardless of #[cfg]. If the source has multiple (e.g. dual-branch
    // mainnet/devnet IDs), surface it so the wrong ID isn't emitted silently.
    if (programId && countProgramIdMacros(root) > 1) {
      warningCollector.add({
        code: "multiple_declare_id",
        message:
          `Multiple declare_id!/declare_program! macros found; Anvil used the first in ` +
          `source order ("${programId}") regardless of #[cfg]. If your source has per-target ` +
          `IDs (mainnet/devnet branches), verify this is the intended program ID for your build.`,
      });
    }

    // B3 pin-and-assert: warn when a protocol crate's declared version differs
    // (major.minor) from the version Anvil's hardcoded byte-level constants
    // target — emitted CPIs for that protocol may produce wrong bytes.
    for (const mm of detectProtocolVersionMismatches(source)) {
      warningCollector.add({
        code: "protocol_version_mismatch",
        message:
          `Source declares ${mm.crate} ${mm.found}, but Anvil's hardcoded ` +
          `discriminators / account layouts / byte offsets for ${mm.crate} are pinned to ` +
          `${mm.pinned}. Emitted CPIs may target the wrong instruction or read the wrong ` +
          `offsets — verify the emitted bytes against ${mm.crate} ${mm.pinned}.`,
      });
    }

    // #60 — Top-level `const X: ... = [N, N, ...];` byte-array table.
    // Shared between account/event/instruction discriminator-override
    // resolution so `discriminator = MY_DISC` can resolve through.
    const byteArrayConsts = extractByteArrayConsts(source);

    // ── Parse account data structs (#[account] structs) ──
    const accounts = topLevel.accountDataStructs.map((s) => {
      const def = parseAccountDataStruct(s.node, s.attrs, {
        collector: warningCollector,
        discriminatorKind: "account",
        byteArrayConsts,
      });
      // Attach raw `impl <ThisAccount> { fn / const }` items so emitters can
      // preserve inherent helpers like `Foo::SEED_PREFIX` and
      // `Foo::required_space()` that the Anchor source uses inside seeds /
      // space exprs but isn't generated by the standard struct emit.
      const matchingItems = topLevel.implItems
        .filter((it) => it.implName === def.name)
        .map((it) => it.rawText);
      if (matchingItems.length > 0) def.implItems = matchingItems;
      return def;
    });

    // B9 — surface cfg(feature=...) drops collected during project-source
    // flattening. The parser does the source-shaping internally for single-
    // file inputs (via rewriteErrMacroToExplicit + tree-sitter), but the
    // cfg-strip happens upstream in project-source.ts. Callers that ran
    // buildProjectSourceGraph pass the captured drops via opts.cfgDrops so
    // they land here as user-visible warnings.
    if (opts?.cfgDrops && opts.cfgDrops.length > 0) {
      for (const drop of opts.cfgDrops) {
        warningCollector.add({
          code: "cfg_gated_item_dropped",
          message:
            `Stripped #[cfg(${drop.predicate})] item: ${drop.itemSnippet} — the default cfg context ` +
            `evaluates the predicate to false (no features enabled). If your deploy DOES enable this ` +
            `feature, re-run Anvil with the relevant cfg flags in scope OR upgrade your code to be ` +
            `unconditional.`,
          loc: { line: drop.line, column: 0 },
        });
      }
    }

    // Multi-file shim detection. The single-file parseAnchor sees lib.rs
    // verbatim — if that file is a shim like `mod instructions; #[program]
    // pub mod p { use super::*; pub fn foo(ctx: Context<Foo>) -> Result<()>
    // { instructions::foo::handler(ctx) } }`, the parser captures `foo`
    // but its body references `instructions::foo::handler` which lives in
    // a sibling file the single-file path never reads. Result: emit
    // contains an unresolvable function call. Callers using the multi-file
    // route (buildProjectSourceGraph → parseAnchor with wasFlattened=true)
    // skip this warning because mod-decls there are intentional markers
    // for the flatten step. Strips cfg(test) decls first so the warning
    // doesn't fire on test-only modules.
    if (!opts?.wasFlattened) {
      const externalModuleNames: string[] = [];
      const cfgTestStripped = source.replace(/^\s*#\[cfg\([^\]]*test[^\]]*\)\]\s*(pub\s+)?mod\s+\w+\s*;/gm, "");
      for (const match of cfgTestStripped.matchAll(/^\s*(pub\s+)?mod\s+(\w+)\s*;/gm)) {
        if (!match[2]) continue;
        externalModuleNames.push(match[2]);
      }
      if (externalModuleNames.length > 0) {
        warningCollector.add({
          code: "multi_file_shim_detected",
          message:
            `Found ${externalModuleNames.length} external module declaration(s) ` +
            `(${externalModuleNames.slice(0, 5).join(", ")}` +
            `${externalModuleNames.length > 5 ? ", …" : ""}) but parser only sees lib.rs. ` +
            `Bodies that delegate to sibling files (e.g. ${externalModuleNames[0]}::X::handler(...)) ` +
            `will emit as unresolved references. Re-run with the multi-file route: pass ` +
            `{ projectPath } or { files, entryPath } to /parse so buildProjectSourceGraph can ` +
            `walk the module tree.`,
          loc: { line: 1, column: 0 },
        });
      }
    }

    // ── Parse instructions (partial-IR-on-timeout, #27) ──
    // parseInstructions walks each handler fn and may call parseGuarded
    // recursively for synthetic-source rebuilds (impl-method inlining,
    // From-trait expansion). Any of those nested parses can hit the
    // request-scoped deadline. Pre-fix, the ParseTimeoutError bubbled up
    // and the whole request lost ALL extracted data -- accounts, types,
    // errors, helpers, events: gone. Now we catch the timeout and return
    // a partial IR with whatever extracted before the cutoff PLUS a
    // loud parser warning naming the partial-parse reason. Downstream
    // consumers see ir.warnings with a `partial_parse_timeout` code and
    // can render "we got 23 of N instructions, see warnings" instead
    // of "Parse timed out, here's nothing."
    // Helper-CPI catalog (Path 2). Parsed BEFORE instructions so the
    // body classifier can substitute call sites into typed cpi_spl_*
    // statements. parseHelperFn is text-only, no AST traversal cost
    // beyond the one we'd do later anyway. Only fns whose body shape
    // matches a recognized SPL CPI wrapper land in the catalog; the rest
    // stay as carried-over helperFns for emit.
    const earlyHelperFns = topLevel.helperFns.map((h) => parseHelperFn(h.node));
    const helperCpiCatalog = buildHelperCpiCatalog(earlyHelperFns);

    let instructions: SolanaIR["instructions"];
    let partialParseTimeout = false;
    try {
      instructions = parseInstructions(
        parser,
        topLevel.programModule.node,
        topLevel.accountsStructs,
        topLevel.implMethods,
        topLevel.functionIndex,
        topLevel.fromImpls,
        source,
        warningCollector,
        helperCpiCatalog,
        byteArrayConsts,
      );
    } catch (err) {
      if (err instanceof ParseTimeoutError) {
        instructions = [];
        partialParseTimeout = true;
        warningCollector.add({
          code: "anchor_pattern_in_passthrough",
          // Re-using an existing kind keeps the schema stable; the message
          // is what users see anyway. The validator's parser-warning
          // surfacing path renders these as `[parser:CODE]` issues.
          message:
            `Parse deadline exceeded mid-instruction-classification (${timeoutMs}ms for ${lineCount || "<50k"} LoC). ` +
            `Returning partial IR: ${topLevel.accountsStructs.length} Accounts struct(s), ` +
            `${topLevel.accountDataStructs.length} #[account] struct(s), ` +
            `${topLevel.errorEnums.length} error enum(s), ` +
            `${topLevel.eventStructs.length} #[event] struct(s), and ` +
            `${topLevel.implMethods.length} impl method(s) -- but ZERO instructions classified. ` +
            `Either pass a longer opts.timeoutMs, or split the program source into smaller crates.`,
        });
      } else {
        throw err;
      }
    }

    // ── B1: dropped #[access_control(...)] guards ──
    // Bind each guard stripped pre-parse to its instruction (populates the
    // otherwise-dead Instruction.accessControl, which the emitter renders as
    // a validator-error marker) and raise a loud warning. Left silent, the
    // emitted handler runs UNGUARDED yet passes happy-path byte-equal.
    for (const ac of droppedAccessControl) {
      const inst = ac.fnName
        ? instructions.find((x) => x.name === ac.fnName)
        : undefined;
      if (inst) inst.accessControl = ac.guard;
      warningCollector.add({
        code: "access_control_dropped",
        message:
          `#[access_control(${ac.guard.replace(/\s+/g, " ").trim()})] guard ` +
          `${inst ? `on instruction \`${inst.name}\` ` : ""}is NOT transpiled — ` +
          `this on-chain authorization check is dropped, so the emitted handler runs ` +
          `UNGUARDED. Re-add the check manually before deploy.`,
        instruction: inst?.name,
        snippet: ac.guard.slice(0, 200),
      });
    }

    // ── Parse errors ──
    // G27c — when source has MULTIPLE `#[error_code] pub enum X { ... }`
    // declarations, parseErrorEnum independently restarts the code at 6000
    // for each, producing duplicate codes that cargo rejects with E0081.
    // Drift has 362 errors across 2+ enums; the first ~12 codes collide.
    // Dedupe by name (keep first occurrence) and re-number sequentially
    // from 6000 so the emitted error enum is collision-free.
    const rawErrors = topLevel.errorEnums.flatMap((e) => parseErrorEnum(e.node, e.attrs));
    const seenNames = new Set<string>();
    const dedupedErrors: typeof rawErrors = [];
    for (const e of rawErrors) {
      if (seenNames.has(e.name)) continue;
      seenNames.add(e.name);
      dedupedErrors.push(e);
    }
    // H1/H2 (#35) — PRESERVE each error's parser-computed code (base +
    // discriminant, honoring an explicit `= N` and `#[error_code(offset = N)]`)
    // instead of blindly re-numbering 6000 + index, which dropped both. Only
    // bump a code that COLLIDES with an already-assigned one — the multi-enum
    // E0081 case the old re-number was guarding against (G27c).
    const usedCodes = new Set<number>();
    const errors = dedupedErrors.map((e) => {
      let code = e.code;
      while (usedCodes.has(code)) code++;
      usedCodes.add(code);
      return { ...e, code };
    });

    // ── Parse #[event] structs ──
    // Reuse parseAccountDataStruct's field walker since #[event] structs are
    // structurally identical to #[account] structs minus the discriminator
    // (which we synthesize at emit time from sha256("event:Name")). The
    // resulting AccountDef's `space` and `implItems` are unused for events.
    const events = topLevel.eventStructs.map((s) => {
      const def = parseAccountDataStruct(s.node, s.attrs, {
        collector: warningCollector,
        discriminatorKind: "event",
        byteArrayConsts,
      });
      return {
        name: def.name,
        fields: def.fields,
        ...(def.customDiscriminator ? { customDiscriminator: def.customDiscriminator } : {}),
      };
    });

    // ── Parse helper functions ──
    // Reuse the catalog-pass result so we don't text-parse the same fn twice.
    const helperFns = earlyHelperFns;

    // ── Parse custom types ──
    const types = topLevel.customTypes.map((t) => {
      const def = parseCustomType(t.node, t.kind, t.attrs);
      // Same impl-items attachment as accounts above. Plain Rust types like
      // carnival's `Ride`/`Game` carry `impl X { fn new(...) }` constructors
      // that the helpers/instructions reference.
      const matching = topLevel.implItems
        .filter((it) => it.implName === def.name)
        .map((it) => it.rawText);
      if (matching.length > 0) def.implItems = matching;
      return def;
    });
    const constants = topLevel.constants.map((node) => node.text);

    // Capture user-defined trait impls (From, Into, AsRef, Display, Debug, …)
    // whose body is "Anchor-clean" — no Anchor wrapper types or CPI helper
    // refs that the target strips. coral-multisig's
    // `impl From<TransactionAccount> for AccountMeta { … }` is the canonical
    // case: bodies of inlined From-trait `.into()` chains rely on it
    // resolving on the target side (`Vec<TransactionAccount>::into_iter()
    // .map(Into::into).collect()` invokes this impl).
    const userTraitImpls = topLevel.userTraitImpls;

    const irRaw: SolanaIR = {
      name: programName,
      programId,
      instructions,
      accounts,
      types,
      constants,
      errors,
      helperFns,
      events,
      imports,
      typeAliases: topLevel.typeAliases,
      userTraits: topLevel.userTraits,
      userTraitImpls,
      userModules: topLevel.userModules,
      userModuleRoots: collectUserModuleRoots(source),
      warnings: warningCollector.drain(),
      metadata: {
        sourceFramework: "anchor",
        sourceVersion: detectAnchorVersion(source),
        anvilVersion: "0.2.0",
        parsedAt: new Date().toISOString(),
      },
    };

    // Validate with Zod
    const result = SolanaIRSchema.safeParse(irRaw);
    if (!result.success) {
      return {
        ok: false,
        error: "IR validation failed",
        details: result.error.message,
      };
    }

    // #35 — clear the external-owner-refusal flag for crates whose IDL was
    // supplied: the declare_program CPI machinery already handles those
    // accounts (passed to the external program via the rewritten invoke, which
    // the callee owner-checks), so the local 3007 refusal would over-reject the
    // SUPPORTED path. The refusal is reserved for genuinely-unknown external
    // crates — no IDL means Anvil has zero knowledge of the program's id and
    // can neither emit the real owner check nor let the CPI defend the account.
    const knownExternalCrates = new Set(Object.keys(opts?.externalIdls ?? {}));
    if (knownExternalCrates.size > 0) {
      for (const instr of result.data.instructions) {
        for (const acc of instr.accounts) {
          if (acc.externalOwnerCrate && knownExternalCrates.has(acc.externalOwnerCrate)) {
            delete acc.externalOwnerCrate;
          }
        }
      }
    }

      return { ok: true as const, ir: result.data };
    });
  } catch (e) {
    if (e instanceof ParseTimeoutError) {
      return {
        ok: false,
        error: "Parse timed out",
        details: e.message,
      };
    }
    return {
      ok: false,
      error: "Parse failed",
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Top-level classification ────────────────────────────────────────────────

interface TopLevelItems {
  programModule: { node: SyntaxNode; attrs: SyntaxNode[] } | null;
  accountsStructs: { name: string; node: SyntaxNode; attrs: SyntaxNode[]; instructionArgs: string[] }[];
  accountDataStructs: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  errorEnums: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  eventStructs: { node: SyntaxNode; attrs: SyntaxNode[] }[];
  helperFns: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[];
  implMethods: { implName: string; name: string; node: SyntaxNode; modulePath: string[] }[];
  /**
   * Raw text of every `function_item` / `const_item` found inside `impl <T>`
   * blocks. Used to attach inherent helpers (e.g. `Foo::SEED_PREFIX`,
   * `Foo::required_space()`) to the matching AccountDef so emitters preserve
   * them in their own inherent impl block.
   */
  implItems: { implName: string; kind: "fn" | "const"; name: string; rawText: string }[];
  /** From-trait impls, keyed for resolving typed `.into()` call sites at parse time. */
  fromImpls: FromImplCatalogEntry[];
  /**
   * Raw text of user-defined trait impls (impl Trait for Type) whose body
   * contains no Anchor patterns — preserved verbatim into emit so secondary
   * `Into::into` chains in pass-through bodies resolve.
   */
  userTraitImpls: string[];
  customTypes: { node: SyntaxNode; attrs: SyntaxNode[]; kind: "struct" | "enum" }[];
  functionIndex: { node: SyntaxNode; attrs: SyntaxNode[]; modulePath: string[] }[];
  constants: SyntaxNode[];
  /** G22c — `pub type X = Y;` type aliases. Raw source text preserved
   * verbatim. Emitted at lib.rs scope so all downstream code resolves
   * them. Kamino's `pub type Fraction = U68F60;` and openbook's
   * `pub type NodeHandle = u32;` patterns. */
  typeAliases: string[];
  /** G27g — `pub trait X { ... }` user-defined trait declarations.
   * Openbook's KeyedAccountReader / AccountReader patterns. */
  userTraits: string[];
  /** Finding #67 — top-level free `mod X { ... }` blocks (non-program,
   * non-cfg(test)) preserved verbatim. The walker previously recursed INTO
   * these mods, hoisting their items + stripping the mod wrapper, which
   * silently broke namespace resolution for shapes like
   * `InterfaceAccount<'info, interface::ExpectedAccount>`. We now capture
   * the entire `mod X { ... }` text and skip recursion into its body. */
  userModules: string[];
}

function classifyTopLevel(root: SyntaxNode): TopLevelItems {
  // G32 — detect tree-sitter parse failure. Marginfi shows up as
  // root.type === "ERROR"; mango-v4 has root.type === "source_file" but
  // root.hasError === true (somewhere a deeper ERROR node wraps the
  // #[program] mod). Either signal triggers the rescue pass below.
  const rootIsError = root.type === "ERROR" || root.hasError;
  const items: TopLevelItems = {
    programModule: null,
    accountsStructs: [],
    accountDataStructs: [],
    errorEnums: [],
    eventStructs: [],
    helperFns: [],
    implMethods: [],
    implItems: [],
    fromImpls: [],
    userTraitImpls: [],
    customTypes: [],
    functionIndex: [],
    constants: [],
    typeAliases: [],
    userTraits: [],
    userModules: [],
  };

  // Pre-scan: collect the names of every fn declared inside the `#[program]`
  // module. Used by the `function_item` case below to distinguish a free
  // helper that happens to take `ctx: Context<X>` (legitimate, must reach
  // helperFns) from a flattened handler whose name + ctx-shape pair matches
  // the registry (already absorbed into program.instructions). Finding #62.
  const programInstructionNames = new Set<string>();
  function collectProgramFnNames(node: SyntaxNode, insideProgramMod: boolean): void {
    let pendingAttrs: SyntaxNode[] = [];
    for (let k = 0; k < node.namedChildCount; k++) {
      const c = node.namedChild(k);
      if (!c) continue;
      if (c.type === "attribute_item") { pendingAttrs.push(c); continue; }
      if (c.type === "line_comment" || c.type === "block_comment") continue;
      const ats = [...pendingAttrs];
      pendingAttrs = [];
      if (c.type === "mod_item") {
        const isProg = hasAttribute(ats, "program");
        const body = c.childForFieldName("body");
        if (body) collectProgramFnNames(body, insideProgramMod || isProg);
      } else if (c.type === "function_item" && insideProgramMod) {
        const nm = c.childForFieldName("name")?.text;
        if (nm) programInstructionNames.add(nm);
      }
    }
  }
  collectProgramFnNames(root, false);

  function walk(node: SyntaxNode, modulePath: string[] = [], inProgramModule = false): void {
    let currentAttrs: SyntaxNode[] = [];

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === "attribute_item") {
        currentAttrs.push(child);
        continue;
      }
      // Comments between attributes and the item they decorate must not
      // flush currentAttrs. Real Anchor sources commonly have:
      //   #[account]
      //   #[derive(InitSpace)]  // comment
      //   pub struct Foo { ... }
      // Without this guard the line_comment sat in the loop body and the
      // generic `currentAttrs = []` reset below dropped both attrs on the
      // floor — Foo lost its #[account] and didn't show up in IR.accounts.
      if (child.type === "line_comment" || child.type === "block_comment") {
        continue;
      }

      const attrs = [...currentAttrs];
      currentAttrs = [];

      switch (child.type) {
        case "mod_item": {
          const modName = extractModuleName(child);
          const isProgramModule = hasAttribute(attrs, "program");
          // Skip cfg(test)-gated modules entirely. Their imports + functions
          // are test-only (typically litesvm/solana-kite test harnesses) and
          // walking into them leaks `use solana_kite::…`-style imports into
          // the emitted lib.rs.
          //
          // EXCEPTION: when both #[cfg(test)] AND #[program] are in scope,
          // the #[cfg(test)] is almost certainly orphaned -- the source had
          // `#[cfg(test)] mod tests;` followed by `#[program] pub mod foo`,
          // the project flattener stripped the `mod tests;` but left the
          // attribute, and the buffer carried it forward. The #[program]
          // attribute is the strong signal; trust it. Surfaced by the
          // corpus sweep on Whirlpool which had this exact shape.
          if (hasCfgTestAttribute(attrs) && !isProgramModule) break;
          if (isProgramModule) {
            items.programModule = { node: child, attrs };
          }
          const body = child.childForFieldName("body");
          // Finding #67 — when a top-level mod is NOT #[program] and NOT
          // already inside a program module, capture it verbatim instead
          // of recursing. Pre-fix the walker recursed INTO every mod body,
          // hoisting items to top-level and stripping the mod wrapper —
          // which silently broke namespace resolution for shapes like
          // `InterfaceAccount<'info, interface::ExpectedAccount>` (the
          // mod's `pub struct ExpectedAccount` got hoisted to lib.rs scope
          // without its `interface::` prefix, the trait impls + nested
          // cfg-gated `mod idl_impls` were dropped entirely). The emit
          // path splats userModules verbatim at lib.rs scope so the
          // namespace + everything inside it round-trips.
          if (!isProgramModule && !inProgramModule) {
            // Include attribute prefix so #[derive(...)] / #[cfg(...)] on
            // the mod itself round-trips. tree-sitter's mod_item.text omits
            // the leading attributes; reconstruct by prepending attrs.
            const prefix = attrs.map((a) => a.text).join("\n");
            const verbatim = prefix ? `${prefix}\n${child.text}` : child.text;
            items.userModules.push(verbatim);
            // Still index functions inside the module for handler-wrapper
            // resolution (inner::handler delegation pattern). The module
            // content round-trips via userModules; this walk only populates
            // functionIndex so resolveHandlerWrapper can find the target.
            if (body && modName) {
              walk(body, [...modulePath, modName], false);
            }
            break;
          }
          if (body && modName) {
            walk(body, [...modulePath, modName], inProgramModule || isProgramModule);
          }
          break;
        }

        case "struct_item": {
          if (hasDeriveAttribute(attrs, "Accounts")) {
            const name = extractStructName(child);
            if (name) {
              const instructionArgs = extractInstructionArgs(attrs);
              items.accountsStructs.push({ name, node: child, attrs, instructionArgs });
            }
          } else if (hasAttribute(attrs, "account")) {
            items.accountDataStructs.push({ node: child, attrs });
          } else if (hasAttribute(attrs, "event")) {
            // #[event] structs are payload schemas for emit!() / emit_cpi!().
            // Captured here so the emitter can reproduce sol_log_data with
            // a byte-identical borsh payload + Anchor-style 8-byte
            // sha256("event:<EventName>")[..8] discriminator.
            items.eventStructs.push({ node: child, attrs });
          } else {
            items.customTypes.push({ node: child, attrs, kind: "struct" });
          }
          break;
        }

        case "enum_item": {
          // Anchor pre-0.25 used `#[error]`; 0.25+ renamed it to `#[error_code]`.
          // Treat both as error enums so the older form routes through
          // parseErrorEnum + emitErrorEnum (clean target-side codegen) instead
          // of falling into customTypes and carrying `#[error]` + `#[msg(...)]`
          // attrs through to the emitted file verbatim (E0658 / unknown attrs
          // on Pinocchio + Native — neither target ships anchor_lang).
          // Surfaced by coral-anchor/tests/tictactoe (finding #69).
          if (hasAttribute(attrs, "error_code") || hasAttribute(attrs, "error")) {
            items.errorEnums.push({ node: child, attrs });
          } else {
            items.customTypes.push({ node: child, attrs, kind: "enum" });
          }
          break;
        }

        case "function_item": {
          const functionName = child.childForFieldName("name")?.text ?? "";
          items.functionIndex.push({ node: child, attrs, modulePath });
          // Exclude instruction handlers from helper carry-over. `fn handler` in
          // a submodule is the Anchor convention; project-source.ts rewrites
          // those to `fn <module>_handler` to avoid name collisions when
          // flattening, after which they sit at modulePath=[]. We catch both:
          // (a) literal `handler` in a submodule, (b) a TOP-LEVEL function
          // (modulePath=[]) whose name matches an Anchor instruction handler
          // registered in the `#[program]` module AND whose first parameter
          // is `ctx: Context<X>` — that's the flattened-handler shape and
          // its body is already absorbed into the program's instruction list.
          //
          // The name-matching gate on (b) is load-bearing. Pre-fix the regex
          // fired on ANY `fn _?ctx: Context<X>` regardless of name, silently
          // dropping legitimate free helpers like
          // `instructions/take_offer.rs::withdraw_and_close_vault(ctx: Context<TakeOffer>)`
          // — those never reach helperFns → never end up in
          // unsalvageableHelpers → their call sites in the absorbed handler
          // body stay uncommented + reference a stale `context` binding that
          // was itself commented out. Surfaced by finding #62 on
          // program-examples-escrow. After flattening every fn sits at
          // modulePath=[], so the path-length heuristic isn't usable —
          // restrict to handlers whose NAME appears in the program-module
          // registry collected in pass 1.
          const lastModule = modulePath[modulePath.length - 1];
          const isInstructionHandler =
            modulePath.length > 0 &&
            (functionName === "handler" || functionName === `${lastModule}_handler`);
          const params = child.childForFieldName("parameters")?.text ?? "";
          // Match `ctx: Context<…>` AND `_ctx: Context<…>` (Anchor's "unused
          // arg" convention). `\bctx` alone fails on `_ctx` because `\b` is
          // not a boundary between two word chars (`_` and `c`).
          const ctxShape = /(?:^|[\s(,])_?ctx\s*:\s*(?:&\s*mut\s+)?Context\s*</.test(params);
          const looksLikeAnchorHandler =
            ctxShape && programInstructionNames.has(functionName);
          if (!inProgramModule && !isInstructionHandler && !looksLikeAnchorHandler) {
            items.helperFns.push({ node: child, attrs, modulePath });
          }
          break;
        }

        case "impl_item": {
          const fromEntry = parseFromImplDeclaration(child);
          if (fromEntry) items.fromImpls.push(fromEntry);
          // Capture trait impls (impl Trait for Type) whose body is Anchor-
          // clean — those survive into emit verbatim. Filter inherent impls
          // (no `trait` field) since their items are already gathered into
          // `implMethods` / `implItems`.
          const traitField = child.childForFieldName("trait");
          if (traitField && isAnchorCleanTraitImpl(child.text)) {
            items.userTraitImpls.push(child.text);
          }
          // G42 — guard against tree-sitter brace-misparse. When the impl is
          // `impl Trait for X` (has a trait field) AND the trait is From or
          // similar single-method, the body should contain exactly one fn.
          // Marginfi-v2 hits a tree-sitter grammar gap that swallows the
          // closing `}` of the `impl From<Ref<...>> for LitePullFeedAccountData`,
          // so subsequent top-level `pub fn ...` helpers end up inside the
          // impl's declaration_list, polluting LitePullFeedAccountData's
          // implItems with 25+ helpers that should be free fns. Limit
          // single-method trait impls to their first matching function.
          const traitText = traitField?.text ?? "";
          const singleMethodTrait = traitField && (/^From\s*</.test(traitText) || /^Into\s*</.test(traitText) || /^Deref\s*$/.test(traitText) || /^DerefMut\s*$/.test(traitText));
          // G50 — skip adding trait-impl methods to type.implItems. Methods
          // like `fn next(&mut self) -> Option<Self::Item>` only make sense
          // inside `impl Iterator for X { type Item = ...; ... }`. If we
          // also add them as inherent items, the inherent emit drops the
          // trait wrapper → `impl X { fn next(&mut self) -> Option<Self::Item> { ... } }`
          // → E0223 ambiguous Self::Item (X has no associated type).
          // Openbook-v2 EventHeapIterator/BookSideIter pattern.
          if (traitField && !singleMethodTrait) break;
          const implName = extractImplTargetName(child);
          const implBody = child.childForFieldName("body") ?? findDescendant(child, "declaration_list");
          if (!implName || !implBody) break;
          const expectedMethodName = singleMethodTrait
            ? (/^From\b/.test(traitText) ? "from" : /^Into\b/.test(traitText) ? "into" : /^DerefMut\b/.test(traitText) ? "deref_mut" : /^Deref\b/.test(traitText) ? "deref" : null)
            : null;
          let collectedExpectedMethod = false;
          for (let j = 0; j < implBody.namedChildCount; j++) {
            const implChild = implBody.namedChild(j);
            if (!implChild) continue;
            if (implChild.type === "function_item") {
              const methodName = implChild.childForFieldName("name")?.text;
              if (!methodName) continue;
              if (expectedMethodName) {
                if (methodName !== expectedMethodName) {
                  // Misclassified — treat as a free fn carried by the file.
                  items.helperFns.push({ node: implChild, attrs: [], modulePath });
                  continue;
                }
                if (collectedExpectedMethod) {
                  // Duplicate method in single-method trait impl — also misclassified.
                  items.helperFns.push({ node: implChild, attrs: [], modulePath });
                  continue;
                }
                collectedExpectedMethod = true;
              }
              items.implMethods.push({ implName, name: methodName, node: implChild, modulePath });
              items.implItems.push({ implName, kind: "fn", name: methodName, rawText: implChild.text });
            } else if (implChild.type === "const_item") {
              const constName = implChild.childForFieldName("name")?.text;
              if (!constName) continue;
              items.implItems.push({ implName, kind: "const", name: constName, rawText: implChild.text });
            }
          }
          break;
        }
        case "use_declaration":
          break;

        case "const_item":
          items.constants.push(child);
          break;

        case "type_item": {
          // G22c — capture `pub type Y = X;` aliases. Only collect at
          // top level (not in submodules), and only those starting with
          // `pub` (private aliases stay scoped to their origin file —
          // they'd be hidden by `mod` boundaries anyway).
          const raw = child.text;
          if (/^pub\s+type\b/.test(raw)) {
            items.typeAliases.push(raw);
          }
          break;
        }

        case "trait_item": {
          // G27g — capture `pub trait X { ... }` user-defined traits.
          // Openbook's KeyedAccountReader pattern. Preserved verbatim.
          const raw = child.text;
          if (/^pub\s+(?:unsafe\s+)?trait\b/.test(raw)) {
            items.userTraits.push(raw);
          }
          break;
        }
        case "ERROR": {
          // G32 — recurse into tree-sitter ERROR nodes. Real-world Anchor
          // sources (marginfi-v2, mango-v4, squads-v4) trigger tree-sitter
          // grammar errors on patterns like `Context<'_, '_, 'info, 'info,
          // T<'info>>` — the rust grammar parses surrounding constructs as
          // a giant ERROR with #[program] mod buried inside. Without this
          // traversal classifyTopLevel never visits the mod and reports
          // "no #[program] found" despite the source containing one.
          walk(child, modulePath, inProgramModule);
          break;
        }
      }
    }
  }

  walk(root);

  // G32 — fallback when tree-sitter misparsed and the #[program] mod got
  // buried inside an ERROR-wrapped impl_item. Marginfi-v2 / mango-v4 /
  // squads-v4 hit a tree-sitter rust grammar gap (probably 4-lifetime
  // Context types) that makes the whole root an ERROR node and the
  // program mod ends up at path ERROR > impl_item > declaration_list >
  // mod_item. Only fires when (a) root is ERROR and (b) the normal walk
  // didn't find a program mod — so no risk of double-processing for
  // already-working fixtures like drift.
  if (rootIsError && !items.programModule) {
    function rescue(node: SyntaxNode, modulePath: string[] = []): void {
      let currentAttrs: SyntaxNode[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "attribute_item") { currentAttrs.push(child); continue; }
        if (child.type === "line_comment" || child.type === "block_comment") continue;
        const attrs = [...currentAttrs];
        currentAttrs = [];
        if (child.type === "mod_item" && hasAttribute(attrs, "program")) {
          items.programModule = { node: child, attrs };
          const body = child.childForFieldName("body");
          if (body) walk(body, [...modulePath, extractModuleName(child)], true);
          return;
        }
        // Recurse into impl/declaration containers that might wrap the mod.
        if (child.type === "impl_item" || child.type === "declaration_list" || child.type === "ERROR") {
          const innerBody = child.childForFieldName?.("body") ?? findDescendant(child, "declaration_list") ?? child;
          rescue(innerBody, modulePath);
          if (items.programModule) return;
        }
      }
    }
    rescue(root);
  }

  return items;
}

// ─── Utility functions ──────────────────────────────────────────────────────

/**
 * P6-A (#33) — harvest every module name DECLARED in the source: `mod x;`
 * decls and `mod x { ... }` blocks, any visibility, any nesting depth,
 * program module included. Regex over the raw text rather than the syntax
 * tree so the collection is independent of which normalization stage
 * consumed the declaration (project-source strips `mod x;` file decls,
 * Finding #67 round-trips top-level mods verbatim, program-inner mods are
 * flattened — all of them are legitimate user roots for path collapse).
 * Over-approximation by design: a false positive (e.g. `mod` in a comment)
 * only re-enables a collapse that was previously unconditional, and can
 * never resurrect an EXTERNAL_CRATE_ROOTS path — that guard runs first.
 */
function collectUserModuleRoots(source: string): string[] {
  const roots = new Set<string>();
  const re = /\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*[;{]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) roots.add(m[1]!);
  return [...roots].sort();
}

function extractModuleName(modNode: SyntaxNode): string {
  const nameNode = modNode.childForFieldName("name");
  return nameNode?.text ?? "unknown_program";
}

function extractStructName(node: SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

function extractInstructionArgs(attrs: SyntaxNode[]): string[] {
  for (const attr of attrs) {
    const text = attr.text;
    const match = text.match(/#\[instruction\(([^)]*)\)\]/);
    if (match?.[1]) {
      return match[1].split(",").map((s) => s.trim().replace(/:.*$/, "").trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * Detect the Anchor crate version from the source text. Three shapes
 * supported, in order of precedence:
 *
 *   1. `anchor-lang = { version = "0.31.1", features = [...] }` (extended form)
 *   2. `anchor-lang = "0.31"`        (terse form)
 *   3. `anchor-lang = "=0.31.0"`     (exact pin — leading = stripped)
 *
 * Task #27 (P4.1). Fall-through default is "0.30.0" — the baseline
 * Anchor version Anvil's parser was originally written against.
 */
function detectAnchorVersion(source: string): string {
  // Extended form: `anchor-lang = { version = "0.31.1", ... }`
  const extended = source.match(/anchor[_-]lang\s*=\s*\{\s*[^}]*\bversion\s*=\s*"([^"]+)"/);
  if (extended?.[1]) {
    return extended[1].replace(/^=/, "");
  }
  // Terse form: `anchor-lang = "0.31"`
  const terse = source.match(/anchor[_-]lang\s*=\s*"([^"]+)"/);
  return terse?.[1]?.replace(/^=/, "") ?? "0.30.0";
}

/**
 * Decide whether a trait-impl block's text is safe to emit verbatim onto a
 * post-Anchor target. Filters out impls whose body or trait references any
 * Anchor wrapper type, CpiContext, anchor_lang/anchor_spl helpers, or
 * Anchor-only macros. Keeps impls that operate only on the user's own
 * structs and stable solana-program / std types.
 *
 * The check is text-level rather than typed because the trait/target/body
 * span is large and tree-sitter doesn't give us a clean
 * "list-of-mentioned-types" selector. False negatives (rejecting an
 * actually-clean impl) are fine — the impl just stays out of emit and
 * downstream `Into::into` calls fall back to whatever they would have
 * done. False positives (admitting a referent-Anchor impl) would produce
 * a compile error, which is worse, so the bar is conservative.
 */
function isAnchorCleanTraitImpl(implText: string): boolean {
  // Lifetime parameters anywhere in the impl signature or body almost always
  // indicate Anchor-context types (`<'info, T>` accounts structs, fluent
  // CPI builders, sibling-program account contexts). Even when the lifetime
  // itself is innocuous, the surrounding types it parameterizes typically
  // aren't available post-emit. Reject conservatively — coral-swap's
  // `impl<'info> From<&Swap<'info>> for OrderbookClient<'info>` is the
  // canonical case (`OrderbookClient` lives in serum_dex which we can't
  // resolve). Trade-off: clean impls with `'a` lifetimes get false-rejected;
  // those rarely appear between user types in real Anchor programs.
  if (/<\s*'/.test(implText)) return false;
  if (/\bAccount\s*<\s*'/.test(implText)) return false;
  if (/\bInterfaceAccount\s*<\s*'/.test(implText)) return false;
  if (/\bInterface\s*<\s*'/.test(implText)) return false;
  if (/\bSigner\s*<\s*'/.test(implText)) return false;
  if (/\bSystemAccount\s*<\s*'/.test(implText)) return false;
  if (/\bUncheckedAccount\s*<\s*'/.test(implText)) return false;
  if (/\bAccountLoader\s*<\s*'/.test(implText)) return false;
  if (/\bContext\s*<\s*'?\s*\w+\s*>/.test(implText)) return false;
  if (/\bBox\s*<\s*(?:Interface)?Account\s*</.test(implText)) return false;
  if (/\bCpiContext\b/.test(implText)) return false;
  if (/\banchor_lang\b/.test(implText)) return false;
  if (/\banchor_spl\b/.test(implText)) return false;
  if (/\btoken_interface\s*::/.test(implText)) return false;
  if (/\bemit!\s*\(/.test(implText)) return false;
  if (/\brequire!\s*\(/.test(implText)) return false;
  return true;
}

