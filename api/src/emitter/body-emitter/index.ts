/**
 * Body Emitter — walks IR body statements and emits framework-specific Rust
 * code. The public surface is `emitBodyStatements`; the BodyWalker class and
 * per-kind handlers are internal to this package.
 */

import type { SolanaIR, Instruction, BodyStatement } from "../../ir/schema.js";
import { BodyWalker } from "./walker.js";
import type { BodyEmitterCallbacks, BodyEmitterContext } from "./types.js";

export type { BodyEmitterCallbacks, BodyEmitterContext } from "./types.js";

export function emitBodyStatements(
  emitter: BodyEmitterCallbacks,
  ctx: BodyEmitterContext,
  statements: BodyStatement[],
  instr: Instruction,
  ir: SolanaIR,
): string {
  return new BodyWalker(emitter, ctx, statements, instr, ir).walk();
}
