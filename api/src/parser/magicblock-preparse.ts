/**
 * MagicBlock Ephemeral Rollups — pre-parse macro expansion.
 *
 * Anchor programs targeting MagicBlock use three attribute macros from
 * `ephemeral-rollups-sdk` (verified against 0.16.2 source):
 *
 *   - `#[delegate]` on a #[derive(Accounts)] struct: for every field whose
 *     `#[account(...)]` carries the `del` marker, injects three companion
 *     UncheckedAccounts (`buffer_<f>`, `delegation_record_<f>`,
 *     `delegation_metadata_<f>`) BEFORE the field, appends struct-level
 *     `owner_program` / `delegation_program` / `system_program` fields when
 *     absent, and generates a `delegate_<f>(payer, seeds, DelegateConfig)`
 *     impl method.
 *   - `#[commit]` on a #[derive(Accounts)] struct: appends `magic_program` +
 *     `magic_context` fields when absent.
 *   - `#[ephemeral]` on the #[program] module: appends the
 *     `process_undelegation` callback instruction + its
 *     `InitializeAfterUndelegation` accounts struct. The callback's Anchor
 *     discriminator (sha256("global:process_undelegation")[..8]) equals the
 *     delegation program's EXTERNAL_UNDELEGATE_DISCRIMINATOR
 *     [196,28,41,206,48,37,51,167] by construction, so keeping the exact
 *     instruction name preserves wire compatibility for free.
 *
 * This module textually mirrors those expansions BEFORE tree-sitter parses
 * (same slot as the Arcium `#[arcium_program]` strip — G11). The generated
 * `delegate_<f>` method is NOT expanded into source: the call sites
 * (`ctx.accounts.delegate_<f>(...)`) are recognized directly by
 * cpi-detector.ts and lowered to the `cpi_magicblock_delegate` IR kind,
 * where the companion account names are re-derived from the same
 * deterministic `<prefix>_<f>` scheme this expansion writes.
 *
 * Fidelity deltas vs the real proc-macro (documented, deliberate):
 *   - Companion PDA fields are injected WITHOUT `seeds`/`seeds::program`
 *     constraints. The delegation program re-derives and validates every
 *     one of these PDAs itself, so a wrong account still fails — inside the
 *     delegation program rather than at Anchor's constraint layer (error
 *     code differs, outcome does not).
 *   - `owner_program` is injected without the `address = crate::id()` pin;
 *     the delegation program validates it via buffer-PDA derivation.
 *   - `magic_program` / `delegation_program` / `magic_context` DO keep
 *     their address pins, vendored as byte-array consts below.
 *
 * Gate: everything here is a no-op unless the source mentions
 * `ephemeral_rollups_sdk`, so non-MagicBlock programs are byte-identical
 * through this pass.
 */

const DELEGATION_PROGRAM_ID_BYTES =
  "181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229, 25, 152, 204, 98, 126, 24, 147, 128, 167, 62";
const MAGIC_PROGRAM_ID_BYTES =
  "5, 69, 180, 36, 176, 218, 112, 149, 236, 185, 214, 222, 195, 119, 215, 40, 145, 182, 231, 142, 146, 234, 18, 214, 223, 187, 58, 64, 0, 0, 0, 0";
const MAGIC_CONTEXT_ID_BYTES =
  "5, 69, 180, 36, 196, 165, 40, 191, 95, 180, 3, 47, 68, 82, 130, 142, 187, 56, 171, 193, 210, 220, 151, 247, 63, 139, 148, 84, 128, 0, 0, 0";

export interface MagicBlockExpansion {
  source: string;
  /** True when the source is MagicBlock-flavored (sdk referenced). */
  sawMagicBlock: boolean;
  sawEphemeral: boolean;
  sawDelegate: boolean;
  sawCommit: boolean;
  /**
   * Attr-level constructs outside the supported catalog, e.g.
   * "#[ephemeral_accounts]". Caller surfaces each as a
   * `magicblock_unsupported` parser warning (body-level constructs are
   * caught separately by detectMagicBlockUnsupportedCpi).
   */
  unsupported: string[];
}

/** Balanced-brace scan: returns index of the `}` matching the `{` at `open`. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * From an attribute's index, locate the following struct's body span.
 * Returns null when no `struct` keyword follows within a sane window.
 */
function structBodyAfter(source: string, from: number): { open: number; close: number } | null {
  const structIdx = source.indexOf("struct", from);
  if (structIdx === -1) return null;
  const open = source.indexOf("{", structIdx);
  if (open === -1) return null;
  const close = matchBrace(source, open);
  if (close === -1) return null;
  return { open, close };
}

