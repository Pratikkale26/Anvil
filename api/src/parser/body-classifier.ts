/**
 * Instruction Body Classifier
 *
 * Takes raw Rust function body text from an Anchor instruction and classifies
 * each statement as either:
 *   TRANSFORM — framework-specific pattern that emitters must rewrite
 *   PASS-THROUGH — pure Rust code preserved unchanged across all targets
 *
 * This is the core innovation enabling Anvil to handle ANY Anchor contract.
 */

import type { BodyStatement } from "../ir/schema.js";
import { detectCpi, type CpiDetection } from "./cpi-detector.js";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify the body of an Anchor instruction function.
 * @param bodyText — everything inside the function braces (excluding the outer { })
 * @returns classified body statements in order
 */
export function classifyBody(bodyText: string): BodyStatement[] {
  const stripped = stripOuterBraces(bodyText).trim();
  if (!stripped) return [{ kind: "return_ok" }];

  const statements = splitIntoStatements(stripped);
  const result: BodyStatement[] = [];

  let i = 0;
  while (i < statements.length) {
    const stmt = statements[i]?.trim() ?? "";
    if (!stmt) { i++; continue; }

    // ── Check for multi-statement CPI pattern ──
    // Pattern: CpiContext::new(...) on stmt i, then function call using it on stmt i+1
    const cpiResult = tryCpiGroup(statements, i);
    if (cpiResult) {
      result.push(cpiResult.statement);
      i = cpiResult.nextIndex;
      continue;
    }

    // ── Check for PDA signer seeds pattern ──
    // Pattern: let seeds = &[...]; let signer_seeds = &[&seeds[..]];
    const seedsResult = tryPdaSignerSeeds(statements, i);
    if (seedsResult) {
      result.push(seedsResult.statement);
      i = seedsResult.nextIndex;
      continue;
    }

    // ── Single statement classification ──
    result.push(classifySingleStatement(stmt));
    i++;
  }

  return result;
}

// ─── Statement splitter ──────────────────────────────────────────────────────

/**
 * Split a function body into individual logical statements.
 * Handles nested braces, parens, brackets, and string literals.
 * Splits on `;` at depth 0.
 */
function splitIntoStatements(body: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;       // { } depth
  let parenDepth = 0;  // ( ) depth
  let bracketDepth = 0; // [ ] depth
  let inString = false;
  let inChar = false;
  let inLineComment = false;
  let inBlockComment = false;
  let prevChar = "";

  for (let idx = 0; idx < body.length; idx++) {
    const ch = body[idx] ?? "";
    const next = body[idx + 1] ?? "";

    // Handle comments
    if (!inString && !inChar && !inBlockComment && ch === "/" && next === "/") {
      inLineComment = true;
    }
    if (inLineComment && ch === "\n") {
      inLineComment = false;
      current += ch;
      prevChar = ch;
      continue;
    }
    if (inLineComment) {
      current += ch;
      prevChar = ch;
      continue;
    }

    if (!inString && !inChar && !inLineComment && ch === "/" && next === "*") {
      inBlockComment = true;
    }
    if (inBlockComment && ch === "*" && next === "/") {
      inBlockComment = false;
      current += ch + next;
      idx++;
      prevChar = next;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      prevChar = ch;
      continue;
    }

    // Handle string literals
    if (!inChar && ch === "\"" && prevChar !== "\\") {
      inString = !inString;
    }
    if (!inString && ch === "'" && prevChar !== "\\" && !isLifetimeOrCharContext(body, idx)) {
      inChar = !inChar;
    }

    if (inString || inChar) {
      current += ch;
      prevChar = ch;
      continue;
    }

    // Track depth
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;

    // Split on semicolons at depth 0
    if (ch === ";" && depth === 0 && parenDepth === 0 && bracketDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      prevChar = ch;
      continue;
    }

    current += ch;
    prevChar = ch;
  }

  // Handle last statement (might not end with ;, e.g., Ok(()))
  const remaining = current.trim();
  if (remaining) statements.push(remaining);

  return statements;
}

// ─── Single statement classifier ─────────────────────────────────────────────

