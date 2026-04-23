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

  // Strip .to_account_info() — not available in pinocchio/quasar
  if (w.emitter.frameworkName !== "Native") {
    transformedRawCode = transformedRawCode.replace(/\.to_account_info\(\)/g, "");
  }

  // ── Final CPI cleanup: convert remaining CpiContext patterns to invoke() ──
  // Handles cases where CpiContext::new() uses pre-extracted variables or was
  // not caught by the specific CPI regex patterns above.
  if (/CpiContext::/.test(transformedRawCode)) {
    transformedRawCode = transformedRawCode.replace(
      /let\s+(\w+)\s*=\s*CpiContext::new\(\s*(\w+)\s*,\s*(\w+)\s*\);?/g,
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
        return `// ⚠️ Anvil: CPI call to ${fnName} — requires manual invoke() implementation${argsStr}\n    // Accounts: ${accountVars.join(", ")}\n    invoke(\n        &solana_program::instruction::Instruction {\n            program_id: *${accountVars.length > 0 ? accountVars[0] : "program"}.key,\n            accounts: vec![],  // TODO: build AccountMeta list\n            data: vec![],      // TODO: build instruction data\n        },\n        &[${accountVars.map((v) => `${v}.clone()`).join(", ")}],\n    )?;`;
      },
    );
  }

  // ── Handle module::cpi::function(cpi_ctx, args) patterns ──
  if (/\w+::cpi::\w+\(/.test(transformedRawCode)) {
    transformedRawCode = transformedRawCode.replace(
      /(\w+)::cpi::(\w+)\(\s*(\w+)\s*(?:,\s*([\s\S]*?))?\s*\)\s*(?:\?;|;)?$/g,
      (_full, moduleName: string, fnName: string, ctxVar: string, args: string) => {
        const argsStr = args ? cleanInlineExpr(args) : "";
        return `// ⚠️ Anvil: CPI to ${moduleName}::${fnName}\n    // Original args: ${argsStr}\n    // Use invoke() with ${ctxVar}_program and build instruction data manually\n    invoke(\n        &solana_program::instruction::Instruction {\n            program_id: *${ctxVar}_program.key,\n            accounts: vec![],  // TODO: build AccountMeta list from cpi_accounts\n            data: vec![],      // TODO: build discriminator + args for '${snakeCase(fnName)}'\n        },\n        &[],  // TODO: pass account infos\n    )?;`;
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
