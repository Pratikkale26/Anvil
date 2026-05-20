// Walker block-comment-marker regression test.
//
// Rust nests block comments strictly: an inner /-* opens a level, an
// inner *-/ closes one. Inline TODO markers emitted by the walker MUST
// NOT contain those tokens in their body — they open/close a NESTED
// comment that the outer wrapping then can't balance.
//
// Caught by arjun-merkle-tree build failure: the marker text contained
// `contexts/[file].rs` (referring to a sibling file path), which Rust's
// lexer read as the `/-*` slash-asterisk opening an inner comment whose
// matching `*-/` was inside the same comment body, leaving the outer
// block unterminated.
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

// Walk a Rust source string and assert nested-block-comment depth never
// goes negative AND ends at zero. Single-line "//" comments are skipped.
// String literals are NOT respected — that's a separate parser concern,
// but emitted Rust shouldn't have suspicious block-comment open/close
// tokens in strings either.
function blockCommentDepth(src: string): { final: number; minSeen: number } {
  let depth = 0;
  let minSeen = 0;
  let i = 0;
  while (i < src.length - 1) {
    // Single-line comments — skip to end of line; nothing inside affects depth.
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (src[i] === "*" && src[i + 1] === "/") {
      depth--;
      if (depth < minSeen) minSeen = depth;
      i += 2;
      continue;
    }
    i++;
  }
  return { final: depth, minSeen };
}

describe("walker block-comment markers don't open nested comments", () => {
  test("blockCommentDepth helper sanity (simple cases)", () => {
    expect(blockCommentDepth("a /* b */ c")).toEqual({ final: 0, minSeen: 0 });
    expect(blockCommentDepth("a /* b /* c */ d */ e")).toEqual({ final: 0, minSeen: 0 });
    expect(blockCommentDepth("a /* b /* c */ d e")).toEqual({ final: 1, minSeen: 0 });
    expect(blockCommentDepth("a // /* not nested */\nb")).toEqual({ final: 0, minSeen: 0 });
  });

  test("ctx.bumps standalone arg emits balanced block comment", async () => {
    const src = `use anchor_lang::prelude::*;
declare_id!("BumpsRef1111111111111111111111111111111111A");
#[program]
pub mod bumps_struct_ref {
    use super::*;
    pub fn doit(ctx: Context<DoIt>) -> Result<()> {
        ctx.accounts.helper(&ctx.bumps)
    }
}
#[derive(Accounts)]
pub struct DoIt {}
`;
    const parsed = await parseAnchor(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    for (const target of ["pinocchio", "native"] as const) {
      const out = target === "pinocchio" ? emitPinocchioFull(parsed.ir) : emitNativeFull(parsed.ir);
      for (const f of out.files) {
        const { final, minSeen } = blockCommentDepth(f.content);
        if (final !== 0 || minSeen < 0) {
          throw new Error(
            `[${target}/${f.path}] block-comment imbalance: final=${final} minSeen=${minSeen}`,
          );
        }
      }
    }
  });
});