function classifySingleStatement(stmt: string): BodyStatement {
  // ── Ok(()) — return success ──
  if (/^\s*Ok\s*\(\s*\(\s*\)\s*\)\s*$/.test(stmt)) {
    return { kind: "return_ok" };
  }

  // ── return Err(...) ──
  const returnErrMatch = stmt.match(/^\s*return\s+Err\s*\((.+)\)\s*$/s);
  if (returnErrMatch?.[1]) {
    return { kind: "return_err", error: returnErrMatch[1].trim() };
  }

  // ── ctx.accounts access ──
  // let pool = &mut ctx.accounts.pool;
  // let pool = &ctx.accounts.pool;
  // let authority = ctx.accounts.authority.key();
  const ctxAccountsMatch = stmt.match(
    /^\s*let\s+(mut\s+)?(\w+)\s*=\s*(&mut\s+|&\s*)?ctx\.accounts\.(\w+)/
  );
  if (ctxAccountsMatch?.[2] && ctxAccountsMatch[4]) {
    const localVar = ctxAccountsMatch[2];
    const mutable = !!(ctxAccountsMatch[1] || ctxAccountsMatch[3]?.includes("mut"));
    const account = ctxAccountsMatch[4];
    return {
      kind: "state_read",
      account,
      localVar,
      mutable,
      accountType: "",
    };
  }

  // ── ctx.bumps access ──
  // counter.bump = ctx.bumps.counter;
  // let bump = ctx.bumps.vault_state;
  const ctxBumpsMatch = stmt.match(/ctx\.bumps\.(\w+)/);
  if (ctxBumpsMatch) {
    // Could be an assignment like state.bump = ctx.bumps.X or a let binding
    const assignMatch = stmt.match(/^\s*(\w+)\.(\w+)\s*=\s*ctx\.bumps\.(\w+)/);
    if (assignMatch?.[1] && assignMatch[2] && assignMatch[3]) {
      return {
        kind: "state_field_assign",
        account: assignMatch[1],
        field: assignMatch[2],
        value: `ctx.bumps.${assignMatch[3]}`,
      };
    }
    const letMatch = stmt.match(/^\s*let\s+(mut\s+)?(\w+)\s*=\s*ctx\.bumps\.(\w+)/);
    if (letMatch?.[2] && letMatch[3]) {
      return {
        kind: "bumps_access",
        account: letMatch[3],
        localVar: letMatch[2],
      };
    }
    // Fallback: pass through but flag
    return { kind: "pass_through", code: stmt, needsReview: true, reviewReason: "ctx.bumps access pattern not recognized" };
  }

  // ── require!() macro ──
  const requireMatch = stmt.match(/^\s*require!\s*\(\s*(.+?)\s*,\s*(\w+(?:::\w+)?)\s*\)\s*$/s);
  if (requireMatch?.[1] && requireMatch[2]) {
    return { kind: "require", condition: requireMatch[1], error: requireMatch[2] };
  }

  // ── msg!() macro ──
  const msgMatch = stmt.match(/^\s*msg!\s*\(\s*(.+)\s*\)\s*$/s);
  if (msgMatch?.[1]) {
    return { kind: "msg", message: msgMatch[1] };
  }

  // ── emit!() macro ──
  const emitMatch = stmt.match(/^\s*emit!\s*\(\s*(\w+)\s*\{(.+)\}\s*\)\s*$/s);
  if (emitMatch?.[1] && emitMatch[2]) {
    return { kind: "emit", event: emitMatch[1], fields: emitMatch[2].trim() };
  }

  // ── Clock::get() sysvar access ──
  if (stmt.includes("Clock::get()")) {
    const clockLetMatch = stmt.match(/^\s*let\s+(mut\s+)?(\w+)\s*=\s*(.+)$/s);
    return {
      kind: "sysvar_clock",
      localVar: clockLetMatch?.[2] ?? "_clock",
      code: stmt,
    };
  }

  // ── Rent::get() sysvar access ──
  if (stmt.includes("Rent::get()")) {
    const rentLetMatch = stmt.match(/^\s*let\s+(mut\s+)?(\w+)\s*=\s*(.+)$/s);
    return {
      kind: "sysvar_rent",
      localVar: rentLetMatch?.[2] ?? "_rent",
      code: stmt,
    };
  }

  // ── State field assignment: account.field = expr ──
  // Matches: pool.total_deposited = pool.total_deposited.checked_add(amount)...
  //          counter.authority = ctx.accounts.authority.key()
  //          counter.count = 0
  //          vault_state.total_deposited = 0
  const stateAssignMatch = stmt.match(/^\s*(\w+)\.(\w+)\s*=\s*(.+)$/s);
  if (stateAssignMatch?.[1] && stateAssignMatch[2] && stateAssignMatch[3] && !stmt.includes("ctx.")) {
    const account = stateAssignMatch[1];
    const field = stateAssignMatch[2];
    const value = stateAssignMatch[3].trim();
    if (isLikelyStateVar(account)) {
      return { kind: "state_field_assign", account, field, value };
    }
  }

  // ── State field assignment with ctx prefix ──
  // account.field = ctx.accounts.X.key()
  const stateAssignCtxMatch = stmt.match(
    /^\s*(\w+)\.(\w+)\s*=\s*ctx\.accounts\.(\w+)\.key\(\)\s*$/
  );
  if (stateAssignCtxMatch?.[1] && stateAssignCtxMatch[2] && stateAssignCtxMatch[3]) {
    return {
      kind: "state_field_assign",
      account: stateAssignCtxMatch[1],
      field: stateAssignCtxMatch[2],
      value: `*${stateAssignCtxMatch[3]}.key()`,
    };
  }

  // ── Inline CPI call — anchor_spl::token::transfer(CpiContext::new(...), amount)? ──
  // This is the common Anchor pattern where CpiContext is constructed inline
  const inlineCpi = detectInlineCpiCall(stmt);
  if (inlineCpi) {
    return inlineCpi;
  }

  // ── Standalone CPI call (single statement, no separate CpiContext setup) ──
  // anchor_lang::system_program::transfer(cpi_ctx, amount)?
  // anchor_spl::token::transfer(cpi_ctx, amount)?
  const standaloneCpi = detectStandaloneCpiCall(stmt);
  if (standaloneCpi) {
    return standaloneCpi;
  }

  // ── Default: PASS-THROUGH ──
  // This is the catch-all. Pure Rust code that doesn't need framework transformation.
  // Flag if it looks like it might contain framework-specific patterns we missed.
  const needsReview = mightContainAnchorPattern(stmt);
  return {
    kind: "pass_through",
    code: stmt,
    needsReview,
    reviewReason: needsReview ? "Contains possible Anchor-specific pattern — verify after transformation" : undefined,
  };
}

