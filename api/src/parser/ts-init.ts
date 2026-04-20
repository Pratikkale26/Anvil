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
