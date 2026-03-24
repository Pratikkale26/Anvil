import { type Instruction, type AccountRef, type Arg } from "../ir/schema.js";
import {
  stripComments,
  extractBlock,
  extractAttributes,
  splitConstraintTokens,
  findMatchingClose,
  normalizeSolanaType,
} from "./utils.js";
import { parseConstraints } from "./constraint-parser.js";

/**
 * Parse all instructions from the `#[program]` module block.
 */
export function parseInstructions(source: string): Instruction[] {
  const cleaned = stripComments(source);

  // Find the #[program] mod block
  const programBlocks = extractBlock(cleaned, /#\[program\]\s*pub\s+mod\s+\w+/g);
  if (programBlocks.length === 0) return [];

  const programBody = programBlocks[0].block;
  const instructions: Instruction[] = [];

  // Each pub fn inside the program mod is an instruction
  const fnBlocks = extractBlock(programBody, /pub\s+fn\s+(\w+)\s*\(/g, "{", "}");
  for (const { match, block, startIdx } of fnBlocks) {
    const fnName = match[1];

    // Get full signature: text between the fn name and opening brace
    const fnStart = programBody.indexOf(match[0]);
    const sigStart = fnStart + match[0].length - 1; // just before the open paren
    const openParen = programBody.indexOf("(", fnStart);
    const closeParen = findMatchingClose(programBody, openParen, "(", ")");
    if (openParen === -1 || closeParen === -1) continue;

    const fullSig = programBody.slice(openParen + 1, closeParen);

    // Parse accounts and args from signature
    const { accounts, args } = parseSignature(fullSig, fnName, cleaned);

    instructions.push({ name: fnName, accounts, args });
  }

  return instructions;
}

/**
 * Parse the function signature to extract:
 * - The Context<T> type (used to look up accounts)
 * - The remaining args (name: type pairs)
 *
 * Then cross-reference the Context type with #[derive(Accounts)] structs.
 */
function parseSignature(
  sig: string,
  fnName: string,
  fullSource: string
): { accounts: AccountRef[]; args: Arg[] } {
  const params = sig.split(",").map((s) => s.trim()).filter(Boolean);

  let contextType = "";
  const args: Arg[] = [];

  for (const param of params) {
    // Skip `ctx: Context<T>` — extract T
    const ctxMatch = param.match(/ctx\s*:\s*Context\s*<\s*(\w+)\s*>/);
    if (ctxMatch) {
      contextType = ctxMatch[1];
      continue;
    }
    // Skip lifetime params and _ctx
    if (param.startsWith("'") || param.startsWith("_")) continue;

    // Parse `name: type`
    const colonIdx = param.indexOf(":");
    if (colonIdx === -1) continue;
    const name = param.slice(0, colonIdx).trim().replace(/^pub\s+/, "");
    const rawType = param.slice(colonIdx + 1).trim();
    if (!name || !rawType) continue;

    args.push({ name, type: normalizeSolanaType(rawType) });
  }

  // Look up the Accounts context struct
  const accounts = contextType
    ? parseAccountsStruct(contextType, fullSource)
    : [];

  return { accounts, args };
}

/**
 * Find the `#[derive(Accounts)] pub struct Name<'info>` block and
 * parse each field into an AccountRef.
 */
function parseAccountsStruct(structName: string, source: string): AccountRef[] {
  const accounts: AccountRef[] = [];

  // Find the struct block
  const re = new RegExp(`pub\\s+struct\\s+${structName}\\s*(?:<[^>]*>)?\\s*\\{`, "g");
  const structStart = re.exec(source);
  if (!structStart) return [];

  const openIdx = source.indexOf("{", structStart.index + structStart[0].length - 1);
  if (openIdx === -1) return [];
  const closeIdx = findMatchingClose(source, openIdx, "{", "}");
  if (closeIdx === -1) return [];

  const structBody = source.slice(openIdx + 1, closeIdx);

  // Split struct body into per-field chunks.
  // Each field may have several #[...] attributes before it.
  // Strategy: find each `pub fieldName:` and grab everything before it (attrs) + after it (type).
  const fieldRe = /pub\s+(\w+)\s*:\s*([\w<>',:!\s]+?)(?=\s*,\s*(?:\/\/[^\n]*\n)?\s*(?:#\[|pub\s|\})|\s*\})/g;
  let m: RegExpExecArray | null;

  while ((m = fieldRe.exec(structBody)) !== null) {
    const fieldName = m[1];
    const rawType = m[2].trim().replace(/,$/, "");

    // Determine the account type
    const accountType = extractAccountType(rawType);

    // Grab attributes that appear BEFORE this field in structBody
    const beforeField = structBody.slice(0, m.index);
    const fieldAttrs = extractAttributes(beforeField);

    // The LAST #[account(...)] before this field is the one for this field
    const accountAttr = [...fieldAttrs]
      .reverse()
      .find((a) => a.startsWith("account(") || a === "account");

    let isSigner = false;
    let isMut = false;
    let isInit = false;
    let constraints: ReturnType<typeof parseConstraints> = [];

    if (accountAttr) {
      // strip "account(" prefix and trailing ")"
      const inner = accountAttr.replace(/^account\s*\(\s*/, "").replace(/\s*\)$/, "");
      constraints = parseConstraints(inner);
      isMut  = constraints.some((c) => c.kind === "mut" || c.kind === "init" || c.kind === "init_if_needed");
      isInit = constraints.some((c) => c.kind === "init" || c.kind === "init_if_needed");
    }

    // Determine signer from type name
    if (rawType.includes("Signer")) isSigner = true;

    accounts.push({
      name: fieldName,
      accountType,
      isSigner,
      isMut,
      isInit,
      constraints,
    });
  }

  return accounts;
}

/** Extract the bare account type from Account<'info, T>, Program<'info, T>, etc. */
function extractAccountType(rawType: string): string {
  const t = rawType.trim();
  // Account<'info, T> -> T
  const accountMatch = t.match(/^Account\s*<\s*'info\s*,\s*(\w+)\s*>/);
  if (accountMatch) return accountMatch[1];
  // Program<'info, T> -> T
  const programMatch = t.match(/^Program\s*<\s*'info\s*,\s*(\w+)\s*>/);
  if (programMatch) return programMatch[1];
  // Signer<'info>
  if (t.startsWith("Signer")) return "Signer";
  // SystemAccount<'info>
  if (t.startsWith("SystemAccount")) return "SystemAccount";
  // UncheckedAccount<'info>
  if (t.startsWith("UncheckedAccount")) return "UncheckedAccount";
  return t;
}