// ─── Multi-statement CPI grouping ────────────────────────────────────────────

interface GroupResult {
  statement: BodyStatement;
  nextIndex: number;
}

/**
 * Try to detect and group a CPI pattern spanning 2+ statements:
 *   Statement 1: let cpi_ctx = CpiContext::new(...) or CpiContext::new_with_signer(...)
 *   Statement 2: some_function(cpi_ctx, args)?
 */
function tryCpiGroup(statements: string[], index: number): GroupResult | null {
  const stmt = statements[index]?.trim() ?? "";

  // Check if this statement sets up a CpiContext
  if (!stmt.includes("CpiContext::new")) return null;

  const setupMatch = stmt.match(
    /^\s*let\s+(mut\s+)?(\w+)\s*=\s*CpiContext::(new|new_with_signer)\s*\(/
  );
  if (!setupMatch?.[2] || !setupMatch[3]) return null;

  const ctxVarName = setupMatch[2];
  const withSigner = setupMatch[3] === "new_with_signer";

  // Look at the next statement for the CPI invocation
  if (index + 1 >= statements.length) return null;
  const nextStmt = statements[index + 1]?.trim() ?? "";

  // Check if next statement uses the CPI context variable
  if (!nextStmt.includes(ctxVarName)) return null;

  // Combine both statements and detect the CPI type
  const combined = stmt + ";\n" + nextStmt;
  const cpiDetection = detectCpi(combined);
  if (cpiDetection) {
    return {
      statement: cpiDetectionToBodyStatement(cpiDetection, withSigner ? extractSignerSeeds(statements, index) : undefined),
      nextIndex: index + 2,
    };
  }

  // If we can't parse the CPI details, treat the whole thing as a custom CPI
  return {
    statement: {
      kind: "cpi_custom",
      programAccount: "unknown",
      rawCode: combined,
      signerSeeds: withSigner ? extractSignerSeeds(statements, index) : undefined,
      needsReview: true,
    },
    nextIndex: index + 2,
  };
}

/**
 * Try to detect PDA signer seeds definitions:
 *   let seeds = &[b"prefix", authority.as_ref(), &[bump]];
 *   let signer_seeds = &[&seeds[..]];
 */
function tryPdaSignerSeeds(statements: string[], index: number): GroupResult | null {
  const stmt = statements[index]?.trim() ?? "";

  const seedsMatch = stmt.match(
    /^\s*let\s+(\w+)\s*=\s*&\s*\[(.+)\]\s*$/s
  );
  if (!seedsMatch?.[1] || !seedsMatch[2]) return null;
  const varName = seedsMatch[1];
  if (varName !== "seeds" && !varName.endsWith("_seeds")) return null;

  // Parse individual seeds
  const seedsStr = seedsMatch[2];
  const seeds = parseSeedsList(seedsStr);

  // Check if next statement is signer_seeds
  let nextIndex = index + 1;
  if (nextIndex < statements.length) {
    const nextStmt = statements[nextIndex]?.trim() ?? "";
    if (nextStmt.includes("signer_seeds") || nextStmt.includes("signer_seed")) {
      nextIndex++;
    }
  }

  // Extract bump field if present
  const bumpField = seeds.find(s => s.startsWith("&["))?.replace(/&\[|\]/g, "").trim();

  return {
    statement: {
      kind: "pda_signer_seeds",
      account: extractAccountFromSeeds(seedsStr),
      seeds,
      bumpField,
      rawCode: statements.slice(index, nextIndex).join(";\n"),
    },
    nextIndex,
  };
}

// ─── CPI detection helpers ───────────────────────────────────────────────────

function cpiDetectionToBodyStatement(cpi: CpiDetection, signerSeeds?: string): BodyStatement {
  switch (cpi.kind) {
    case "system_transfer":
      return {
        kind: "cpi_system_transfer",
        from: cpi.from,
        to: cpi.to,
        amount: cpi.amount,
        signerSeeds,
      };
    case "spl_transfer":
      return {
        kind: "cpi_spl_transfer",
        from: cpi.from,
        to: cpi.to,
        authority: cpi.authority,
        amount: cpi.amount,
        signerSeeds,
      };
    case "spl_mint_to":
      return {
        kind: "cpi_spl_mint_to",
        mint: cpi.mint,
        to: cpi.to,
        authority: cpi.authority,
        amount: cpi.amount,
        signerSeeds,
      };
    case "spl_burn":
      return {
        kind: "cpi_spl_burn",
        from: cpi.from,
        mint: cpi.mint,
        authority: cpi.authority,
        amount: cpi.amount,
        signerSeeds,
      };
    case "spl_close_account":
      return {
        kind: "cpi_spl_close_account",
        account: cpi.account,
        destination: cpi.destination,
        authority: cpi.authority,
        signerSeeds,
      };
    case "custom":
      return {
        kind: "cpi_custom",
        programAccount: cpi.program,
        rawCode: cpi.rawCode,
        signerSeeds,
        needsReview: true,
      };
  }
}

function detectStandaloneCpiCall(stmt: string): BodyStatement | null {
  // anchor_lang::system_program::transfer(ctx, amount)?
  const sysTransferMatch = stmt.match(
    /anchor_lang::system_program::transfer\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\?/
  );
  if (sysTransferMatch?.[2]) {
    return {
      kind: "cpi_system_transfer",
      from: "from",
      to: "to",
      amount: sysTransferMatch[2],
    };
  }

  // anchor_spl::token::transfer(ctx, amount)?
  const splTransferMatch = stmt.match(
    /(?:anchor_spl::)?token::transfer\s*\(\s*(\w+)\s*,\s*(.+?)\s*\)\s*\?/
  );
  if (splTransferMatch?.[2]) {
    return {
      kind: "cpi_spl_transfer",
      from: "from",
      to: "to",
      authority: "authority",
      amount: splTransferMatch[2],
    };
  }

  return null;
}

/**
 * Detect inline CPI calls where CpiContext is constructed inside the function call.
 * This handles the common Anchor pattern:
 *   anchor_spl::token::transfer(
 *       CpiContext::new(program, Transfer { from, to, authority }),
 *       amount,
 *   )?
 * Also handles CpiContext::new_with_signer(...).
 */
function detectInlineCpiCall(stmt: string): BodyStatement | null {
  const normalized = stmt.replace(/\s+/g, " ").trim();

  // ── SPL token::transfer with inline CpiContext ──
  if (
    (normalized.includes("token::transfer") || normalized.includes("token::Transfer")) &&
    normalized.includes("CpiContext::")
  ) {
    const withSigner = normalized.includes("CpiContext::new_with_signer");

    // Extract Transfer struct fields
    const fromMatch = stmt.match(
      /from\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const toMatch = stmt.match(
      /to\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const authMatch = stmt.match(
      /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );

    // Extract amount — it's the last argument before the closing )?;
    // Pattern: ), <amount>, )?
    const amountMatch = stmt.match(
      /\}\s*,?\s*\)\s*,?\s*(.+?)\s*,?\s*\)\s*\?/s
    );

    // Clean up the amount — remove signer_seeds arg if present
    let amount = amountMatch?.[1]?.trim() ?? "amount";
    // If `new_with_signer`, the pattern includes signer_seeds between the struct close and amount
    // Re-extract: for new_with_signer, pattern is:
    //   CpiContext::new_with_signer(program, Transfer{...}, signer_seeds), amount)?
    if (withSigner) {
      const signedAmountMatch = stmt.match(
        /signer_seeds\s*,?\s*\)\s*,\s*(.+?)\s*,?\s*\)\s*\?/s
      );
      if (signedAmountMatch?.[1]) {
        amount = signedAmountMatch[1].trim();
      }
    }

    // Clean ctx.accounts prefix from amount expression
    amount = amount.replace(/ctx\.accounts\./g, "");

    return {
      kind: "cpi_spl_transfer",
      from: fromMatch?.[1] ?? "from",
      to: toMatch?.[1] ?? "to",
      authority: authMatch?.[1] ?? "authority",
      amount,
      signerSeeds: withSigner ? "signer_seeds" : undefined,
    };
  }

  // ── SPL token::mint_to with inline CpiContext ──
  if (
    (normalized.includes("token::mint_to") || normalized.includes("MintTo")) &&
    normalized.includes("CpiContext::")
  ) {
    const withSigner = normalized.includes("CpiContext::new_with_signer");
    const mintMatch = stmt.match(
      /mint\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const toMatch = stmt.match(
      /to\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const authMatch = stmt.match(
      /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const amountMatch = stmt.match(
      /\}\s*,?\s*\)\s*,?\s*(.+?)\s*,?\s*\)\s*\?/s
    );
    let amount = amountMatch?.[1]?.trim().replace(/ctx\.accounts\./g, "") ?? "amount";

    return {
      kind: "cpi_spl_mint_to",
      mint: mintMatch?.[1] ?? "mint",
      to: toMatch?.[1] ?? "to",
      authority: authMatch?.[1] ?? "authority",
      amount,
      signerSeeds: withSigner ? "signer_seeds" : undefined,
    };
  }

  // ── SPL token::burn with inline CpiContext ──
  if (
    (normalized.includes("token::burn") || normalized.includes("Burn")) &&
    normalized.includes("CpiContext::")
  ) {
    const withSigner = normalized.includes("CpiContext::new_with_signer");
    const fromMatch = stmt.match(
      /from\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const mintMatch = stmt.match(
      /mint\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const authMatch = stmt.match(
      /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const amountMatch = stmt.match(
      /\}\s*,?\s*\)\s*,?\s*(.+?)\s*,?\s*\)\s*\?/s
    );
    let amount = amountMatch?.[1]?.trim().replace(/ctx\.accounts\./g, "") ?? "amount";

    return {
      kind: "cpi_spl_burn",
      from: fromMatch?.[1] ?? "from",
      mint: mintMatch?.[1] ?? "mint",
      authority: authMatch?.[1] ?? "authority",
      amount,
      signerSeeds: withSigner ? "signer_seeds" : undefined,
    };
  }

  // ── SPL token::close_account with inline CpiContext ──
  if (
    (normalized.includes("close_account") || normalized.includes("CloseAccount")) &&
    normalized.includes("CpiContext::")
  ) {
    const withSigner = normalized.includes("CpiContext::new_with_signer");
    const accountMatch = stmt.match(
      /account\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const destMatch = stmt.match(
      /destination\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const authMatch = stmt.match(
      /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );

    return {
      kind: "cpi_spl_close_account",
      account: accountMatch?.[1] ?? "account",
      destination: destMatch?.[1] ?? "destination",
      authority: authMatch?.[1] ?? "authority",
      signerSeeds: withSigner ? "signer_seeds" : undefined,
    };
  }

  // ── System program transfer with inline CpiContext ──
  if (
    (normalized.includes("system_program::transfer") || normalized.includes("system_program::Transfer")) &&
    normalized.includes("CpiContext::")
  ) {
    const withSigner = normalized.includes("CpiContext::new_with_signer");
    const fromMatch = stmt.match(
      /from\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const toMatch = stmt.match(
      /to\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
    );
    const amountMatch = stmt.match(
      /\}\s*,?\s*\)\s*,?\s*(.+?)\s*,?\s*\)\s*\?/s
    );
    let amount = amountMatch?.[1]?.trim().replace(/ctx\.accounts\./g, "") ?? "amount";

    return {
      kind: "cpi_system_transfer",
      from: fromMatch?.[1] ?? "from",
      to: toMatch?.[1] ?? "to",
      amount,
      signerSeeds: withSigner ? "signer_seeds" : undefined,
    };
  }

  return null;
}

