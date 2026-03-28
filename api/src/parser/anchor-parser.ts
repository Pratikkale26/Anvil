/**
 * Anchor Parser — Enhanced with Body Classification
 *
 * Parses raw Anchor .rs source files into a SolanaIR with classified
 * instruction bodies. Uses structure extraction (regex + brace matching)
 * for the program skeleton and the body classifier for instruction logic.
 *
 * The parser extracts:
 *   - Program name and ID
 *   - Instructions (name, signature, accounts, args, classified body)
 *   - Account data structs (#[account] structs)
 *   - Error enums (#[error_code])
 *   - Helper functions (non-instruction fns)
 *   - Custom types/structs
 *   - Import statements
 */

import { SolanaIRSchema, type SolanaIR, type AccountRef, type Arg, type HelperFn } from "../ir/schema.js";
import { stripComments, extractBlock, findMatchingClose, normalizeSolanaType } from "./utils.js";
import { parseConstraints } from "./constraint-parser.js";
import { classifyBody } from "./body-classifier.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ParseResult {
  ok: true;
  ir: SolanaIR;
}

export interface ParseError {
  ok: false;
  error: string;
  details?: string;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function parseAnchor(source: string): ParseResult | ParseError {
  try {
    const cleaned = stripComments(source);

    // ── Extract program name ──
    const nameMatch = cleaned.match(/#\[program\]\s*pub\s+mod\s+(\w+)/);
    const programName = nameMatch?.[1] ?? "unknown_program";

    // ── Extract programId from declare_id!("...") ──
    const idMatch = cleaned.match(/declare_id!\s*\(\s*"([^"]+)"\s*\)/);
    const programId = idMatch ? idMatch[1] : undefined;

    // ── Extract imports ──
    const imports = extractImports(cleaned);

    // ── Parse instructions (with body classification) ──
    const instructions = parseInstructionsWithBodies(source, cleaned);

    // ── Parse account data structs ──
    const accounts = parseAccountDefs(cleaned);

    // ── Parse errors ──
    const errors = parseErrors(cleaned);

    // ── Parse helper functions (outside #[program] mod) ──
    const helperFns = parseHelperFunctions(source, cleaned);

    // ── Parse custom types ──
    const types = parseCustomTypes(cleaned);

    const irRaw: SolanaIR = {
      name: programName,
      programId,
      instructions,
      accounts,
      types,
      errors,
      helperFns,
      imports,
      metadata: {
        sourceFramework: "anchor",
        sourceVersion: detectAnchorVersion(source),
        anvilVersion: "0.2.0",
        parsedAt: new Date().toISOString(),
      },
    };

    // Validate with Zod
    const result = SolanaIRSchema.safeParse(irRaw);
    if (!result.success) {
      return {
        ok: false,
        error: "IR validation failed",
        details: result.error.message,
      };
    }

    return { ok: true, ir: result.data };
  } catch (e) {
    return {
      ok: false,
      error: "Parse failed",
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Instruction parsing with body extraction ────────────────────────────────

function parseInstructionsWithBodies(
  rawSource: string,
  cleaned: string
): SolanaIR["instructions"] {
  // Find the #[program] mod block
  const programBlocks = extractBlock(cleaned, /#\[program\]\s*pub\s+mod\s+\w+/g);
  if (programBlocks.length === 0) return [];

  const firstBlock = programBlocks[0];
  if (!firstBlock) return [];

  const programBody = firstBlock.block;
  const programStart = cleaned.indexOf(firstBlock.match[0]);
  const programOpenBrace = cleaned.indexOf("{", programStart + firstBlock.match[0].length - 1);

  const instructions: SolanaIR["instructions"] = [];

  // Each pub fn inside the program mod is an instruction
  const fnPattern = /pub\s+fn\s+(\w+)\s*\(/g;
  let fnMatch: RegExpExecArray | null;

  while ((fnMatch = fnPattern.exec(programBody)) !== null) {
    const fnName = fnMatch[1];
    if (!fnName) continue;

    // ── Extract full signature ──
    const openParen = programBody.indexOf("(", fnMatch.index + fnMatch[0].length - 1);
    const closeParen = findMatchingClose(programBody, openParen, "(", ")");
    if (openParen === -1 || closeParen === -1) continue;

    const fullSig = programBody.slice(openParen + 1, closeParen);

    // ── Extract function body ──
    const bodyStart = programBody.indexOf("{", closeParen);
    if (bodyStart === -1) continue;
    const bodyEnd = findMatchingClose(programBody, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;

    const rawBody = programBody.slice(bodyStart, bodyEnd + 1); // including { }

    // ── Parse signature for Context<T> and args ──
    const { contextType, args } = parseSignature(fullSig);

    // ── Resolve accounts from the Context<T> struct ──
    const accounts = contextType
      ? parseAccountsStruct(contextType, cleaned)
      : [];

    // ── Classify the function body ──
    const body = classifyBody(rawBody);

    // ── Enrich state_read operations with account type from context struct ──
    for (const stmt of body) {
      if (stmt.kind === "state_read" && accounts.length > 0) {
        const matchingAccount = accounts.find(a => a.name === stmt.account);
        if (matchingAccount) {
          stmt.accountType = matchingAccount.accountType;
        }
      }
    }

    instructions.push({
      name: fnName,
      accounts,
      args,
      body,
      rawBody,
    });
  }

  return instructions;
}

// ─── Signature parsing ───────────────────────────────────────────────────────

function parseSignature(sig: string): {
  contextType: string;
  args: Arg[];
} {
  const params = sig.split(",").map((s) => s.trim()).filter(Boolean);

  let contextType = "";
  const args: Arg[] = [];

  for (const param of params) {
    // Skip ctx: Context<T> — extract T
    const ctxMatch = param.match(/ctx\s*:\s*Context\s*<\s*(\w+)\s*>/);
    if (ctxMatch?.[1]) {
      contextType = ctxMatch[1];
      continue;
    }
    // Skip lifetime params and _ctx
    if (param.startsWith("'") || param.startsWith("_")) continue;

    // Parse name: type
    const colonIdx = param.indexOf(":");
    if (colonIdx === -1) continue;
    const name = param.slice(0, colonIdx).trim().replace(/^pub\s+/, "");
    const rawType = param.slice(colonIdx + 1).trim();
    if (!name || !rawType) continue;

    args.push({ name, type: normalizeSolanaType(rawType) });
  }

  return { contextType, args };
}

// ─── Accounts struct parsing ─────────────────────────────────────────────────

function parseAccountsStruct(structName: string, source: string): AccountRef[] {
  const accounts: AccountRef[] = [];

  const re = new RegExp(`pub\\s+struct\\s+${structName}\\s*(?:<[^>]*>)?\\s*\\{`, "g");
  const structStart = re.exec(source);
  if (!structStart) return [];

  const openIdx = source.indexOf("{", structStart.index + structStart[0].length - 1);
  if (openIdx === -1) return [];
  const closeIdx = findMatchingClose(source, openIdx, "{", "}");
  if (closeIdx === -1) return [];

  const structBody = source.slice(openIdx + 1, closeIdx);

  // Split struct body into chunks per field using 'pub' as delimiter
  // Each chunk has attributes + pub name: Type,
  const chunks = structBody.split(/(?=\s*(?:#\[|pub\s))/);

  let currentAttrs: string[] = [];

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    // Collect attribute lines
    const attrMatch = trimmed.match(/^#\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/);
    if (attrMatch?.[1] && !trimmed.includes("pub ")) {
      currentAttrs.push(attrMatch[1].trim());
      continue;
    }

    // Check for inline attribute + pub field
    const inlineAttrRe = /#\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/g;
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = inlineAttrRe.exec(trimmed)) !== null) {
      if (inlineMatch[1] && inlineMatch.index < trimmed.indexOf("pub ")) {
        currentAttrs.push(inlineMatch[1].trim());
      }
    }

    // Parse field: pub name: Type
    const fieldMatch = trimmed.match(/pub\s+(\w+)\s*:\s*(.+)/s);
    if (!fieldMatch?.[1] || !fieldMatch[2]) continue;

    const fieldName = fieldMatch[1];
    let rawType = fieldMatch[2].trim();
    // Remove trailing comma and anything after
    rawType = rawType.replace(/,\s*$/, "").trim();
    // Handle multi-line types by removing line breaks
    rawType = rawType.replace(/\s+/g, " ").trim();

    const accountType = extractAccountType(rawType);

    // Get the LAST #[account(...)] attribute
    const accountAttr = [...currentAttrs]
      .reverse()
      .find((a) => a.startsWith("account(") || a === "account");

    let isSigner = false;
    let isMut = false;
    let isInit = false;
    let isPda = false;
    let pdaSeeds: string[] = [];
    let constraints: ReturnType<typeof parseConstraints> = [];

    if (accountAttr) {
      const inner = accountAttr.replace(/^account\s*\(\s*/, "").replace(/\s*\)$/, "");
      constraints = parseConstraints(inner);
      isMut = constraints.some((c) => c.kind === "mut" || c.kind === "init" || c.kind === "init_if_needed");
      isInit = constraints.some((c) => c.kind === "init" || c.kind === "init_if_needed");
      isPda = constraints.some((c) => c.kind === "seeds");

      // Extract PDA seeds
      const seedsConstraint = constraints.find((c) => c.kind === "seeds");
      if (seedsConstraint?.value) {
        pdaSeeds = parsePdaSeeds(seedsConstraint.value);
      }
    }

    if (rawType.includes("Signer")) isSigner = true;

    accounts.push({
      name: fieldName,
      accountType,
      isSigner,
      isMut,
      isInit,
      isPda,
      pdaSeeds,
      constraints,
    });
  }

  return accounts;
}

// ─── Account data struct parsing ─────────────────────────────────────────────

function parseAccountDefs(cleaned: string): SolanaIR["accounts"] {
  const defs: SolanaIR["accounts"] = [];

  const structBlocks = extractBlock(cleaned, /pub\s+struct\s+(\w+)/g);

  for (const { match, block } of structBlocks) {
    const structName = match[1];
    if (!structName) continue;

    const precedingText = cleaned.slice(
      Math.max(0, cleaned.indexOf(match[0]) - 300),
      cleaned.indexOf(match[0])
    );

    const hasAccountAttr =
      /#\[account(\s*\(|\s*\])/i.test(precedingText) ||
      /#\[account\b/.test(precedingText);

    if (!hasAccountAttr) continue;

    const fields = parseStructFields(block);
    if (fields.length === 0) continue;

    const space = 8 + fields.reduce((acc, f) => acc + fieldSize(f.type), 0);

    defs.push({ name: structName, fields, space });
  }

  return defs;
}

// ─── Error parsing ───────────────────────────────────────────────────────────

function parseErrors(cleaned: string): SolanaIR["errors"] {
  const errors: SolanaIR["errors"] = [];

  const errorEnumRe = /#\[error_code\]\s*pub\s+enum\s+(\w+)\s*\{([^}]*)\}/g;
  let enumMatch: RegExpExecArray | null;

  while ((enumMatch = errorEnumRe.exec(cleaned)) !== null) {
    const enumBody = enumMatch[2];

    const variantRe = /(?:#\[msg\("([^"]*)"\)\]\s*)?(\w+)\s*,?/g;
    let vMatch: RegExpExecArray | null;
    let code = 6000;

    while ((vMatch = variantRe.exec(enumBody ?? "")) !== null) {
      const msg = vMatch[1] ?? vMatch[2] ?? "";
      const name = vMatch[2];
      if (!name || name === "pub" || name === "enum") continue;
      errors.push({ code: code++, name, msg });
    }
  }

  return errors;
}

// ─── Helper function extraction ──────────────────────────────────────────────

function parseHelperFunctions(rawSource: string, cleaned: string): HelperFn[] {
  const helpers: HelperFn[] = [];

  // Find the #[program] mod boundaries
  const programMatch = cleaned.match(/#\[program\]\s*pub\s+mod\s+\w+/);
  if (!programMatch) return [];

  const programStart = cleaned.indexOf(programMatch[0]);
  const programOpenBrace = cleaned.indexOf("{", programStart);
  const programCloseBrace = findMatchingClose(cleaned, programOpenBrace, "{", "}");

  // Look for fn definitions OUTSIDE the program module and OUTSIDE account/error structs
  const beforeProgram = cleaned.slice(0, programStart);
  const afterProgram = programCloseBrace > 0 ? cleaned.slice(programCloseBrace + 1) : "";
  const outsideProgram = beforeProgram + "\n" + afterProgram;

  const fnBlocks = extractBlock(outsideProgram, /(pub\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g);

  for (const { match, block } of fnBlocks) {
    const isPublic = !!match[1];
    const name = match[2];
    if (!name) continue;

    // Skip if it's a struct impl method or test
    if (name.startsWith("test_") || name === "main") continue;

    // Reconstruct full signature
    const fnStart = outsideProgram.indexOf(match[0]);
    const sigEnd = outsideProgram.indexOf("{", fnStart);
    if (sigEnd === -1) continue;
    const signature = outsideProgram.slice(fnStart, sigEnd).trim();

    const rawCode = signature + " {" + block + "}";

    helpers.push({
      name,
      signature,
      body: "{" + block + "}",
      isPublic,
      rawCode,
    });
  }

  return helpers;
}

// ─── Custom types extraction ─────────────────────────────────────────────────

function parseCustomTypes(cleaned: string): SolanaIR["types"] {
  const types: SolanaIR["types"] = [];

  // Find structs that are NOT #[account] and NOT #[derive(Accounts)]
  const structBlocks = extractBlock(cleaned, /pub\s+struct\s+(\w+)/g);

  for (const { match, block } of structBlocks) {
    const structName = match[1];
    if (!structName) continue;
    const precedingText = cleaned.slice(
      Math.max(0, cleaned.indexOf(match[0]) - 300),
      cleaned.indexOf(match[0])
    );

    // Skip if it's an account struct or accounts context
    if (/#\[account/.test(precedingText)) continue;
    if (/#\[derive\([^)]*Accounts[^)]*\)\]/.test(precedingText)) continue;

    const fields = parseStructFields(block);
    if (fields.length === 0) continue;

    types.push({
      name: structName,
      kind: "struct" as const,
      fields,
    });
  }

  // Find enums that are NOT #[error_code]
  const enumRe = /pub\s+enum\s+(\w+)\s*\{([^}]*)\}/g;
  let enumMatch: RegExpExecArray | null;

  while ((enumMatch = enumRe.exec(cleaned)) !== null) {
    const enumName = enumMatch[1];
    const enumBody = enumMatch[2];
    if (!enumName || !enumBody) continue;
    const precedingText = cleaned.slice(
      Math.max(0, cleaned.indexOf(enumMatch[0]) - 200),
      cleaned.indexOf(enumMatch[0])
    );

    if (/#\[error_code\]/.test(precedingText)) continue;


    const variants: string[] = [];
    const variantRe = /(\w+)\s*(?:\{[^}]*\})?/g;
    let vm: RegExpExecArray | null;
    while ((vm = variantRe.exec(enumBody)) !== null) {
      const v = vm[1];
      if (v && v !== "pub" && v !== "enum") {
        variants.push(v);
      }
    }

    if (variants.length > 0) {
      types.push({
        name: enumName,
        kind: "enum" as const,
        variants,
      });
    }
  }

  return types;
}

// ─── Import extraction ───────────────────────────────────────────────────────

function extractImports(cleaned: string): string[] {
  const imports: string[] = [];
  const useRe = /^\s*use\s+(.+?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(cleaned)) !== null) {
    if (m[1]) imports.push(m[1]);
  }
  return imports;
}

// ─── Helper utilities ────────────────────────────────────────────────────────

function extractAccountType(rawType: string): string {
  const t = rawType.trim();
  const accountMatch = t.match(/^Account\s*<\s*'info\s*,\s*([\w:]+)\s*>/);
  if (accountMatch?.[1]) return accountMatch[1].split("::").pop() ?? accountMatch[1];
  const programMatch = t.match(/^Program\s*<\s*'info\s*,\s*(\w+)\s*>/);
  if (programMatch?.[1]) return programMatch[1];
  if (t.startsWith("Signer")) return "Signer";
  if (t.startsWith("SystemAccount")) return "SystemAccount";
  if (t.startsWith("UncheckedAccount")) return "UncheckedAccount";
  return t;
}

function extractAttributes(block: string): string[] {
  const attrs: string[] = [];
  const re = /#\[([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (m[1]) attrs.push(m[1].trim());
  }
  return attrs;
}

function parseStructFields(body: string): { name: string; type: string }[] {
  const fields: { name: string; type: string }[] = [];
  const fieldRe = /(?:pub\s+)?(\w+)\s*:\s*([A-Za-z0-9_<>]+)\s*,?/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const name = m[1];
    const rawType = m[2];
    if (!name || !rawType) continue;
    if (name === "pub" || name === "self" || name === "_phantom") continue;
    fields.push({ name, type: normalizeSolanaType(rawType) });
  }
  return fields;
}

function parsePdaSeeds(seedsValue: string): string[] {
  // Parse seeds = [b"counter", authority.key().as_ref()]
  const inner = seedsValue.replace(/^\[/, "").replace(/\]$/, "");
  const seeds: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of inner) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
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

function fieldSize(type: string): number {
  const sizes: Record<string, number> = {
    u8: 1, u16: 2, u32: 4, u64: 8, u128: 16,
    i8: 1, i16: 2, i32: 4, i64: 8, i128: 16,
    bool: 1, Pubkey: 32, String: 36, "Vec<u8>": 4,
  };
  return sizes[type] ?? 32;
}

function detectAnchorVersion(source: string): string {
  const vMatch = source.match(/anchor[_-]lang\s*=\s*"([^"]+)"/);
  return vMatch?.[1] ?? "0.30.0";
}
