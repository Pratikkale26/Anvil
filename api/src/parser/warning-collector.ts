/**
 * WarningCollector — collects ParserWarnings during a single parseAnchor() call.
 *
 * Plumbed through cpi-detector → body-classifier → instruction-parser → parseAnchor.
 * Each fallback site (CPI shape unrecognized, signer_seeds dropped, etc.) calls
 * `collector.add(...)`; parseAnchor drains them into `ir.warnings` and the
 * output validator surfaces them as ValidationIssues.
 *
 * The collector is per-parse, not module-level — concurrent parseAnchor calls
 * each get their own instance, so two requests don't cross-pollute warnings.
 *
 * Truncation: snippets are capped at 280 chars (one tweet) so a giant
 * pass_through block doesn't blow up the IR or the validator output.
 */
import type { ParserWarning, ParserWarningCode, SourceLoc } from "../ir/schema.js";
import type { SyntaxNode } from "./ts-init.js";

const SNIPPET_MAX = 280;

export interface WarningCollector {
  /** Push a warning. Snippet is truncated to SNIPPET_MAX. */
  add(input: {
    code: ParserWarningCode;
    message: string;
    instruction?: string;
    snippet?: string;
    loc?: SourceLoc;
  }): void;
  /** Drain the collected warnings; collector remains usable. */
  drain(): ParserWarning[];
  /** Return a child collector that pre-fills `instruction` on every add. */
  forInstruction(instruction: string): WarningCollector;
}

/**
 * Convert a tree-sitter node's startPosition/endPosition into a SourceLoc.
 * Tree-sitter rows are 0-indexed; we convert to 1-indexed lines (the
 * convention rustc + every editor uses) so the validator's per-issue
 * line field is human-readable without further rewriting.
 */
export function locFromNode(node: SyntaxNode | null | undefined): SourceLoc | undefined {
  if (!node) return undefined;
  const start = node.startPosition;
  const end = node.endPosition;
  return {
    line: start.row + 1,
    column: start.column,
    endLine: end.row + 1,
    endColumn: end.column,
  };
}

export function createWarningCollector(): WarningCollector {
  const out: ParserWarning[] = [];

  function snippetClean(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const trimmed = s.replace(/\s+/g, " ").trim();
    return trimmed.length > SNIPPET_MAX
      ? `${trimmed.slice(0, SNIPPET_MAX - 1)}…`
      : trimmed;
  }

  const root: WarningCollector = {
    add(input) {
      out.push({
        code: input.code,
        message: input.message,
        ...(input.instruction ? { instruction: input.instruction } : {}),
        ...(input.snippet ? { snippet: snippetClean(input.snippet) ?? "" } : {}),
        ...(input.loc ? { loc: input.loc } : {}),
      });
    },
    drain() {
      return out.slice();
    },
    forInstruction(instruction) {
      return {
        add(input) {
          root.add({ ...input, instruction: input.instruction ?? instruction });
        },
        drain: root.drain,
        forInstruction: (i: string) => root.forInstruction(i),
      };
    },
  };
  return root;
}

/** A no-op collector for callers that don't care (tests, CLI tools). */
export const NULL_WARNING_COLLECTOR: WarningCollector = {
  add: () => {},
  drain: () => [],
  forInstruction: () => NULL_WARNING_COLLECTOR,
};