// ─── Utility functions ───────────────────────────────────────────────────────

function stripOuterBraces(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isLifetimeOrCharContext(source: string, idx: number): boolean {
  // In Rust, ' can be a lifetime ('a, 'info) or a char literal ('x')
  // Look ahead: if the next chars are a letter followed by non-alphanum, it's a lifetime
  const ahead = source.slice(idx + 1, idx + 10);
  if (/^[a-z_]\w*/.test(ahead)) return true; // lifetime
  return false;
}

function isLikelyStateVar(name: string): boolean {
  // Filter out common non-state-var patterns
  const nonState = new Set(["self", "data", "offset", "result", "buf", "bytes", "len", "idx"]);
  if (nonState.has(name)) return false;
  // State vars are typically snake_case nouns
  return /^[a-z][a-z0-9_]*$/.test(name);
}

function mightContainAnchorPattern(stmt: string): boolean {
  // Check for patterns that suggest framework-specific code we might have missed
  return (
    stmt.includes("ctx.accounts") ||
    stmt.includes("ctx.bumps") ||
    stmt.includes("CpiContext") ||
    stmt.includes("anchor_lang::") ||
    stmt.includes("anchor_spl::") ||
    stmt.includes(".to_account_info()") ||
    /\brequire!\s*\(/.test(stmt) ||
    /\bemit!\s*\(/.test(stmt)
  );
}

function extractSignerSeeds(statements: string[], beforeIndex: number): string | undefined {
  // Look backwards from the CPI setup to find signer_seeds definition
  for (let i = beforeIndex - 1; i >= Math.max(0, beforeIndex - 5); i--) {
    const s = statements[i]?.trim() ?? "";
    if (s.includes("signer_seeds") || s.includes("signer_seed")) {
      return s;
    }
  }
  return undefined;
}

function parseSeedsList(seedsStr: string): string[] {
  // Parse seed expressions from: b"prefix", authority.as_ref(), &escrow.seed.to_le_bytes(), &[bump]
  const seeds: string[] = [];
  let current = "";
  let depth = 0;

  for (const ch of seedsStr) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;

    if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) seeds.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const remaining = current.trim();
  if (remaining) seeds.push(remaining);

  return seeds;
}

function extractAccountFromSeeds(seedsStr: string): string {
  // Try to extract which account the seeds belong to from the seed contents
  // e.g. b"escrow", maker.as_ref() → "escrow"
  const prefixMatch = seedsStr.match(/b"(\w+)"/);
  return prefixMatch?.[1] ?? "unknown";
}
