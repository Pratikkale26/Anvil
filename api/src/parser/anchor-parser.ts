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
import { parseAccountDataStruct } from "./account-parser.js";
import { parseErrorEnum, parseHelperFn, parseCustomType, extractImports, extractProgramId } from "./type-parser.js";
import { createWarningCollector } from "./warning-collector.js";
import { buildHelperCpiCatalog } from "./helper-cpi-catalog.js";
import { rewriteErrMacroToExplicit } from "./project-source.js";

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

    // ── Parse account data structs (#[account] structs) ──
    const accounts = topLevel.accountDataStructs.map((s) => {
      const def = parseAccountDataStruct(s.node, s.attrs);
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

    // ── Per-parse warning collector (loud parser-degradation signal) ──
    // Drained into `irRaw.warnings` after instruction classification so the
    // validator (and downstream consumers) see what the parser couldn't fully
    // classify. See ParserWarning in ir/schema.ts.
    const warningCollector = createWarningCollector();

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

    // ── Parse errors ──
    const errors = topLevel.errorEnums.flatMap((e) => parseErrorEnum(e.node, e.attrs));

    // ── Parse #[event] structs ──
    // Reuse parseAccountDataStruct's field walker since #[event] structs are
    // structurally identical to #[account] structs minus the discriminator
    // (which we synthesize at emit time from sha256("event:Name")). The
    // resulting AccountDef's `space` and `implItems` are unused for events.
    const events = topLevel.eventStructs.map((s) => {
      const def = parseAccountDataStruct(s.node, s.attrs);
      return { name: def.name, fields: def.fields };
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
      userTraitImpls,
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
}

function classifyTopLevel(root: SyntaxNode): TopLevelItems {
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
  };

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
          if (hasAttribute(attrs, "error_code")) {
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
          // (a) literal `handler` in a submodule, (b) any function whose first
          // parameter is `ctx: Context<X>` — that's Anchor handler shape and
          // its body is already absorbed into the program's instruction list.
          const lastModule = modulePath[modulePath.length - 1];
          const isInstructionHandler =
            modulePath.length > 0 &&
            (functionName === "handler" || functionName === `${lastModule}_handler`);
          const params = child.childForFieldName("parameters")?.text ?? "";
          // Match `ctx: Context<…>` AND `_ctx: Context<…>` (Anchor's "unused
          // arg" convention). `\bctx` alone fails on `_ctx` because `\b` is
          // not a boundary between two word chars (`_` and `c`).
          const looksLikeAnchorHandler = /(?:^|[\s(,])_?ctx\s*:\s*(?:&\s*mut\s+)?Context\s*</.test(params);
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
          const implName = extractImplTargetName(child);
          const implBody = child.childForFieldName("body") ?? findDescendant(child, "declaration_list");
          if (!implName || !implBody) break;
          for (let j = 0; j < implBody.namedChildCount; j++) {
            const implChild = implBody.namedChild(j);
            if (!implChild) continue;
            if (implChild.type === "function_item") {
              const methodName = implChild.childForFieldName("name")?.text;
              if (!methodName) continue;
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
      }
    }
  }

  walk(root);

  return items;
}

// ─── Utility functions ──────────────────────────────────────────────────────

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

