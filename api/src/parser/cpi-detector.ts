/**
 * CPI Detector — AST-based CPI Pattern Recognition
 *
 * Detects all standard Anchor CPI patterns by walking tree-sitter AST nodes.
 * Handles both inline CpiContext and separate variable CPI patterns.
 *
 * Supported CPI kinds:
 *   - SPL Token transfer (token::transfer)
 *   - SPL Token mint_to (token::mint_to)
 *   - SPL Token burn (token::burn)
 *   - SPL Token close_account (token::close_account)
 *   - System program transfer (system_program::transfer)
 *   - Custom CPI (invoke / invoke_signed)
 */

import type { SyntaxNode } from "./ts-init.js";
import type { BodyStatement } from "../ir/schema.js";
import {
  findDescendant,
  findCtxAccountsAccess,
  extractStructField,
  getArguments,
  cleanAccountRef,
  cleanAmountExpr,
} from "./ast-helpers.js";

/**
 * Try to detect a CPI call in an expression node.
 * Returns a classified BodyStatement if it's a known CPI, or null.
 *
 * Works on both call_expression and try_expression nodes.
 */
export function detectCpi(node: SyntaxNode): BodyStatement | null {
  // Unwrap try_expression (expr?) to get the inner call
  let callNode = node;
  if (callNode.type === "try_expression") {
    const inner = callNode.namedChild(0);
    if (inner) callNode = inner;
  }

  if (callNode.type !== "call_expression") return null;

  const funcNode = callNode.childForFieldName("function");
  if (!funcNode) return null;

  const funcText = funcNode.text;

  // ── Token-2022 / token_interface CPI patterns ──
  // These mirror token::* but use the Token-2022 program
  if (funcText.includes("token_2022::") || funcText.includes("token_interface::")) {
    if (funcText.includes("transfer_checked") || funcText.includes("transfer")) {
      const result = extractSplTransfer(callNode);
      if (result.kind === "cpi_spl_transfer") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("mint_to")) {
      const result = extractSplMintTo(callNode);
      if (result.kind === "cpi_spl_mint_to") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("burn")) {
      const result = extractSplBurn(callNode);
      if (result.kind === "cpi_spl_burn") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("close_account") || funcText.includes("CloseAccount")) {
      const result = extractSplCloseAccount(callNode);
      if (result.kind === "cpi_spl_close_account") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
  }

  // ── SPL Token transfer ──
  if (funcText.includes("token::transfer") || funcText.includes("token::Transfer")) {
    return extractSplTransfer(callNode);
  }

  // ── SPL Token mint_to ──
  if (funcText.includes("token::mint_to") || funcText.includes("token::MintTo")) {
    return extractSplMintTo(callNode);
  }

  // ── SPL Token burn ──
  if (funcText.includes("token::burn") || funcText.includes("token::Burn")) {
    return extractSplBurn(callNode);
  }

  // ── Unqualified _checked variants (post-consolidation) ──
  // After CpiContext consolidation collapses
  // `let cpi_ctx = CpiContext::new(prog, TransferChecked { ... });
  //  transfer_checked(cpi_ctx, amount, decimals)?;`
  // into a single call, the namespace prefix (`token_interface::`) is gone.
  // The `_checked` suffix is reserved for Token-2022 (Anchor exposes the
  // same names under `token::` for legacy SPL-Token, but in practice these
  // arrive via `token_interface` and are routed to Token-2022 at runtime),
  // so we infer tokenProgram = "token_2022".
  if (/^transfer_checked$|::transfer_checked$/.test(funcText)) {
    const result = extractSplTransfer(callNode);
    if (result.kind === "cpi_spl_transfer") {
      return { ...result, tokenProgram: "token_2022" as const };
    }
    return result;
  }
  if (/^mint_to_checked$|::mint_to_checked$/.test(funcText)) {
    const result = extractSplMintTo(callNode);
    if (result.kind === "cpi_spl_mint_to") {
      return { ...result, tokenProgram: "token_2022" as const };
    }
    return result;
  }
  if (/^burn_checked$|::burn_checked$/.test(funcText)) {
    const result = extractSplBurn(callNode);
    if (result.kind === "cpi_spl_burn") {
      return { ...result, tokenProgram: "token_2022" as const };
    }
    return result;
  }

  // ── SPL Token close_account ──
  if (funcText.includes("close_account") || funcText.includes("CloseAccount")) {
    return extractSplCloseAccount(callNode);
  }

  // ── Associated Token Account create ──
  // anchor_spl: associated_token::create(...)
  // struct path: AssociatedToken::create(...)
  // raw native: spl_associated_token_account::instruction::create_associated_token_account(...)
  if (
    funcText.includes("associated_token::create") ||
    funcText.includes("AssociatedToken::create") ||
    funcText.includes("create_associated_token_account")
  ) {
    return extractAtaCreate(callNode);
  }

  // ── System program transfer ──
  if (funcText.includes("system_program::transfer") || funcText.includes("system_instruction::transfer")) {
    return extractSystemTransfer(callNode);
  }

  // ── SPL Memo CPI ──
  // Common forms:
  //   spl_memo::build_memo(memo_bytes, &[signer])
  //   solana_program::memo::build_memo(...)
  //   anchor_spl::memo::Memo { ... }   (less common)
  // The interesting payload is the first argument (the memo data); signer
  // accounts are optional and tracked separately when present.
  if (
    funcText.includes("spl_memo::") ||
    funcText.includes("memo::build_memo") ||
    funcText === "build_memo"
  ) {
    return extractMemoCpi(callNode);
  }

  // ── Generic invoke / invoke_signed ──
  if (funcText === "invoke" || funcText === "invoke_signed") {
    return extractCustomCpi(callNode);
  }

  return null;
}

function extractMemoCpi(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);
  const args = getArguments(argsNode);
  // build_memo(data, signers): data is arg[0]; signers (slice) is arg[1].
  // We carry data as its raw expression text — the emitter quotes/passes
  // through depending on shape (string literal vs slice expr vs Vec<u8>).
  const data = args[0]?.text.trim() ?? "&[]";
  return {
    kind: "cpi_memo",
    data,
  };
}

