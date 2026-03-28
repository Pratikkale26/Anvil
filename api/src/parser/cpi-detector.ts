/**
 * CPI Pattern Detector
 *
 * Detects and decomposes Cross-Program Invocation (CPI) patterns from Anchor Rust code.
 * Handles all standard Anchor CPI patterns:
 *   - System program SOL transfer
 *   - SPL Token transfer, mint_to, burn, close_account
 *   - Associated Token Account creation
 *   - Custom/generic CPIs via invoke/invoke_signed
 */

// ─── Detection result types ──────────────────────────────────────────────────

export type CpiDetection =
  | { kind: "system_transfer"; from: string; to: string; amount: string }
  | { kind: "spl_transfer"; from: string; to: string; authority: string; amount: string }
  | { kind: "spl_mint_to"; mint: string; to: string; authority: string; amount: string }
  | { kind: "spl_burn"; from: string; mint: string; authority: string; amount: string }
  | { kind: "spl_close_account"; account: string; destination: string; authority: string }
  | { kind: "custom"; program: string; rawCode: string };

// ─── Main detection function ─────────────────────────────────────────────────

/**
 * Attempt to detect a CPI pattern from a code block (possibly spanning multiple lines).
 * Returns null if no CPI pattern is detected.
 */
export function detectCpi(code: string): CpiDetection | null {
  // Normalize whitespace for pattern matching
  const normalized = code.replace(/\s+/g, " ").trim();

  // Try each detector in order of specificity
  return (
    trySystemTransfer(code, normalized) ??
    trySplTransfer(code, normalized) ??
    trySplMintTo(code, normalized) ??
    trySplBurn(code, normalized) ??
    trySplCloseAccount(code, normalized) ??
    tryGenericCpi(code, normalized)
  );
}

// ─── System Program Transfer ─────────────────────────────────────────────────

