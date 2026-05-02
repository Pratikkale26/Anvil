/**
 * Pass-through handler — the catch-all that runs the full text-transform
 * pipeline (CPI rewriters, ctx.accounts/bumps replacement, helper calls,
 * sysvar qualification, residual CpiContext cleanup) over arbitrary Rust
 * blocks the parser couldn't classify into typed IR statements.
 */

import type { BodyStatement } from "../../../ir/schema.js";
import {
  snakeCase,
  cleanInlineExpr,
  simplifyPassThroughCode,
} from "../../emitter-utils.js";
import { hasResidualAnchorPatterns } from "../../emitter-helpers.js";
import type { BodyWalker } from "../walker.js";

type PassThrough = Extract<BodyStatement, { kind: "pass_through" }>;

export function handlePassThrough(w: BodyWalker, stmt: PassThrough): void {
  w.ctx.passedThroughCount++;
  const rawCode = stmt.code.trim();

  // Skip pass_through Ok(()) — handled by instruction wrapper
  if (rawCode === "Ok(())") {
    w.emitAutoCloseAccounts();
    w.emitPendingSaves();
    w.lines.push(`    Ok(())`);
    return;
  }

  // Transform require!() macros that leaked through as pass_through
  const requireMatch = rawCode.match(/^require!\(([\s\S]+),\s*([\w:]+(?:::\w+)*)\s*\);?$/);
  if (requireMatch?.[1] && requireMatch[2]) {
    w.ctx.transformedCount++;
    const condition = w.normalizeKeyValueUsages(
      w.transformCtxAccountsReferences(requireMatch[1].trim()),
    );
    w.lines.push(w.emitter.emitRequire(condition, requireMatch[2]));
    return;
  }

  // Transform comparison-flavored Anchor macros: require_eq!, require_neq!,
  // require_gt!, require_gte!, require_lt!, require_lte!,
  // require_keys_eq!, require_keys_neq!. All take `(lhs, rhs, error)` and
  // assert the relation. The keys_* variants compare Pubkey values, which
  // are `[u8; 32]` on Pinocchio and `Pubkey` on Native — both have Eq, so
  // the same `==` / `!=` operator works without target-specific casing.
  const requireCmpMatch = rawCode.match(
    /^require_(eq|neq|gt|gte|lt|lte|keys_eq|keys_neq)!\(\s*([\s\S]+?)\s*,\s*([\s\S]+?)\s*,\s*([\w:]+(?:::\w+)*)\s*\);?$/,
  );
  if (requireCmpMatch?.[1] && requireCmpMatch[2] && requireCmpMatch[3] && requireCmpMatch[4]) {
    const cmpOps: Record<string, string> = {
      eq: "==", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=",
      keys_eq: "==", keys_neq: "!=",
    };
    const op = cmpOps[requireCmpMatch[1]] ?? "==";
    const lhs = w.normalizeKeyValueUsages(w.transformCtxAccountsReferences(requireCmpMatch[2]));
    const rhs = w.normalizeKeyValueUsages(w.transformCtxAccountsReferences(requireCmpMatch[3]));
    w.ctx.transformedCount++;
    w.lines.push(w.emitter.emitRequire(`${lhs} ${op} ${rhs}`, requireCmpMatch[4]));
    return;
  }

  const { prelude, code: bumpAdjustedRawCode } = w.replaceBumpRefs(rawCode);
  let transformedRawCode = simplifyPassThroughCode(
    w.transformHelperCalls(
      w.normalizeKeyValueUsages(
        w.transformAccountReferences(
          w.transformCtxAccountsReferences(w.transformNestedAnchorCode(bumpAdjustedRawCode)),
        ),
      ),
    ),
  );
  transformedRawCode = w.normalizeToAccountInfoCalls(transformedRawCode);
  transformedRawCode = transformedRawCode
    .replace(/(?<!:)\bClock::get\(\)\?/g, w.qualifiedClockGetExpr())
    .replace(/(?<!:)\bRent::get\(\)\?/g, w.qualifiedRentGetExpr())
    .replace(/(?<!:)\bClock::get\(\)/g, w.qualifiedClockGetValueExpr())
    .replace(/(?<!:)\bRent::get\(\)/g, w.qualifiedRentGetValueExpr());
  for (const preludeLine of prelude) {
    w.lines.push(preludeLine);
  }
  for (const signerSeedsPrelude of w.ensureSignerSeedsForCode(transformedRawCode)) {
    w.lines.push(signerSeedsPrelude);
  }

  // Mutation tracking on state-bound locals. A pass_through statement that
  // does `<local>.<field> = X`, `<local>.<field>.<method>(…)`, or
  // `<local>.<field>[idx] = X` against a state_read'd local var (e.g.
  // `p.approved[idx] = true` where `p = ctx.accounts.proposal`) is an
  // in-memory mutation that must round-trip back to the account data via
  // emitPendingSaves. Pre-fix the typed state_field_assign IR kind handled
  // direct field assignment, but indexed/method-mutating assignments fall
  // through to this handler and were silently dropped — the in-memory
  // change never made it back to the account.
  //
  // Detection: scan the original rawCode (before transforms) for any of the
  // mutation shapes against state-bound locals. For each match, find the
  // canonical account name and add to mutatedAccounts.
  for (const [accountName, localVar] of w.stateVars.entries()) {
    // Match: `<local>.<rest>` followed by `=` (not `==`), `+=`, `-=`, etc,
    // OR `<local>[idx] = X` form, OR a Vec/HashMap mutating method call.
    const localEsc = localVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mutationPatterns = [
      // p.field = ... / p.field += ... / p.field.push(...) / p.field[idx] = ...
      new RegExp(`\\b${localEsc}\\.\\w+\\s*(?:=[^=]|\\[)`),
      new RegExp(`\\b${localEsc}\\.\\w+\\s*[+\\-*/%]=`),
      new RegExp(`\\b${localEsc}\\.\\w+(?:\\.\\w+)*\\.(?:push|insert|remove|pop|clear|truncate|extend|swap_remove)\\b`),
    ];
    if (mutationPatterns.some((re) => re.test(rawCode))) {
      w.mutatedAccounts.add(accountName);
    }
  }

  // Strip .to_account_info() on all targets. Anchor's Account<'info, T>
  // exposes the method; once we've resolved to bare solana_program /
  // pinocchio AccountInfo (which IS AccountInfo by definition — no-op on
  // native, doesn't exist on pinocchio/quasar), the method call is
  // either redundant or unresolvable. Strip universally.
  transformedRawCode = transformedRawCode.replace(/\.to_account_info\(\)/g, "");

  // ── Final CPI cleanup: convert remaining CpiContext patterns to invoke() ──
  // Handles cases where CpiContext::new() uses pre-extracted variables or was
  // not caught by the specific CPI regex patterns above.
  if (/CpiContext::/.test(transformedRawCode)) {
    transformedRawCode = transformedRawCode.replace(
      /let\s+(\w+)\s*=\s*CpiContext::new(?:_with_signer)?\(\s*(\w+)\s*,\s*(\w+)\s*(?:,\s*[^)]+)?\)(?:\s*\.with_signer\([^)]+\))?\s*;?/g,
      (_full, ctxVar: string, programVar: string, _accountsVar: string) =>
        `// CPI context prepared — program: ${programVar}\n    let ${ctxVar}_program = ${programVar};`,
    );
    {
      const caMatch = transformedRawCode.match(
        /create_account\(\s*CpiContext::new\(\s*[\s\S]*?,\s*(?:\w+::)*CreateAccount\s*\{([\s\S]*?)\}\s*,?\s*\)\s*,([\s\S]*?)\)\?;/,
      );
      if (caMatch?.[1] && caMatch[2]) {
        const fieldsStr = caMatch[1];
        const fromMatch = fieldsStr.match(/from:\s*(\w+)/);
        const toMatch = fieldsStr.match(/to:\s*(\w+)/);
        const fromVar = fromMatch?.[1] ?? "payer";
        const toVar = toMatch?.[1] ?? "new_account";
        const rawArgs = caMatch[2].replace(/\/\/[^\n]*/g, "").trim();
        const argParts = rawArgs.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
        const lamports = argParts[0] ?? "0";
        const space = argParts[1] ?? "0";
        const owner = argParts[2] ?? "program_id";
        transformedRawCode = w.emitter.emitCreateAccountCpi(fromVar, toVar, lamports, space, owner);
      }
    }
    transformedRawCode = transformedRawCode.replace(
      /(\w+(?:::\w+)*)\(\s*CpiContext::new\(\s*([\s\S]*?),\s*(\w+)\s*\{([\s\S]*?)\}\s*,?\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)\?;/g,
      (_full, fnName: string, _programExpr: string, _structName: string, fieldsStr: string, extraArgs: string) => {
        const accountVars = fieldsStr
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .map((f) => {
            const m = f.match(/\w+:\s*(\w+)/);
            return m?.[1] ?? null;
          })
          .filter((v): v is string => v !== null);
        const argsStr = extraArgs ? `\n    // args: ${cleanInlineExpr(extraArgs)}` : "";
        // The actual `invoke(...)` call is left commented-out: it referenced
        // `solana_program::instruction::Instruction` which isn't in scope on
        // pinocchio, and even on native the data/accounts vecs are empty —
        // the runtime call would always fail. Compiling-but-no-op is better
        // than a 5-error pile that hides the rest of the program's issues.
        // The TODO above tells the user what to fill in.
        return `// ⚠️ Anvil: CPI call to ${fnName} — requires manual implementation${argsStr}\n    // Accounts: ${accountVars.join(", ")}\n    // TODO(manual): rebuild this CPI for the target framework. Source signature\n    // and account list above. Reference (commented out — does not compile on\n    // pinocchio because solana_program is not in scope, and accounts/data are\n    // empty placeholders even on native):\n    //\n    // invoke(\n    //     &solana_program::instruction::Instruction {\n    //         program_id: *${accountVars.length > 0 ? accountVars[0] : "program"}.key,\n    //         accounts: vec![],\n    //         data: vec![],\n    //     },\n    //     &[${accountVars.map((v) => `${v}.clone()`).join(", ")}],\n    // )?;`;
      },
    );
  }

  // ── Handle module::cpi::function(cpi_ctx, args) patterns ──
  if (/\w+::cpi::\w+\(/.test(transformedRawCode)) {
    transformedRawCode = transformedRawCode.replace(
      /(\w+)::cpi::(\w+)\(\s*(\w+)\s*(?:,\s*([\s\S]*?))?\s*\)\s*(?:\?;|;)?$/g,
      (_full, moduleName: string, fnName: string, ctxVar: string, args: string) => {
        const argsStr = args ? cleanInlineExpr(args) : "";
        // Same rationale as the CpiContext stub above — comment out the
        // broken invoke skeleton so the rest of the file still compiles.
        return `// ⚠️ Anvil: CPI to ${moduleName}::${fnName}\n    // Original args: ${argsStr}\n    // TODO(manual): rebuild for target framework. Reference skeleton (does\n    // not compile — placeholder only):\n    //\n    // invoke(\n    //     &solana_program::instruction::Instruction {\n    //         program_id: *${ctxVar}_program.key,\n    //         accounts: vec![],\n    //         data: vec![], // discriminator + args for '${snakeCase(fnName)}'\n    //     },\n    //     &[],\n    // )?;`;
      },
    );
  }

  // Don't add extra semicolons if the code already ends with ;, } or )
  let code: string;
  if (
    transformedRawCode.endsWith(";") ||
    transformedRawCode.endsWith("}") ||
    transformedRawCode.endsWith(");")
  ) {
    code = `    ${transformedRawCode}`;
  } else {
    code = `    ${transformedRawCode};`;
  }
  if (stmt.needsReview && hasResidualAnchorPatterns(transformedRawCode)) {
    code = `    // ⚠️ Anvil: Review this section — ${stmt.reviewReason ?? "may need manual verification"}\n${code}`;
  }
  w.lines.push(code);
}