// ─── SPL Token Transfer ─────────────────────────────────────────────────────

function extractSplTransfer(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);

  const args = getArguments(argsNode);
  const firstArg = args[0];
  const lastArg = args[args.length - 1];

  let from = "from";
  let to = "to";
  let authority = "authority";
  let mint: string | undefined;
  let amount = "amount";
  let decimals: string | undefined;
  let signerSeeds: string | undefined;

  // Detect the checked variant by looking at the function path. Token-2022's
  // `transfer_checked(ctx, amount, decimals)` / Anchor's
  // `token::transfer_checked(...)` both carry the mint inside the
  // TransferChecked struct + decimals as the trailing arg.
  const funcNode = callNode.childForFieldName("function");
  const isChecked = !!funcNode && funcNode.text.includes("transfer_checked");

  // Check if first arg contains CpiContext::new (inline CPI)
  if (firstArg && firstArg.text.includes("CpiContext::")) {
    const transferStruct = findDescendant(firstArg, "struct_expression");
    if (transferStruct) {
      from = extractStructField(transferStruct, "from") ?? "from";
      to = extractStructField(transferStruct, "to") ?? "to";
      authority = extractStructField(transferStruct, "authority") ?? "authority";
      const maybeMint = extractStructField(transferStruct, "mint");
      if (maybeMint) mint = cleanAccountRef(maybeMint);
    }
    signerSeeds = firstArg.text.includes("new_with_signer") ? extractSignerSeedsExpr(firstArg.text) : undefined;
  } else if (firstArg) {
    signerSeeds = undefined; // TODO: could trace variable
  }

  if (isChecked && args.length >= 3) {
    // transfer_checked(ctx, amount, decimals)
    amount = cleanAmountExpr(args[args.length - 2]!.text);
    decimals = cleanAmountExpr(lastArg!.text);
  } else if (lastArg && lastArg !== firstArg) {
    amount = cleanAmountExpr(lastArg.text);
  }

  return {
    kind: "cpi_spl_transfer",
    from: cleanAccountRef(from),
    to: cleanAccountRef(to),
    authority: cleanAccountRef(authority),
    amount,
    signerSeeds,
    ...(mint ? { mint } : {}),
    ...(decimals ? { decimals } : {}),
  };
}

// ─── SPL Token Mint To ──────────────────────────────────────────────────────

