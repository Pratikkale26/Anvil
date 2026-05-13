/**
 * Post-emit cleanup — runs after the visitor has emitted every body
 * statement and the lines are joined. These regexes target cross-stmt
 * symmetry cleanups that aren't tractable to express structurally
 * (yet): they read a comparison context that spans the two operand
 * sub-trees of an `==` / `!=` site, which the visitor builds
 * independently with no knowledge of its sibling.
 *
 * Split out of walker.ts walk() in H1 Session H so the post-emit
 * boundary is named + greppable. Each regex is sized at one targeted
 * shape; if a future visitor change emits these shapes correctly the
 * regex becomes dead and can be deleted.
 *
 * Why the cleanups exist:
 *
 *   1. **Stacked-star collapse** (`**X.key()` → `*X.key()`).
 *      Upstream rewrites can stack stars when source had
 *      `*ctx.accounts.X.key` and `transformAccountReferences`
 *      re-prepends another `*` via `emitAccountKeyExpr`. Used at
 *      end of walk() AND inside `transformAccountReferences` (two
 *      call sites, same logic, exposed via `collapseStackedKeyDerefs`
 *      on BodyWalker).
 *
 *   2. **Comparison-context deref-strip on `*X.key`/`*X.key()`.**
 *      Triggers in iter-chain shapes like
 *      `if &acc.pubkey == *signer.key`, where Anchor source
 *      originally had `... == ctx.accounts.signer.key` (auto-deref'd
 *      to `&Pubkey`) and `emitAccountKeyExpr` collapsed it to a
 *      by-value form. The `(?:\(\))?` suffix covers both native
 *      (`*X.key`, no parens) and pinocchio (`*X.key()`, parens).
 *
 *   3. **Closure-context variants** of #2. The closure param yielded
 *      by `Vec<Pubkey>::iter()` is `&Pubkey` (auto-borrow), so
 *      dropping the deref keeps `&Pubkey == &Pubkey` symmetric.
 *      Matches the multisig
 *      `multisig.owners.iter().position(|a| a == *proposer.key)`
 *      shape.
 */

/**
 * Run the full post-emit regex chain on the joined emit text. Order
 * matters: stacked-star collapse runs FIRST so the comparison-context
 * strips see a single `*` prefix.
 */
export function applyPostEmitCleanup(
  collapseStackedKeyDerefs: (code: string) => string,
  joined: string,
): string {
  const result = collapseStackedKeyDerefs(joined);
  return result
    // (2) deref strip — LHS-deref vs RHS-ref shape, both directions.
    .replace(/(&[\w.]+(?:\(\))?\s*[=!]=\s*)\*(\w+)\.key(\(\))?\b(?!\w)/g, "$1$2.key$3")
    .replace(/\*(\w+)\.key(\(\))?\b(?!\w)(\s*[=!]=\s*&[\w.]+(?:\(\))?)/g, "$1.key$2$3")
    // (3) closure-context — closure-bound param compared with
    // *X.key, both orderings (param-on-left / param-on-right).
    .replace(/\|\s*(\w+)\s*\|\s*\1\s*([=!]=)\s*\*(\w+)\.key(\(\))?\b(?!\w)/g, "|$1| $1 $2 $3.key$4")
    .replace(/\|\s*(\w+)\s*\|\s*\*(\w+)\.key(\(\))?\b(?!\w)(\s*[=!]=\s*)\1\b/g, "|$1| $2.key$3$4$1");
}
