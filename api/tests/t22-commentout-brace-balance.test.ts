import { describe, test, expect } from "bun:test";
import { __testOnlyCommentOutT22ExtensionCallSites as commentOutT22 } from "../src/emitter/pinocchio-emitter.ts";

function bracesBalanced(src: string): boolean {
  let depth = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inString) { if (ch === "\\") { i++; continue; } if (ch === '"') inString = false; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth === 0;
}

describe("commentOutT22ExtensionCallSites — brace-balance regression (Squads v4 RW3)", () => {
  test("multi-line let-with-if-else over .data.borrow() comments as one unit", () => {
    const src = `
fn handler() {
    let proposal_account = if proposal.data.borrow().is_empty() {
        None
    } else {
        Some(Proposal::try_deserialize(
            &mut &**proposal.data.borrow_mut(),
        )?)
    };
    let other = 1;
}
`;
    const out = commentOutT22(src);
    expect(out).toContain("// ⚠️ Anvil TODO");
    expect(bracesBalanced(out)).toBe(true);
    expect(out).toContain("let other = 1;");
  });

  test("transitive closure on chained tracked idents stays brace-balanced", () => {
    const src = `
fn handler() {
    let proposal_account = if proposal.data.borrow().is_empty() {
        None
    } else {
        Some(Proposal::try_deserialize(&mut &**proposal.data.borrow_mut())?)
    };
    let can_close = if let Some(p) = &proposal_account {
        p.flag
    } else {
        true
    };
    if !can_close {
        return Err(Foo::Bar.into());
    }
    if !(other_check) {
        return Err(Foo::Baz.into());
    }
    if proposal_account.is_some() {
        close_thing(proposal)?;
    }
    close_program_account(batch_account, rent_collector)?;
    Ok(())
}
`;
    const out = commentOutT22(src);
    // Critical invariant: braces must balance so the file compiles.
    // The exact set of statements consumed by the conservative range
    // extension is acceptable to vary — the alternative (mid-block
    // commentout) leaves rustc with unbalanced delimiters, which is
    // strictly worse than over-commenting.
    expect(bracesBalanced(out)).toBe(true);
  });

  test("single-line .data.borrow() statement still balances (regression sanity)", () => {
    const src = `
fn handler() {
    let buf = mint.data.borrow();
    let other = 1;
}
`;
    const out = commentOutT22(src);
    expect(bracesBalanced(out)).toBe(true);
  });

  test("body with no T22 patterns is unchanged", () => {
    const src = `
fn handler() {
    let x = 1;
    let y = x + 2;
    Ok(())
}
`;
    const out = commentOutT22(src);
    expect(out).toBe(src);
  });
});