function extractSplMintTo(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);

  const args = getArguments(argsNode);
  const firstArg = args[0];
  const lastArg = args[args.length - 1];

  let mint = "mint";
  let to = "to";
  let authority = "authority";
  let amount = "amount";
  let decimals: string | undefined;
  let signerSeeds: string | undefined;

  const funcNode = callNode.childForFieldName("function");
  const isChecked = !!funcNode && funcNode.text.includes("mint_to_checked");

  if (firstArg && firstArg.text.includes("CpiContext::")) {
    const mintStruct = findDescendant(firstArg, "struct_expression");
    if (mintStruct) {
      mint = extractStructField(mintStruct, "mint") ?? "mint";
      to = extractStructField(mintStruct, "to") ?? "to";
      authority = extractStructField(mintStruct, "authority") ?? "authority";
    }
    signerSeeds = firstArg.text.includes("new_with_signer") ? extractSignerSeedsExpr(firstArg.text) : undefined;
  }

  if (isChecked && args.length >= 3) {
    amount = cleanAmountExpr(args[args.length - 2]!.text);
    decimals = cleanAmountExpr(lastArg!.text);
  } else if (lastArg && lastArg !== firstArg) {
    amount = cleanAmountExpr(lastArg.text);
  }

  return {
    kind: "cpi_spl_mint_to",
    mint: cleanAccountRef(mint),
    to: cleanAccountRef(to),
    authority: cleanAccountRef(authority),
    amount,
    signerSeeds,
    ...(decimals ? { decimals } : {}),
  };
}

// ─── SPL Token Burn ─────────────────────────────────────────────────────────

function extractSplBurn(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);

  const args = getArguments(argsNode);
  const firstArg = args[0];
  const lastArg = args[args.length - 1];

  let from = "from";
  let mint = "mint";
  let authority = "authority";
  let amount = "amount";
  let decimals: string | undefined;
  let signerSeeds: string | undefined;

  const funcNode = callNode.childForFieldName("function");
  const isChecked = !!funcNode && funcNode.text.includes("burn_checked");

  if (firstArg && firstArg.text.includes("CpiContext::")) {
    const burnStruct = findDescendant(firstArg, "struct_expression");
    if (burnStruct) {
      from = extractStructField(burnStruct, "from") ?? "from";
      mint = extractStructField(burnStruct, "mint") ?? "mint";
      authority = extractStructField(burnStruct, "authority") ?? "authority";
    }
    signerSeeds = firstArg.text.includes("new_with_signer") ? extractSignerSeedsExpr(firstArg.text) : undefined;
  }

  if (isChecked && args.length >= 3) {
    amount = cleanAmountExpr(args[args.length - 2]!.text);
    decimals = cleanAmountExpr(lastArg!.text);
  } else if (lastArg && lastArg !== firstArg) {
    amount = cleanAmountExpr(lastArg.text);
  }

  return {
    kind: "cpi_spl_burn",
    from: cleanAccountRef(from),
    mint: cleanAccountRef(mint),
    authority: cleanAccountRef(authority),
    amount,
    signerSeeds,
    ...(decimals ? { decimals } : {}),
  };
}

// ─── SPL Token Close Account ────────────────────────────────────────────────

function extractSplCloseAccount(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);

  const args = getArguments(argsNode);
  const firstArg = args[0];

  let account = "account";
  let destination = "destination";
  let authority = "authority";
  let signerSeeds: string | undefined;

  if (firstArg && firstArg.text.includes("CpiContext::")) {
    const closeStruct = findDescendant(firstArg, "struct_expression");
    if (closeStruct) {
      account = extractStructField(closeStruct, "account") ?? "account";
      destination = extractStructField(closeStruct, "destination") ?? "destination";
      authority = extractStructField(closeStruct, "authority") ?? "authority";
    }
    signerSeeds = firstArg.text.includes("new_with_signer") ? extractSignerSeedsExpr(firstArg.text) : undefined;
  }

  return {
    kind: "cpi_spl_close_account",
    account: cleanAccountRef(account),
    destination: cleanAccountRef(destination),
    authority: cleanAccountRef(authority),
    signerSeeds,
  };
}

// ─── Associated Token Account Create ────────────────────────────────────────