/** Strip a bare `del` marker from an `#[account(...)]` attribute line. */
function stripDelMarker(attrLine: string): string {
  return attrLine
    .replace(/\(\s*del\s*,\s*/, "(")
    .replace(/,\s*del\s*(?=[,)])/g, "")
    .replace(/\(\s*del\s*\)/, "()")
    .replace(/#\[account\(\)\]/, "#[account]");
}

function hasField(body: string, name: string): boolean {
  return new RegExp(`\\bpub\\s+${name}\\s*:`).test(body);
}

const COMMIT_FIELDS = `
    /// CHECK: MagicBlock magic program (address-checked)
    #[account(address = MAGICBLOCK_MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock magic context (address-checked)
    #[account(mut, address = MAGICBLOCK_MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
`;

const DELEGATE_TAIL_FIELDS: Array<{ name: string; text: string }> = [
  {
    name: "owner_program",
    text: `    /// CHECK: this program — validated by the delegation program via buffer-PDA derivation
    pub owner_program: UncheckedAccount<'info>,
`,
  },
  {
    name: "delegation_program",
    text: `    /// CHECK: MagicBlock delegation program (address-checked)
    #[account(address = MAGICBLOCK_DELEGATION_PROGRAM_ID)]
    pub delegation_program: UncheckedAccount<'info>,
`,
  },
  {
    name: "system_program",
    text: `    pub system_program: Program<'info, System>,
`,
  },
];

function companionFields(f: string): string {
  return `    /// CHECK: delegate buffer PDA — validated by the delegation program
    #[account(mut)]
    pub buffer_${f}: UncheckedAccount<'info>,
    /// CHECK: delegation record PDA — validated by the delegation program
    #[account(mut)]
    pub delegation_record_${f}: UncheckedAccount<'info>,
    /// CHECK: delegation metadata PDA — validated by the delegation program
    #[account(mut)]
    pub delegation_metadata_${f}: UncheckedAccount<'info>,
`;
}

const EPHEMERAL_HANDLER = `
    /// MagicBlock undelegation callback — invoked BY the delegation program
    /// (discriminator sha256("global:process_undelegation")[..8] ==
    /// EXTERNAL_UNDELEGATE_DISCRIMINATOR). Restores the delegated PDA from
    /// the undelegate buffer. Injected by Anvil's #[ephemeral] expansion.
    pub fn process_undelegation(ctx: Context<InitializeAfterUndelegation>, account_seeds: Vec<Vec<u8>>) -> Result<()> {
        undelegate_account(
            &ctx.accounts.base_account,
            &ctx.accounts.buffer,
            &ctx.accounts.payer,
            &ctx.accounts.system_program,
            account_seeds,
        )?;
        Ok(())
    }
`;

const EPHEMERAL_STRUCT = `
/// Accounts for the MagicBlock undelegation callback (injected by Anvil's
/// #[ephemeral] expansion — mirrors ephemeral-rollups-sdk 0.16.2).
#[derive(Accounts)]
pub struct InitializeAfterUndelegation<'info> {
    /// CHECK: the delegated account being restored
    #[account(mut)]
    pub base_account: UncheckedAccount<'info>,
    /// CHECK: undelegate buffer — signer + delegation-program-owned + canonical PDA, validated in the handler
    pub buffer: UncheckedAccount<'info>,
    /// CHECK: payer funding the re-created PDA
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    /// CHECK: system program
    pub system_program: UncheckedAccount<'info>,
}
`;

// Line-anchored: attribute macros always sit on their own line; matching
// bare `#[...]` anywhere would also hit mentions inside comments/strings
// and corrupt the expansion (caught by parser-magicblock.test.ts).
const UNSUPPORTED_ATTRS: Array<{ re: RegExp; label: string }> = [
  { re: /^[ \t]*#\[\s*ephemeral_accounts\b/m, label: "#[ephemeral_accounts]" },
  { re: /^[ \t]*#\[\s*action\s*[\](]/m, label: "#[action]" },
  { re: /^[ \t]*#\[\s*vrf\s*\]/m, label: "#[vrf]" },
  { re: /^[ \t]*#\[\s*vrf_callback\b/m, label: "#[vrf_callback]" },
];

export function expandMagicBlockMacros(source: string): MagicBlockExpansion {
  if (!/ephemeral_rollups_sdk/.test(source)) {
    return { source, sawMagicBlock: false, sawEphemeral: false, sawDelegate: false, sawCommit: false, unsupported: [] };
  }

  const unsupported: string[] = [];
  for (const { re, label } of UNSUPPORTED_ATTRS) {
    if (re.test(source)) unsupported.push(label);
  }

  let sawEphemeral = false;
  let sawDelegate = false;
  let sawCommit = false;

  // ── #[commit] ──────────────────────────────────────────────────────────
  const commitAttrRe = /^[ \t]*#\[\s*commit\s*\][ \t]*\r?\n/m;
  for (;;) {
    const m = commitAttrRe.exec(source);
    if (!m) break;
    sawCommit = true;
    source = source.slice(0, m.index) + source.slice(m.index + m[0].length);
    const span = structBodyAfter(source, m.index);
    if (!span) continue;
    const body = source.slice(span.open + 1, span.close);
    let inject = "";
    if (!hasField(body, "magic_program") || !hasField(body, "magic_context")) {
      // The real macro appends each field independently; in practice both
      // are absent or both present. Append whichever is missing.
      if (!hasField(body, "magic_program")) {
        inject += COMMIT_FIELDS.split("/// CHECK: MagicBlock magic context")[0]!;
      }
      if (!hasField(body, "magic_context")) {
        inject += `    /// CHECK: MagicBlock magic context (address-checked)
    #[account(mut, address = MAGICBLOCK_MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
`;
      }
    }
    if (inject) {
      source = source.slice(0, span.close) + inject + source.slice(span.close);
    }
  }

  // ── #[delegate] ────────────────────────────────────────────────────────
  const delegateAttrRe = /^[ \t]*#\[\s*delegate\s*\][ \t]*\r?\n/m;
  for (;;) {
    const m = delegateAttrRe.exec(source);
    if (!m) break;
    sawDelegate = true;
    source = source.slice(0, m.index) + source.slice(m.index + m[0].length);
    const span = structBodyAfter(source, m.index);
    if (!span) continue;
    const body = source.slice(span.open + 1, span.close);

    // Line-based rebuild: group body lines into per-field chunks (a chunk
    // ends at its `pub <name>:` line). Doc comments + attrs stay attached
    // to their field, so companion injections land BEFORE the whole chunk.
    const lines = body.split("\n");
    const out: string[] = [];
    let chunk: string[] = [];
    for (const line of lines) {
      chunk.push(line);
      const fieldMatch = /\bpub\s+(\w+)\s*:/.exec(line);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1]!;
      const hasDel = chunk.some((l) => /#\[account\([^\]]*\bdel\b/.test(l));
      if (hasDel) {
        const cleaned = chunk.map((l) => (/#\[account\(/.test(l) ? stripDelMarker(l) : l));
        out.push(companionFields(fieldName).replace(/\n$/, ""));
        out.push(...cleaned);
      } else {
        out.push(...chunk);
      }
      chunk = [];
    }
    out.push(...chunk); // trailing non-field lines (whitespace)

    let newBody = out.join("\n");
    let tail = "";
    for (const { name, text } of DELEGATE_TAIL_FIELDS) {
      if (!hasField(newBody, name)) tail += text;
    }
    // Ensure the last field line ends with a comma before appending tail
    // fields (Anchor structs conventionally do, but be safe).
    if (tail && !/,\s*$/.test(newBody.trimEnd())) {
      newBody = `${newBody.trimEnd()},\n`;
    }
    source = source.slice(0, span.open + 1) + newBody + tail + source.slice(span.close);
  }

  // ── #[ephemeral] ───────────────────────────────────────────────────────
  const ephemeralAttrRe = /^[ \t]*#\[\s*ephemeral\s*\][ \t]*\r?\n/m;
  const em = ephemeralAttrRe.exec(source);
  if (em) {
    sawEphemeral = true;
    source = source.slice(0, em.index) + source.slice(em.index + em[0].length);
    // Locate the #[program] module body following the attr position.
    const progAttr = source.indexOf("#[program]", Math.max(0, em.index - 200));
    const modIdx = progAttr === -1 ? -1 : source.indexOf("mod", progAttr);
    const open = modIdx === -1 ? -1 : source.indexOf("{", modIdx);
    const close = open === -1 ? -1 : matchBrace(source, open);
    if (close !== -1 && !/\bfn\s+process_undelegation\b/.test(source)) {
      source = source.slice(0, close) + EPHEMERAL_HANDLER + source.slice(close) ;
      const newClose = close + EPHEMERAL_HANDLER.length + 1; // past the module's `}`
      source = source.slice(0, newClose) + "\n" + EPHEMERAL_STRUCT + source.slice(newClose);
    }
  }

  // ── Vendored program-ID consts ─────────────────────────────────────────
  const needsConsts: string[] = [];
  if (/MAGICBLOCK_DELEGATION_PROGRAM_ID/.test(source) && !/pub const MAGICBLOCK_DELEGATION_PROGRAM_ID/.test(source)) {
    needsConsts.push(`pub const MAGICBLOCK_DELEGATION_PROGRAM_ID: Pubkey = Pubkey::new_from_array([${DELEGATION_PROGRAM_ID_BYTES}]);`);
  }
  if (/MAGICBLOCK_MAGIC_PROGRAM_ID/.test(source) && !/pub const MAGICBLOCK_MAGIC_PROGRAM_ID/.test(source)) {
    needsConsts.push(`pub const MAGICBLOCK_MAGIC_PROGRAM_ID: Pubkey = Pubkey::new_from_array([${MAGIC_PROGRAM_ID_BYTES}]);`);
  }
  if (/MAGICBLOCK_MAGIC_CONTEXT_ID/.test(source) && !/pub const MAGICBLOCK_MAGIC_CONTEXT_ID/.test(source)) {
    needsConsts.push(`pub const MAGICBLOCK_MAGIC_CONTEXT_ID: Pubkey = Pubkey::new_from_array([${MAGIC_CONTEXT_ID_BYTES}]);`);
  }
  if (needsConsts.length > 0) {
    source = `${source}\n\n// Anvil-vendored: MagicBlock program ID constants (ephemeral-rollups-sdk 0.16.2).\n${needsConsts.join("\n")}\n`;
  }

  return { source, sawMagicBlock: true, sawEphemeral, sawDelegate, sawCommit, unsupported };
}
