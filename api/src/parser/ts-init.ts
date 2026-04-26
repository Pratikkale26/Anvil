/**
 * Tree-sitter Initialization — Lazy Singleton
 *
 * Loads web-tree-sitter WASM + tree-sitter-rust grammar once.
 * All parser modules import `getParser()` from here.
 */

import { Parser, Language, type Node, type Tree } from "web-tree-sitter";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let parserInstance: Parser | null = null;
let initPromise: Promise<Parser> | null = null;

/**
 * Returns an initialized tree-sitter Parser with the Rust language.
 * Safe to call multiple times — initializes only once.
 */
export function getParser(): Promise<Parser> {
  if (parserInstance) return Promise.resolve(parserInstance);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await Parser.init({
      // Help web-tree-sitter find its own WASM file
      locateFile(scriptName: string, _scriptDirectory: string) {
        return resolve(
          __dirname,
          "../../node_modules/web-tree-sitter",
          scriptName
        );
      },
    });

    const parser = new Parser();

    // Load the Rust grammar WASM — try multiple potential paths
    const wasmPaths = [
      resolve(__dirname, "../../node_modules/tree-sitter-rust/tree-sitter-rust.wasm"),
      resolve(__dirname, "../../../node_modules/tree-sitter-rust/tree-sitter-rust.wasm"),
    ];

    let loaded = false;
    for (const wasmPath of wasmPaths) {
      try {
        const Rust = await Language.load(wasmPath);
        parser.setLanguage(Rust);
        loaded = true;
        break;
      } catch {
        // Try next path
      }
    }

    if (!loaded) {
      throw new Error(
        `Could not load tree-sitter-rust.wasm. Tried:\n${wasmPaths.join("\n")}\n` +
        `Run: bun add web-tree-sitter tree-sitter-rust`
      );
    }

    parserInstance = parser;
    return parser;
  })();

  return initPromise;
}

/** Re-export the Node type for use in other modules */
export type SyntaxNode = Node;
export type { Parser };
export type { Tree };

// ─────────────────────────────────────────────────────────────────────────────
// Parse deadline (request-scoped cooperative cancellation)
//
// tree-sitter parsing is synchronous and CPU-bound. A pathological input
// (deep nested generics, large macro expansions) can wedge a request
// indefinitely. web-tree-sitter accepts a `progressCallback` per parse call
// that returns true to cancel — we use a module-level deadline so the
// initial parse + every synthetic sub-parse in instruction-parser.ts share
// the same budget.
//
// Set via withParseDeadline() at the entry point (parseAnchor). Sub-parses
// call parseGuarded() which threads the deadline into the parser.
// ─────────────────────────────────────────────────────────────────────────────

let parseDeadlineMs: number | null = null;

export class ParseTimeoutError extends Error {
  constructor(public readonly elapsedMs: number, public readonly limitMs: number) {
    super(`Parse exceeded ${limitMs}ms timeout (elapsed ${elapsedMs}ms). Source likely malformed or pathological.`);
    this.name = "ParseTimeoutError";
  }
}

/**
 * Run `fn` with a parse deadline of `timeoutMs` from now. Nested calls
 * inherit the outer deadline (the inner does not extend it).
 */
export async function withParseDeadline<T>(timeoutMs: number, fn: () => Promise<T> | T): Promise<T> {
  const prev = parseDeadlineMs;
  // Inherit the tighter of inner request vs outer ambient deadline.
  const newDeadline = Date.now() + Math.max(0, timeoutMs);
  parseDeadlineMs = prev !== null ? Math.min(prev, newDeadline) : newDeadline;
  try {
    return await fn();
  } finally {
    parseDeadlineMs = prev;
  }
}

/**
 * Parse `source` with the request-scoped deadline. Throws ParseTimeoutError
 * if the deadline elapses or tree-sitter returns null after cancellation.
 * Without an active deadline, behaves like parser.parse().
 */
export function parseGuarded(parser: Parser, source: string): Tree {
  const deadline = parseDeadlineMs;
  if (deadline === null) {
    const tree = parser.parse(source);
    if (!tree) throw new Error("tree-sitter returned null parse tree");
    return tree;
  }
  const start = Date.now();
  const tree = parser.parse(source, undefined, {
    progressCallback: () => Date.now() >= deadline,
  });
  if (!tree) {
    const elapsed = Date.now() - start;
    // Either the parser cancelled (deadline hit) or returned null for some
    // other reason. In both cases the call surfaces as a timeout because
    // we can't continue without a tree. Per web-tree-sitter docs, an
    // interrupted parse leaves the parser instance in an indeterminate
    // state until reset — without this, the next parser.parse() call on
    // the singleton returns a corrupt tree (e.g. missing top-level items).
    parser.reset();
    throw new ParseTimeoutError(elapsed, Math.max(0, deadline - start + elapsed));
  }
  return tree;
}