function extractAtaCreate(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);

  const args = getArguments(argsNode);
  const firstArg = args[0];

  let ata = "associated_token";
  let payer = "payer";
  let mint = "mint";
  let authority = "authority";
  let signerSeeds: string | undefined;

  if (firstArg && firstArg.text.includes("CpiContext::")) {
    const createStruct = findDescendant(firstArg, "struct_expression");
    if (createStruct) {
      ata = extractStructField(createStruct, "associated_token") ?? ata;
      payer = extractStructField(createStruct, "payer") ?? payer;
      mint = extractStructField(createStruct, "mint") ?? mint;
      authority = extractStructField(createStruct, "authority") ?? authority;
    }
    signerSeeds = firstArg.text.includes("new_with_signer") ? extractSignerSeedsExpr(firstArg.text) : undefined;
  } else {
    // Raw native call: create_associated_token_account(payer, owner, mint, token_program)
    // — positional args, no Create struct to extract from. Bail to pass-through so
    // the user sees the original call rather than a broken stub.
    return fallbackPassThrough(callNode);
  }

  return {
    kind: "cpi_ata_create",
    ata: cleanAccountRef(ata),
    payer: cleanAccountRef(payer),
    mint: cleanAccountRef(mint),
    authority: cleanAccountRef(authority),
    signerSeeds,
  };
}

// ─── System Program Transfer ────────────────────────────────────────────────

function extractSystemTransfer(callNode: SyntaxNode): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return fallbackPassThrough(callNode);

  const args = getArguments(argsNode);
  const firstArg = args[0];
  const lastArg = args[args.length - 1];

  let from = "from";
  let to = "to";
  let amount = "amount";
  let signerSeeds: string | undefined;

  if (firstArg && firstArg.text.includes("CpiContext::")) {
    const transferStruct = findDescendant(firstArg, "struct_expression");
    if (transferStruct) {
      from = extractStructField(transferStruct, "from") ?? "from";
      to = extractStructField(transferStruct, "to") ?? "to";
    }
    signerSeeds = firstArg.text.includes("new_with_signer") ? extractSignerSeedsExpr(firstArg.text) : undefined;
  } else if (args.length >= 2) {
    // system_program::transfer(cpi_ctx, amount) — ctx is first, amount is second
  }

  if (lastArg && lastArg !== firstArg) {
    amount = cleanAmountExpr(lastArg.text);
  }

  return {
    kind: "cpi_system_transfer",
    from: cleanAccountRef(from),
    to: cleanAccountRef(to),
    amount,
    signerSeeds,
  };
}

// ─── Custom CPI ─────────────────────────────────────────────────────────────

function extractCustomCpi(callNode: SyntaxNode): BodyStatement {
  const funcText = callNode.childForFieldName("function")?.text ?? "";
  const signerSeeds = funcText === "invoke_signed" ? "signer_seeds" : undefined;

  return {
    kind: "cpi_custom",
    programAccount: "unknown",
    rawCode: callNode.text,
    signerSeeds,
    needsReview: true,
  };
}

// ─── Fallback ───────────────────────────────────────────────────────────────

/**
 * Pull the actual third argument out of an inline
 * `CpiContext::new_with_signer(prog, accounts, SIGNERS)` expression. The
 * caller would otherwise hardcode `"signer_seeds"` and the body emitter
 * would generate its own `let signer_seeds = …` prelude — which is wrong
 * when the source already has its own `signers_seeds` local in scope (e.g.
 * the anchor-escrow PDA-signed pattern). When the third arg can't be
 * isolated cleanly, fall back to the legacy default.
 */
function extractSignerSeedsExpr(firstArgText: string): string {
  const idx = firstArgText.indexOf("new_with_signer(");
  if (idx === -1) return "signer_seeds";
  let depth = 0;
  const start = idx + "new_with_signer(".length;
  const args: number[] = [start];
  for (let i = start; i < firstArgText.length; i++) {
    const ch = firstArgText[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      if (depth === 0) {
        args.push(i);
        break;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(i + 1);
    }
  }
  if (args.length < 4) return "signer_seeds";
  const expr = firstArgText.slice(args[2]!, args[3]!).trim().replace(/,\s*$/, "");
  return expr.length > 0 ? expr : "signer_seeds";
}

function fallbackPassThrough(node: SyntaxNode): BodyStatement {
  return {
    kind: "pass_through",
    code: node.text,
    needsReview: true,
    reviewReason: "CPI pattern detected but could not extract details",
  };
}