function trySystemTransfer(raw: string, norm: string): CpiDetection | null {
  // Pattern 1: anchor_lang::system_program::transfer(cpi_ctx, amount)?
  // With CpiContext containing Transfer { from, to }
  if (!norm.includes("system_program") && !norm.includes("SystemProgram")) return null;
  if (!norm.includes("Transfer") && !norm.includes("transfer")) return null;

  // Extract from the Transfer struct
  const transferStructMatch = raw.match(
    /Transfer\s*\{\s*from\s*:\s*ctx\.accounts\.(\w+)\.to_account_info\(\)\s*,\s*to\s*:\s*ctx\.accounts\.(\w+)\.to_account_info\(\)/s
  );

  // Also try without ctx.accounts prefix
  const transferStructMatch2 = raw.match(
    /Transfer\s*\{\s*from\s*:\s*(\w+)\.to_account_info\(\)\s*,\s*to\s*:\s*(\w+)\.to_account_info\(\)/s
  );

  const from = transferStructMatch?.[1] ?? transferStructMatch2?.[1] ?? "from";
  const to = transferStructMatch?.[2] ?? transferStructMatch2?.[2] ?? "to";

  // Extract amount from the transfer call
  const amountMatch = raw.match(
    /(?:system_program::)?transfer\s*\(\s*\w+\s*,\s*(\w+)\s*\)/
  );
  const amount = amountMatch?.[1] ?? "amount";

  return { kind: "system_transfer", from, to, amount };
}

// ─── SPL Token Transfer ──────────────────────────────────────────────────────

function trySplTransfer(raw: string, norm: string): CpiDetection | null {
  if (!norm.includes("token::transfer") && !norm.includes("token_program")) return null;
  // Must have Transfer struct (not Transfer as an instruction name)
  if (!norm.includes("Transfer {") && !norm.includes("Transfer{")) return null;
  // Exclude system_program::Transfer
  if (norm.includes("system_program::Transfer")) return null;

  // Extract Transfer struct fields
  const fields = extractTransferFields(raw);

  // Extract amount
  const amountMatch = raw.match(
    /token::transfer\s*\(\s*\w+\s*,\s*(.+?)\s*\)\s*\?/s
  );
  const amount = amountMatch?.[1]?.trim() ?? "amount";

  return {
    kind: "spl_transfer",
    from: fields.from ?? "from",
    to: fields.to ?? "to",
    authority: fields.authority ?? "authority",
    amount,
  };
}

// ─── SPL Token MintTo ────────────────────────────────────────────────────────

function trySplMintTo(raw: string, norm: string): CpiDetection | null {
  if (!norm.includes("mint_to") && !norm.includes("MintTo")) return null;

  const fields = extractMintToFields(raw);

  const amountMatch = raw.match(
    /(?:token::)?mint_to\s*\(\s*\w+\s*,\s*(.+?)\s*\)\s*\?/s
  );
  const amount = amountMatch?.[1]?.trim() ?? "amount";

  return {
    kind: "spl_mint_to",
    mint: fields.mint ?? "mint",
    to: fields.to ?? "to",
    authority: fields.authority ?? "authority",
    amount,
  };
}

// ─── SPL Token Burn ──────────────────────────────────────────────────────────

function trySplBurn(raw: string, norm: string): CpiDetection | null {
  if (!norm.includes("token::burn") && !norm.includes("Burn")) return null;

  const fields = extractBurnFields(raw);

  const amountMatch = raw.match(
    /(?:token::)?burn\s*\(\s*\w+\s*,\s*(.+?)\s*\)\s*\?/s
  );
  const amount = amountMatch?.[1]?.trim() ?? "amount";

  return {
    kind: "spl_burn",
    from: fields.from ?? "from",
    mint: fields.mint ?? "mint",
    authority: fields.authority ?? "authority",
    amount,
  };
}

// ─── SPL Token CloseAccount ──────────────────────────────────────────────────

function trySplCloseAccount(raw: string, norm: string): CpiDetection | null {
  if (!norm.includes("close_account") && !norm.includes("CloseAccount")) return null;

  const fields = extractCloseAccountFields(raw);

  return {
    kind: "spl_close_account",
    account: fields.account ?? "account",
    destination: fields.destination ?? "destination",
    authority: fields.authority ?? "authority",
  };
}

// ─── Generic / Custom CPI ────────────────────────────────────────────────────

function tryGenericCpi(raw: string, norm: string): CpiDetection | null {
  if (!norm.includes("CpiContext::new") && !norm.includes("invoke")) return null;

  // Try to extract the program being called
  const programMatch = raw.match(
    /ctx\.accounts\.(\w+)\.to_account_info\(\)/
  );
  const program = programMatch?.[1] ?? "unknown_program";

  return {
    kind: "custom",
    program,
    rawCode: raw,
  };
}

// ─── Field extraction helpers ────────────────────────────────────────────────

interface TransferFields {
  from?: string;
  to?: string;
  authority?: string;
}

function extractTransferFields(raw: string): TransferFields {
  const result: TransferFields = {};

  // from: ctx.accounts.X.to_account_info() or X.to_account_info()
  const fromMatch = raw.match(
    /from\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (fromMatch?.[1]) result.from = fromMatch[1];

  // to: ctx.accounts.X.to_account_info() or X.to_account_info()
  const toMatch = raw.match(
    /to\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (toMatch?.[1]) result.to = toMatch[1];

  // authority: ctx.accounts.X.to_account_info() or X.to_account_info()
  const authMatch = raw.match(
    /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (authMatch?.[1]) result.authority = authMatch[1];

  return result;
}

interface MintToFields {
  mint?: string;
  to?: string;
  authority?: string;
}

function extractMintToFields(raw: string): MintToFields {
  const result: MintToFields = {};

  const mintMatch = raw.match(
    /mint\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (mintMatch?.[1]) result.mint = mintMatch[1];

  const toMatch = raw.match(
    /to\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (toMatch?.[1]) result.to = toMatch[1];

  const authMatch = raw.match(
    /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (authMatch?.[1]) result.authority = authMatch[1];

  return result;
}

interface BurnFields {
  from?: string;
  mint?: string;
  authority?: string;
}

function extractBurnFields(raw: string): BurnFields {
  const result: BurnFields = {};

  const fromMatch = raw.match(
    /from\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (fromMatch?.[1]) result.from = fromMatch[1];

  const mintMatch = raw.match(
    /mint\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (mintMatch?.[1]) result.mint = mintMatch[1];

  const authMatch = raw.match(
    /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (authMatch?.[1]) result.authority = authMatch[1];

  return result;
}

interface CloseAccountFields {
  account?: string;
  destination?: string;
  authority?: string;
}

function extractCloseAccountFields(raw: string): CloseAccountFields {
  const result: CloseAccountFields = {};

  const accountMatch = raw.match(
    /account\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (accountMatch?.[1]) result.account = accountMatch[1];

  const destMatch = raw.match(
    /destination\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (destMatch?.[1]) result.destination = destMatch[1];

  const authMatch = raw.match(
    /authority\s*:\s*(?:ctx\.accounts\.)?(\w+)\.to_account_info\(\)/
  );
  if (authMatch?.[1]) result.authority = authMatch[1];

  return result;
}
