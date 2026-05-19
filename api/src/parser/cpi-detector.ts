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
import { type WarningCollector, locFromNode } from "./warning-collector.js";

/**
 * Lookup of a previously-tracked variable-bound CpiContext. body-classifier
 * tracks `let X = CpiContext::new(...);` bindings in a Map<varName, info>
 * and supplies this lookup so the detector can recover signer_seeds (and
 * struct field names) when the CPI call references the variable instead
 * of inlining the CpiContext literal — the H2 fix path.
 */
export interface CpiContextLookup {
  (varName: string): {
    from?: string;
    to?: string;
    authority?: string;
    signerSeeds?: string;
  } | undefined;
}

/**
 * Strict CPI function-name match. Avoids the substring-collision class
 * that produced the T22-ext misroute bug (fix landed in commit ac4e23d
 * after the live API surfaced `transfer_fee_initialize` getting routed
 * through extractSplTransfer via `includes("transfer")`).
 *
 * Two accept shapes:
 *   - Bare unqualified call (post-CpiContext-consolidation):
 *     `transfer_fee_initialize(cpi_ctx, …)` → funcText === name.
 *   - Qualified path:
 *     `anchor_spl::token_2022_extensions::transfer_fee::transfer_fee_initialize(…)`
 *     → funcText.endsWith("::" + name).
 *
 * Rejects:
 *   - Arbitrary substring containment. `transfer_fee_initialize` does
 *     NOT match `transfer_fee_initialize_v2` (hypothetical future name)
 *     under this matcher; the dispatch would correctly fall through to
 *     a more specific rule or to pass_through.
 *   - Names that look similar but aren't exact. `transfer` does NOT
 *     match `transfer_fee_initialize` — closing the original misroute.
 *
 * If a future call shape needs more flexibility (e.g. dispatch on a
 * version-prefixed name), add a separate predicate rather than
 * widening this one.
 */
function isExtCall(funcText: string, name: string): boolean {
  return funcText === name || funcText.endsWith("::" + name);
}

/**
 * Add a `cpi_classification_lost` warning to the collector when a CPI was
 * recognised by name but the detector couldn't extract its struct fields.
 * `kind` describes the CPI surface (e.g. "SPL transfer", "set_authority"),
 * which becomes part of the user-facing message.
 */
function warnClassificationLost(
  collector: WarningCollector | undefined,
  kind: string,
  node: SyntaxNode,
): void {
  collector?.add({
    code: "cpi_classification_lost",
    message: `CPI '${kind}' recognised but could not extract details (carried as pass_through). Manual verification required.`,
    snippet: node.text,
    loc: locFromNode(node),
  });
}

/**
 * Try to detect a CPI call in an expression node.
 * Returns a classified BodyStatement if it's a known CPI, or null.
 *
 * Works on both call_expression and try_expression nodes.
 *
 * `collector`, when supplied, receives `cpi_classification_lost`,
 * `cpi_custom_emitted`, and `signer_seeds_lost_variable_binding` warnings
 * each time the detector falls back to pass_through, emits a custom CPI
 * stub, or drops signer_seeds because the CpiContext was variable-bound.
 */
export function detectCpi(
  node: SyntaxNode,
  collector?: WarningCollector,
  cpiCtxLookup?: CpiContextLookup,
): BodyStatement | null {
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

  // T22 extension dispatch MUST run before the generic token_2022/
  // token_interface SPL block below. Reason: every T22 ext fn whose name
  // contains "transfer" (transfer_fee_initialize, transfer_fee_set,
  // transfer_hook_initialize, transfer_hook_update, transfer_checked_with_fee)
  // would otherwise match the SPL block's `includes("transfer")` and route
  // to extractSplTransfer with completely different account shapes,
  // producing a silent misroute. The T22 fn names are specific enough
  // that no SPL fn name is a substring of any T22 ext fn name, so this
  // order is safe.
  //
  // Each isExtCall match is precise: `funcText === name` OR
  // `funcText.endsWith("::" + name)`. Previously these used
  // `funcText.includes(name)` which had two known risks: (1) substring
  // collisions where an unrelated future function name happens to
  // contain an existing T22-ext name as a substring, (2) the T22-ext
  // name being a substring of a longer future T22-ext that needs
  // distinct dispatch. isExtCall closes both classes — see
  // parser-cpi-dispatch-precedence.test.ts for the regression coverage.
  if (isExtCall(funcText, "non_transferable_mint_initialize")) {
    return extractT22NonTransferableMintInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "transfer_fee_initialize")) {
    return extractT22TransferFeeInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "transfer_fee_set")) {
    return extractT22TransferFeeSet(callNode, collector);
  }
  if (isExtCall(funcText, "immutable_owner_initialize")) {
    return extractT22ImmutableOwnerInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "mint_close_authority_initialize")) {
    return extractT22MintCloseAuthorityInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "permanent_delegate_initialize")) {
    return extractT22PermanentDelegateInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "transfer_hook_initialize")) {
    return extractT22TransferHookInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "transfer_hook_update")) {
    return extractT22TransferHookUpdate(callNode, collector);
  }
  if (isExtCall(funcText, "metadata_pointer_initialize")) {
    return extractT22MetadataPointerInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "metadata_pointer_update")) {
    return extractT22MetadataPointerUpdate(callNode, collector);
  }
  // group_member_pointer_* MUST come before group_pointer_* — the
  // shorter name is a substring under the strict matcher's endsWith
  // arm only if the prefix is exactly `::`, but a tree-sitter funcText
  // for an unqualified bare call would be just the leaf name. Order
  // longest-first to be safe.
  if (isExtCall(funcText, "group_member_pointer_initialize")) {
    return extractT22GroupMemberPointerInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "group_member_pointer_update")) {
    return extractT22GroupMemberPointerUpdate(callNode, collector);
  }
  if (isExtCall(funcText, "group_pointer_initialize")) {
    return extractT22GroupPointerInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "group_pointer_update")) {
    return extractT22GroupPointerUpdate(callNode, collector);
  }
  if (isExtCall(funcText, "transfer_checked_with_fee")) {
    return extractT22TransferCheckedWithFee(callNode, collector);
  }
  if (isExtCall(funcText, "withdraw_withheld_tokens_from_mint")) {
    return extractT22WithdrawWithheldFromMint(callNode, collector);
  }
  if (isExtCall(funcText, "harvest_withheld_tokens_to_mint")) {
    return extractT22HarvestWithheldToMint(callNode, collector);
  }
  if (isExtCall(funcText, "default_account_state_initialize")) {
    return extractT22DefaultAccountStateInit(callNode, collector);
  }
  if (isExtCall(funcText, "default_account_state_update")) {
    return extractT22DefaultAccountStateUpdate(callNode, collector);
  }
  if (isExtCall(funcText, "interest_bearing_mint_initialize")) {
    return extractT22InterestBearingMintInit(callNode, collector);
  }
  if (isExtCall(funcText, "interest_bearing_mint_update_rate")) {
    return extractT22InterestBearingMintUpdateRate(callNode, collector);
  }
  if (isExtCall(funcText, "token_metadata_initialize")) {
    return extractT22TokenMetadataInitialize(callNode, collector);
  }
  if (isExtCall(funcText, "token_metadata_update_field")) {
    return extractT22TokenMetadataUpdateField(callNode, collector);
  }
  if (isExtCall(funcText, "token_metadata_update_authority")) {
    return extractT22TokenMetadataUpdateAuthority(callNode, collector);
  }

  // ── Token-2022 / token_interface CPI patterns (generic SPL fns through
  // the Token-2022 program). Falls below the T22-extension dispatch so a
  // qualified `token_2022::transfer_fee_initialize(...)` doesn't get
  // misrouted into extractSplTransfer via the `includes("transfer")`
  // substring match.
  if (funcText.includes("token_2022::") || funcText.includes("token_interface::")) {
    if (funcText.includes("transfer_checked") || funcText.includes("transfer")) {
      const result = extractSplTransfer(callNode, collector, cpiCtxLookup);
      if (result.kind === "cpi_spl_transfer") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("mint_to")) {
      const result = extractSplMintTo(callNode, collector);
      if (result.kind === "cpi_spl_mint_to") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("burn")) {
      const result = extractSplBurn(callNode, collector);
      if (result.kind === "cpi_spl_burn") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("close_account") || funcText.includes("CloseAccount")) {
      const result = extractSplCloseAccount(callNode, collector);
      if (result.kind === "cpi_spl_close_account") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
    if (funcText.includes("set_authority") || funcText.includes("SetAuthority")) {
      const result = extractSplSetAuthority(callNode, collector);
      if (result.kind === "cpi_spl_set_authority") {
        return { ...result, tokenProgram: "token_2022" as const };
      }
      return result;
    }
  }

  // ── SPL Token transfer ──
  if (funcText.includes("token::transfer") || funcText.includes("token::Transfer")) {
    return extractSplTransfer(callNode, collector, cpiCtxLookup);
  }

  // ── SPL Token mint_to ──
  if (funcText.includes("token::mint_to") || funcText.includes("token::MintTo")) {
    return extractSplMintTo(callNode, collector);
  }

  // ── SPL Token burn ──
  if (funcText.includes("token::burn") || funcText.includes("token::Burn")) {
    return extractSplBurn(callNode, collector);
  }

  // ── Unqualified legacy SPL Token CPI calls (post-consolidation) ──
  // After CpiContext consolidation collapses the user's let-bound accounts
  // struct into the call expression, the function name appears unqualified
  // (`transfer(CpiContext::new_with_signer(...))?`) when the user wrote
  // `use anchor_spl::token::{Transfer, transfer};`. Distinguish from the
  // anchor_lang::system_program::transfer form by inspecting the inline
  // struct: SPL `Transfer` has an `authority:` field while system's doesn't.
  if (funcText === "transfer") {
    const argsNode = callNode.childForFieldName("arguments");
    const args = argsNode ? getArguments(argsNode) : [];
    const firstArg = args[0];
    const isSplShape =
      !!firstArg &&
      firstArg.text.includes("Transfer") &&
      /\bauthority\s*:/.test(firstArg.text);
    if (isSplShape) return extractSplTransfer(callNode, collector, cpiCtxLookup);
    // Fall through — likely system_program::transfer; the system branch
    // below handles namespaced forms.
  }
  if (funcText === "mint_to" || funcText === "burn" || funcText === "close_account" || funcText === "set_authority") {
    const argsNode = callNode.childForFieldName("arguments");
    const args = argsNode ? getArguments(argsNode) : [];
    const firstArg = args[0];
    if (firstArg && firstArg.text.includes("CpiContext::")) {
      if (funcText === "mint_to") return extractSplMintTo(callNode, collector);
      if (funcText === "burn") return extractSplBurn(callNode, collector);
      if (funcText === "close_account") return extractSplCloseAccount(callNode, collector);
      if (funcText === "set_authority") return extractSplSetAuthority(callNode, collector);
    }
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
    const result = extractSplTransfer(callNode, collector, cpiCtxLookup);
    if (result.kind === "cpi_spl_transfer") {
      return { ...result, tokenProgram: "token_2022" as const };
    }
    return result;
  }
  if (/^mint_to_checked$|::mint_to_checked$/.test(funcText)) {
    const result = extractSplMintTo(callNode, collector);
    if (result.kind === "cpi_spl_mint_to") {
      return { ...result, tokenProgram: "token_2022" as const };
    }
    return result;
  }
  if (/^burn_checked$|::burn_checked$/.test(funcText)) {
    const result = extractSplBurn(callNode, collector);
    if (result.kind === "cpi_spl_burn") {
      return { ...result, tokenProgram: "token_2022" as const };
    }
    return result;
  }

  // ── SPL Token close_account ──
  if (funcText.includes("close_account") || funcText.includes("CloseAccount")) {
    return extractSplCloseAccount(callNode, collector);
  }

  // ── SPL Token set_authority ──
  // Anchor: token::set_authority(ctx, AuthorityType::X, Some(pk))
  // Also matches the unqualified `set_authority(...)` form post-consolidation
  // (when the user `use anchor_spl::token::set_authority;` brought it into scope)
  // and the `token_interface::set_authority(...)` Token-2022 form (handled
  // above in the token_interface branch).
  if (
    funcText === "set_authority" ||
    funcText.includes("token::set_authority") ||
    funcText.includes("::set_authority")
  ) {
    return extractSplSetAuthority(callNode, collector);
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
    return extractAtaCreate(callNode, collector);
  }

  // ── System program transfer ──
  if (funcText.includes("system_program::transfer") || funcText.includes("system_instruction::transfer")) {
    return extractSystemTransfer(callNode, collector);
  }

  // ── Free-function `transfer(cpi_ctx, amount)` ──
  // pda-rent-payer style: source has `use anchor_lang::system_program::{transfer, Transfer}`
  // and calls bare `transfer(cpi_context, fund_lamports)?;`. The first arg is
  // a CpiContext::new(SYSTEM_PROGRAM, Transfer { from, to }). Disambiguate
  // from spl-token's bare `transfer` by checking: (a) the CpiContext program
  // arg references system_program, OR (b) the struct only has from+to (token's
  // Transfer struct also has `authority`).
  if (funcText === "transfer") {
    const argsNode = callNode.childForFieldName("arguments");
    const firstArgText = argsNode ? (getArguments(argsNode)[0]?.text ?? "") : "";
    const looksSystem =
      /\bsystem_program\b/.test(firstArgText) &&
      /\bTransfer\s*\{/.test(firstArgText) &&
      !/\bauthority\s*:/.test(firstArgText);
    if (looksSystem) return extractSystemTransfer(callNode, collector);
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
    return extractMemoCpi(callNode, collector);
  }

  // ── Generic invoke / invoke_signed ──
  if (funcText === "invoke" || funcText === "invoke_signed") {
    return extractCustomCpi(callNode, collector);
  }

  // ── Metaplex Token Metadata CPIs (#29) ──
  // First-class IR slot for the most common Metaplex calls. Detection is
  // the structural step; the emit handlers still go through the existing
  // walker.ts text-regex stubs until grant-M3 wires real emit per target.
  if (
    funcText.includes("create_metadata_accounts_v3") ||
    funcText.endsWith("::create_metadata_accounts_v3")
  ) {
    return extractMplCreateMetadataV3(callNode, collector);
  }
  if (
    funcText.includes("create_master_edition_v3") ||
    funcText.endsWith("::create_master_edition_v3")
  ) {
    return extractMplCreateMasterEditionV3(callNode, collector);
  }
  if (
    funcText.includes("update_metadata_accounts_v2") ||
    funcText.endsWith("::update_metadata_accounts_v2")
  ) {
    return extractMplUpdateMetadataAccountsV2(callNode, collector);
  }
  // Order matters: check more-specific names BEFORE shorter prefixes.
  // "set_and_verify_collection" / "unverify_collection" both contain
  // "verify_collection" as a substring; the dispatch falls through on
  // first match, so the more-specific tokens have to win.
  if (
    funcText.includes("mint_new_edition_from_master_edition_via_token") ||
    funcText.endsWith("::mint_new_edition_from_master_edition_via_token") ||
    funcText.includes("mint_new_edition_from_master") ||
    funcText.endsWith("::mint_new_edition_from_master")
  ) {
    return extractMplMintNewEditionFromMaster(callNode, collector);
  }
  // M1i/M1j — freeze/thaw_delegated_account. Check after their substring
  // siblings (freeze_account / thaw_account on regular SPL Token) — those
  // aren't in this catalog but a future SPL Token CPI add could collide.
  // Today no conflicts; dispatch order is internal to MPL.
  if (
    funcText.includes("freeze_delegated_account") ||
    funcText.endsWith("::freeze_delegated_account") ||
    funcText.includes("freeze_delegated") ||
    funcText.endsWith("::freeze_delegated")
  ) {
    return extractMplFreezeDelegated(callNode, collector);
  }
  if (
    funcText.includes("thaw_delegated_account") ||
    funcText.endsWith("::thaw_delegated_account") ||
    funcText.includes("thaw_delegated") ||
    funcText.endsWith("::thaw_delegated")
  ) {
    return extractMplThawDelegated(callNode, collector);
  }
  if (
    funcText.includes("revoke_collection_authority") ||
    funcText.endsWith("::revoke_collection_authority")
  ) {
    return extractMplRevokeCollectionAuthority(callNode, collector);
  }
  if (
    funcText.includes("approve_collection_authority") ||
    funcText.endsWith("::approve_collection_authority")
  ) {
    return extractMplApproveCollectionAuthority(callNode, collector);
  }
  if (
    funcText.includes("set_and_verify_collection") ||
    funcText.endsWith("::set_and_verify_collection")
  ) {
    return extractMplSetAndVerifyCollection(callNode, collector);
  }
  if (
    funcText.includes("unverify_collection") ||
    funcText.endsWith("::unverify_collection")
  ) {
    return extractMplUnverifyCollection(callNode, collector);
  }
  if (
    funcText.includes("verify_collection") ||
    funcText.endsWith("::verify_collection")
  ) {
    return extractMplVerifyCollection(callNode, collector);
  }
  if (
    funcText.includes("sign_metadata") ||
    funcText.endsWith("::sign_metadata")
  ) {
    return extractMplSignMetadata(callNode, collector);
  }

  // MPL Core (task #48 S1+S2). Uses kinobi's fluent CpiBuilder rather than
  // CpiContext::new. Outer call is `.invoke()` (or `.invoke_signed(seeds)`)
  // and the receiver chain bottoms out at the constructor's `::new(prog)`.
  if (
    /\bCreateV2CpiBuilder\b/.test(funcText) &&
    /\.(invoke|invoke_signed)$/.test(funcText)
  ) {
    return extractMplCoreCreateV2(callNode, collector);
  }
  if (
    /\bUpdateV2CpiBuilder\b/.test(funcText) &&
    /\.(invoke|invoke_signed)$/.test(funcText)
  ) {
    return extractMplCoreUpdateV2(callNode, collector);
  }
  if (
    /\bTransferV1CpiBuilder\b/.test(funcText) &&
    /\.(invoke|invoke_signed)$/.test(funcText)
  ) {
    return extractMplCoreTransferV1(callNode, collector);
  }
  if (
    /\bBurnV1CpiBuilder\b/.test(funcText) &&
    /\.(invoke|invoke_signed)$/.test(funcText)
  ) {
    return extractMplCoreBurnV1(callNode, collector);
  }
  if (
    /\bCreateCollectionV2CpiBuilder\b/.test(funcText) &&
    /\.(invoke|invoke_signed)$/.test(funcText)
  ) {
    return extractMplCoreCreateCollectionV2(callNode, collector);
  }

  return null;
}

/**
 * Extract cpi_mpl_create_metadata_v3. The Anchor call shape is:
 *   create_metadata_accounts_v3(
 *     CpiContext::new_with_signer(prog, CreateMetadataAccountsV3 {
 *       metadata, mint, mint_authority, payer, update_authority,
 *       system_program, rent,
 *     }, signers),
 *     DataV2 { name, symbol, uri, seller_fee_basis_points, ... },
 *     is_mutable, update_authority_is_signer, collection_details,
 *   )?;
 *
 * Conservative: only fires when the first arg carries an inline CpiContext
 * and the second is a recognisable DataV2 literal. Otherwise falls back
 * to cpi_custom (which surfaces the cpi_custom_emitted warning).
 */
function extractMplCreateMetadataV3(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;
  const dataText = args[1]?.text ?? "";
  const dataField = (field: string): string => {
    // Shorthand: `DataV2 { name, symbol, uri, ... }` — when the field has
    // no `:`, the value is implicitly the variable of the same name.
    // Common idiom when a handler receives instruction args named after
    // the struct fields. Match shorthand FIRST so the explicit-form regex
    // below doesn't false-match `name` in the trailing tail of a previous
    // field's value.
    const shorthand = dataText.match(
      new RegExp(`(?:[{,]\\s*)${field}(?=\\s*[,}])`),
    );
    if (shorthand) return field;
    const explicit = dataText.match(new RegExp(`\\b${field}\\s*:\\s*([^,}]+)`));
    return explicit?.[1]?.trim() ?? "";
  };
  // Task #84 closed: creators, collection, uses all captured.
  const creatorsExpr = extractDataV2NestedExpression(dataText, "creators");
  const collectionExpr = extractDataV2NestedExpression(dataText, "collection");
  const usesExpr = extractDataV2NestedExpression(dataText, "uses");

  return {
    kind: "cpi_mpl_create_metadata_v3",
    metadata: cleanAccountRef(grab("metadata")),
    mint: cleanAccountRef(grab("mint")),
    mintAuthority: cleanAccountRef(grab("mint_authority")),
    payer: cleanAccountRef(grab("payer")),
    updateAuthority: cleanAccountRef(grab("update_authority")),
    name: dataField("name") || `"unknown"`,
    symbol: dataField("symbol") || `"UNK"`,
    uri: dataField("uri") || `""`,
    sellerFeeBasisPoints: dataField("seller_fee_basis_points") || "0",
    creators: creatorsExpr,
    collection: collectionExpr,
    uses: usesExpr,
    isMutable: args[2]?.text.trim() ?? "true",
    updateAuthorityIsSigner: args[3]?.text.trim() ?? "true",
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract a raw-text expression for a nested-shape DataV2 field
 * (`creators`, `collection`, `uses`). These take values like
 * `Some(vec![Creator { ... }])` or `Some(Collection { ... })` —
 * the simple `\b<field>:[^,}]+` regex (used for scalar fields)
 * cuts off at the first `,` inside the nested struct literal.
 *
 * Returns undefined if the field is missing OR set to literal "None".
 * Anything else (including `Some(...)`, a variable name, or shorthand)
 * is returned verbatim for the emit visitor to inline.
 */
function extractDataV2NestedExpression(dataText: string, field: string): string | undefined {
  const re = new RegExp(`\\b${field}\\s*:\\s*`);
  const m = re.exec(dataText);
  if (!m) {
    const shorthand = new RegExp(`(?:[{,]\\s*)${field}(?=\\s*[,}])`).exec(dataText);
    return shorthand ? field : undefined;
  }
  const start = m.index + m[0].length;
  let depth = 0;
  let i = start;
  while (i < dataText.length) {
    const ch = dataText[i]!;
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
    i++;
  }
  const value = dataText.slice(start, i).trim();
  if (!value || value === "None") return undefined;
  return value;
}

// Back-compat alias — keeps the old name for any internal callers.
function extractDataV2CreatorsExpression(dataText: string): string | undefined {
  return extractDataV2NestedExpression(dataText, "creators");
}

/**
 * Extract cpi_mpl_update_metadata_accounts_v2 (M1). Anchor call shape:
 *   update_metadata_accounts_v2(
 *     CpiContext::new_with_signer(prog, UpdateMetadataAccountsV2 {
 *       metadata, update_authority,
 *     }, signers),
 *     new_update_authority,   // Option<Pubkey>
 *     Some(DataV2 { name, symbol, uri, seller_fee_basis_points, ... }),
 *     primary_sale_happened,  // Option<bool>
 *     is_mutable,             // Option<bool>
 *   )?;
 *
 * Common Anchor usage: update DataV2 (post-mint name/uri fix) OR rotate
 * update authority — rarely both at once. Anvil's emit handles all four
 * Option args; the IR's optional new{Name,Symbol,Uri} carry the DataV2
 * fields when the source set new_data = Some(...).
 */
function extractMplUpdateMetadataAccountsV2(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  // Args after the CpiContext:
  //   args[1] = new_update_authority (Option<Pubkey>)
  //   args[2] = new_data             (Option<DataV2>)
  //   args[3] = primary_sale_happened (Option<bool>)
  //   args[4] = is_mutable           (Option<bool>)
  const newUpdateAuthority = args[1]?.text.trim() ?? "None";
  const newDataText = args[2]?.text.trim() ?? "None";
  const primarySaleHappened = args[3]?.text.trim() ?? "None";
  const isMutable = args[4]?.text.trim() ?? "None";

  // Parse Some(DataV2 { name, symbol, uri, seller_fee_basis_points }).
  // Falls back to no-data-update if not the literal Some(DataV2 {...}) shape.
  let newName: string | undefined;
  let newSymbol: string | undefined;
  let newUri: string | undefined;
  let newSellerFeeBasisPoints = "0";
  let creatorsExpr: string | undefined;
  let collectionExpr: string | undefined;
  let usesExpr: string | undefined;
  const dataV2Match = newDataText.match(/Some\s*\(\s*DataV2\s*\{([\s\S]*)\}\s*\)/);
  if (dataV2Match && dataV2Match[1]) {
    const inner = dataV2Match[1];
    const grabField = (field: string): string | undefined => {
      const shorthand = inner.match(
        new RegExp(`(?:[{,]\\s*)${field}(?=\\s*[,}])`),
      );
      if (shorthand) return field;
      const m = inner.match(new RegExp(`\\b${field}\\s*:\\s*([^,}]+)`));
      return m?.[1]?.trim();
    };
    newName = grabField("name");
    newSymbol = grabField("symbol");
    newUri = grabField("uri");
    newSellerFeeBasisPoints = grabField("seller_fee_basis_points") ?? "0";
    // Task #84 closed: creators, collection, uses all captured.
    creatorsExpr = extractDataV2NestedExpression(inner, "creators");
    collectionExpr = extractDataV2NestedExpression(inner, "collection");
    usesExpr = extractDataV2NestedExpression(inner, "uses");
  }

  return {
    kind: "cpi_mpl_update_metadata_accounts_v2",
    metadata: cleanAccountRef(grab("metadata")),
    updateAuthority: cleanAccountRef(grab("update_authority")),
    newUpdateAuthority,
    newName,
    newSymbol,
    newUri,
    newSellerFeeBasisPoints,
    creators: creatorsExpr,
    collection: collectionExpr,
    uses: usesExpr,
    primarySaleHappened,
    isMutable,
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_verify_collection (M1b). Anchor call shape:
 *   verify_collection(
 *     CpiContext::new_with_signer(prog, VerifyCollection {
 *       payer, metadata, collection_authority, collection_mint,
 *       collection, collection_master_edition,
 *     }, signers),
 *     collection_authority_record,  // Option<Pubkey>
 *   )?;
 *
 * Single arg after CpiContext. The VerifyCollection accounts struct
 * field name is `collection` (NOT `collection_metadata` — that's the
 * Metaplex IDL field; anchor-spl renamed it). Anvil's IR uses
 * `collection` to match the anchor-spl wrapper field name; the underlying
 * mpl instruction calls it collection_metadata in account slot 4.
 */
function extractMplVerifyCollection(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;
  const grabAny = (fields: string[]): string => {
    for (const f of fields) {
      const v = extractStructField(accountsStruct, f);
      if (v) return v;
    }
    return fields[fields.length - 1]!;
  };

  return {
    kind: "cpi_mpl_verify_collection",
    metadata: cleanAccountRef(grab("metadata")),
    collectionAuthority: cleanAccountRef(grab("collection_authority")),
    payer: cleanAccountRef(grab("payer")),
    collectionMint: cleanAccountRef(grab("collection_mint")),
    collection: cleanAccountRef(grabAny(["collection_metadata", "collection"])),
    collectionMasterEdition: cleanAccountRef(grab("collection_master_edition")),
    collectionAuthorityRecord: args[1]?.text.trim() ?? "None",
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_freeze_delegated (M1i — slot 11). 5 accounts, no data.
 */
function extractMplFreezeDelegated(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);
  const grab = (field: string) => extractStructField(accountsStruct, field) ?? field;
  return {
    kind: "cpi_mpl_freeze_delegated",
    delegate: cleanAccountRef(grab("delegate")),
    tokenAccount: cleanAccountRef(grab("token_account")),
    edition: cleanAccountRef(grab("edition")),
    mint: cleanAccountRef(grab("mint")),
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_thaw_delegated (M1j — slot 12). Symmetric inverse of freeze.
 */
function extractMplThawDelegated(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);
  const grab = (field: string) => extractStructField(accountsStruct, field) ?? field;
  return {
    kind: "cpi_mpl_thaw_delegated",
    delegate: cleanAccountRef(grab("delegate")),
    tokenAccount: cleanAccountRef(grab("token_account")),
    edition: cleanAccountRef(grab("edition")),
    mint: cleanAccountRef(grab("mint")),
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_mint_new_edition_from_master (M1h — slot 10).
 * Anchor wrapper name: mint_new_edition_from_master_edition_via_token.
 * 14 accounts in the struct + 1 u64 edition arg after the CpiContext.
 */
function extractMplMintNewEditionFromMaster(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  return {
    kind: "cpi_mpl_mint_new_edition_from_master",
    newMetadata: cleanAccountRef(grab("new_metadata")),
    newEdition: cleanAccountRef(grab("new_edition")),
    masterEdition: cleanAccountRef(grab("master_edition")),
    newMint: cleanAccountRef(grab("new_mint")),
    editionMarkPda: cleanAccountRef(grab("edition_mark_pda")),
    newMintAuthority: cleanAccountRef(grab("new_mint_authority")),
    payer: cleanAccountRef(grab("payer")),
    tokenAccountOwner: cleanAccountRef(grab("token_account_owner")),
    tokenAccount: cleanAccountRef(grab("token_account")),
    newMetadataUpdateAuthority: cleanAccountRef(grab("new_metadata_update_authority")),
    metadata: cleanAccountRef(grab("metadata")),
    edition: args[1]?.text.trim() ?? "0",
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_revoke_collection_authority (M1g — slot 9).
 * Symmetric inverse of approve. 5 accounts, no data args.
 */
function extractMplRevokeCollectionAuthority(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  return {
    kind: "cpi_mpl_revoke_collection_authority",
    collectionAuthorityRecord: cleanAccountRef(grab("collection_authority_record")),
    delegateAuthority: cleanAccountRef(grab("delegate_authority")),
    revokeAuthority: cleanAccountRef(grab("revoke_authority")),
    metadata: cleanAccountRef(grab("metadata")),
    mint: cleanAccountRef(grab("mint")),
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_approve_collection_authority (M1f — slot 8).
 * No data args after the CpiContext; 8 fixed accounts (system_program
 * and rent are sourced from the visitor's standard bindings, not from
 * the IR — keeping the IR field count minimal).
 */
function extractMplApproveCollectionAuthority(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  return {
    kind: "cpi_mpl_approve_collection_authority",
    collectionAuthorityRecord: cleanAccountRef(grab("collection_authority_record")),
    newCollectionAuthority: cleanAccountRef(grab("new_collection_authority")),
    updateAuthority: cleanAccountRef(grab("update_authority")),
    payer: cleanAccountRef(grab("payer")),
    metadata: cleanAccountRef(grab("metadata")),
    mint: cleanAccountRef(grab("mint")),
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_set_and_verify_collection (M1e — slot 7). Combo of
 * UpdateMetadata's set-collection + VerifyCollection. Same accounts
 * as verify_collection + extra `update_authority: AccountInfo<'info>`
 * (signer) since this CPI mutates the metadata account.
 */
function extractMplSetAndVerifyCollection(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  const grabAny = (fields: string[]): string => {
    for (const f of fields) {
      const v = extractStructField(accountsStruct, f);
      if (v) return v;
    }
    return fields[fields.length - 1]!;
  };

  return {
    kind: "cpi_mpl_set_and_verify_collection",
    metadata: cleanAccountRef(grab("metadata")),
    collectionAuthority: cleanAccountRef(grab("collection_authority")),
    payer: cleanAccountRef(grab("payer")),
    updateAuthority: cleanAccountRef(grab("update_authority")),
    collectionMint: cleanAccountRef(grab("collection_mint")),
    collection: cleanAccountRef(grabAny(["collection_metadata", "collection"])),
    collectionMasterEdition: cleanAccountRef(grab("collection_master_edition")),
    collectionAuthorityRecord: args[1]?.text.trim() ?? "None",
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_unverify_collection (M1d — slot 6). Symmetric inverse
 * of verify_collection. Anchor wrapper exposes the same struct field
 * names + same `collection_authority_record: Option<Pubkey>` arg.
 */
function extractMplUnverifyCollection(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;
  const grabAny = (fields: string[]): string => {
    for (const f of fields) {
      const v = extractStructField(accountsStruct, f);
      if (v) return v;
    }
    return fields[fields.length - 1]!;
  };

  return {
    kind: "cpi_mpl_unverify_collection",
    metadata: cleanAccountRef(grab("metadata")),
    collectionAuthority: cleanAccountRef(grab("collection_authority")),
    payer: cleanAccountRef(grab("payer")),
    collectionMint: cleanAccountRef(grab("collection_mint")),
    collection: cleanAccountRef(grab("collection")),
    collectionMasterEdition: cleanAccountRef(grabAny(["collection_master_edition_account", "collection_master_edition"])),
    collectionAuthorityRecord: args[1]?.text.trim() ?? "None",
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_sign_metadata (M1c — slot 5). Anchor call shape:
 *   sign_metadata(
 *     CpiContext::new_with_signer(prog, SignMetadata {
 *       metadata, creator,
 *     }, signers),
 *   )?;
 *
 * No data args. Simplest catalog entry.
 */
function extractMplSignMetadata(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  return {
    kind: "cpi_mpl_sign_metadata",
    metadata: cleanAccountRef(grab("metadata")),
    creator: cleanAccountRef(grab("creator")),
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_create_master_edition_v3. Anchor call shape:
 *   create_master_edition_v3(
 *     CpiContext::new_with_signer(prog, CreateMasterEditionV3 {
 *       edition, mint, update_authority, mint_authority, payer,
 *       metadata, token_program, system_program, rent,
 *     }, signers),
 *     max_supply,
 *   )?;
 */
function extractMplCreateMasterEditionV3(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) return extractCustomCpi(callNode, collector);
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    return extractCustomCpi(callNode, collector);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  if (!accountsStruct) return extractCustomCpi(callNode, collector);

  const grab = (field: string) =>
    extractStructField(accountsStruct, field) ?? field;

  return {
    kind: "cpi_mpl_create_master_edition_v3",
    edition: cleanAccountRef(grab("edition")),
    mint: cleanAccountRef(grab("mint")),
    mintAuthority: cleanAccountRef(grab("mint_authority")),
    payer: cleanAccountRef(grab("payer")),
    metadata: cleanAccountRef(grab("metadata")),
    updateAuthority: cleanAccountRef(grab("update_authority")),
    maxSupply: args[1]?.text.trim() ?? "None",
    signerSeeds: (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined,
  };
}

/**
 * Extract cpi_mpl_core_create_v2 (task #48 S1). MPL Core uses kinobi's
 * fluent CpiBuilder, not CpiContext. Source shape:
 *
 *   mpl_core::CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
 *       .asset(&ctx.accounts.asset.to_account_info())
 *       .payer(&ctx.accounts.payer.to_account_info())
 *       .system_program(&ctx.accounts.system_program.to_account_info())
 *       .name("Foo".to_string())
 *       .uri("https://example.com".to_string())
 *       .data_state(DataState::AccountState)
 *       .plugins(None)
 *       .external_plugin_adapters(None)
 *       .invoke()?;
 *
 * Optionals (.collection, .authority, .owner, .update_authority,
 * .log_wrapper) may or may not appear. .invoke_signed(seeds) is the
 * alternate terminator that supplies signer seeds.
 *
 * Strategy: walk the receiver chain by descending into each call_expression's
 * function.field_expression.value. Each step is one `.method(arg)`. The
 * chain bottoms out at the initial `CreateV2CpiBuilder::new(program)` call
 * — its first arg is the program AccountInfo.
 */
/**
 * Walk an MPL Core kinobi CpiBuilder fluent chain. Returns the captured
 * method-name → arg-text map, the constructor's program arg, and any
 * .invoke_signed(seeds) arg. Shared by CreateV2 + UpdateV2 (and future
 * MPL Core slots — same chain shape across all builders).
 */
function walkMplCoreBuilder(callNode: SyntaxNode): {
  fields: Record<string, string>;
  programArg: string;
  signerSeeds: string | undefined;
} {
  const fields: Record<string, string> = {};
  let signerSeeds: string | undefined;
  let programArg = "mpl_core_program";

  let current: SyntaxNode | null = callNode;
  let safety = 0;
  while (current && current.type === "call_expression" && safety++ < 64) {
    const funcNode = current.childForFieldName("function");
    if (!funcNode) break;

    if (funcNode.type === "field_expression") {
      const methodNode = funcNode.childForFieldName("field");
      const innerExpr: SyntaxNode | null = funcNode.childForFieldName("value");
      const methodName = methodNode?.text ?? "";
      const argsNode = current.childForFieldName("arguments");
      const args = argsNode ? getArguments(argsNode) : [];
      const argText = args[0]?.text.trim() ?? "";
      if (methodName === "invoke_signed") {
        signerSeeds = argText;
      } else if (methodName === "invoke") {
        // terminal, nothing to capture
      } else if (methodName) {
        fields[methodName] = argText;
      }
      current = innerExpr;
    } else if (funcNode.type === "scoped_identifier") {
      const argsNode = current.childForFieldName("arguments");
      const args = argsNode ? getArguments(argsNode) : [];
      if (args[0]) programArg = args[0].text.trim();
      break;
    } else {
      break;
    }
  }
  return { fields, programArg, signerSeeds };
}

function extractMplCoreCreateV2(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const { fields, programArg, signerSeeds } = walkMplCoreBuilder(callNode);

  if (!fields.asset || !fields.payer || !fields.system_program) {
    warnClassificationLost(collector, "MPL Core CreateV2", callNode);
    return extractCustomCpi(callNode, collector);
  }

  const clean = (s: string) => cleanAccountRef(s.trim().replace(/^&\s*/, ""));
  return {
    kind: "cpi_mpl_core_create_v2",
    programAccount: clean(programArg),
    asset: clean(fields.asset),
    collection: fields.collection ? `Some(${clean(stripSomeWrap(fields.collection))})` : "None",
    authority: fields.authority ? `Some(${clean(stripSomeWrap(fields.authority))})` : "None",
    payer: clean(fields.payer),
    owner: fields.owner ? `Some(${clean(stripSomeWrap(fields.owner))})` : "None",
    updateAuthority: fields.update_authority ? `Some(${clean(stripSomeWrap(fields.update_authority))})` : "None",
    systemProgram: clean(fields.system_program),
    logWrapper: fields.log_wrapper ? `Some(${clean(stripSomeWrap(fields.log_wrapper))})` : "None",
    name: fields.name ?? '""',
    uri: fields.uri ?? '""',
    dataState: fields.data_state ?? "DataState::AccountState",
    signerSeeds,
  };
}

/**
 * task #48 S5 — CreateCollectionV2 (disc 21, 4 accounts). Simplest of
 * the lifecycle-style instructions: no log_wrapper slot, no data_state
 * arg. Source pattern:
 *   mpl_core::CreateCollectionV2CpiBuilder::new(prog)
 *       .collection(&ctx.accounts.collection.to_account_info())
 *       .payer(&ctx.accounts.payer.to_account_info())
 *       .system_program(&ctx.accounts.system_program.to_account_info())
 *       .name(name)
 *       .uri(uri)
 *       .plugins(None)
 *       .external_plugin_adapters(None)
 *       .invoke()?;
 */
function extractMplCoreCreateCollectionV2(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const { fields, programArg, signerSeeds } = walkMplCoreBuilder(callNode);

  if (!fields.collection || !fields.payer || !fields.system_program) {
    warnClassificationLost(collector, "MPL Core CreateCollectionV2", callNode);
    return extractCustomCpi(callNode, collector);
  }

  const clean = (s: string) => cleanAccountRef(s.trim().replace(/^&\s*/, ""));
  return {
    kind: "cpi_mpl_core_create_collection_v2",
    programAccount: clean(programArg),
    collection: clean(fields.collection),
    updateAuthority: fields.update_authority ? `Some(${clean(stripSomeWrap(fields.update_authority))})` : "None",
    payer: clean(fields.payer),
    systemProgram: clean(fields.system_program),
    name: fields.name ?? '""',
    uri: fields.uri ?? '""',
    signerSeeds,
  };
}

/**
 * task #48 S4 — BurnV1 (disc 12, 6 accounts). Closes the lifecycle along
 * with CreateV2 + UpdateV2 + TransferV1. Source pattern:
 *   mpl_core::BurnV1CpiBuilder::new(prog)
 *       .asset(&ctx.accounts.asset.to_account_info())
 *       .payer(&ctx.accounts.payer.to_account_info())
 *       .authority(Some(&ctx.accounts.owner.to_account_info()))
 *       .system_program(&ctx.accounts.system_program.to_account_info())
 *       .invoke()?;
 */
function extractMplCoreBurnV1(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const { fields, programArg, signerSeeds } = walkMplCoreBuilder(callNode);

  if (!fields.asset || !fields.payer || !fields.system_program) {
    warnClassificationLost(collector, "MPL Core BurnV1", callNode);
    return extractCustomCpi(callNode, collector);
  }

  const clean = (s: string) => cleanAccountRef(s.trim().replace(/^&\s*/, ""));
  return {
    kind: "cpi_mpl_core_burn_v1",
    programAccount: clean(programArg),
    asset: clean(fields.asset),
    collection: fields.collection ? `Some(${clean(stripSomeWrap(fields.collection))})` : "None",
    payer: clean(fields.payer),
    authority: fields.authority ? `Some(${clean(stripSomeWrap(fields.authority))})` : "None",
    systemProgram: clean(fields.system_program),
    logWrapper: fields.log_wrapper ? `Some(${clean(stripSomeWrap(fields.log_wrapper))})` : "None",
    signerSeeds,
  };
}

/**
 * task #48 S3 — TransferV1 (disc 14, 7 accounts). Source pattern:
 *   mpl_core::TransferV1CpiBuilder::new(prog)
 *       .asset(&ctx.accounts.asset.to_account_info())
 *       .payer(&ctx.accounts.payer.to_account_info())
 *       .authority(Some(&ctx.accounts.owner.to_account_info()))
 *       .new_owner(&ctx.accounts.recipient.to_account_info())
 *       .system_program(&ctx.accounts.system_program.to_account_info())
 *       .invoke()?;
 */
function extractMplCoreTransferV1(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const { fields, programArg, signerSeeds } = walkMplCoreBuilder(callNode);

  if (!fields.asset || !fields.payer || !fields.new_owner || !fields.system_program) {
    warnClassificationLost(collector, "MPL Core TransferV1", callNode);
    return extractCustomCpi(callNode, collector);
  }

  const clean = (s: string) => cleanAccountRef(s.trim().replace(/^&\s*/, ""));
  return {
    kind: "cpi_mpl_core_transfer_v1",
    programAccount: clean(programArg),
    asset: clean(fields.asset),
    collection: fields.collection ? `Some(${clean(stripSomeWrap(fields.collection))})` : "None",
    payer: clean(fields.payer),
    authority: fields.authority ? `Some(${clean(stripSomeWrap(fields.authority))})` : "None",
    newOwner: clean(fields.new_owner),
    systemProgram: clean(fields.system_program),
    logWrapper: fields.log_wrapper ? `Some(${clean(stripSomeWrap(fields.log_wrapper))})` : "None",
    signerSeeds,
  };
}

/**
 * task #48 S2 — UpdateV2 (disc 30, 7 accounts). Source pattern:
 *   mpl_core::UpdateV2CpiBuilder::new(prog)
 *       .asset(&ctx.accounts.asset.to_account_info())
 *       .payer(&ctx.accounts.payer.to_account_info())
 *       .system_program(&ctx.accounts.system_program.to_account_info())
 *       .new_name(Some("New Name".to_string()))
 *       .new_uri(Some("https://new.example.com".to_string()))
 *       .new_update_authority(None)
 *       .invoke()?;
 */
function extractMplCoreUpdateV2(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const { fields, programArg, signerSeeds } = walkMplCoreBuilder(callNode);

  if (!fields.asset || !fields.payer || !fields.system_program) {
    warnClassificationLost(collector, "MPL Core UpdateV2", callNode);
    return extractCustomCpi(callNode, collector);
  }

  const clean = (s: string) => cleanAccountRef(s.trim().replace(/^&\s*/, ""));
  // Option<String> args pass through verbatim — preserve the Some(...) form.
  const passOpt = (raw: string | undefined): string => {
    if (!raw) return "None";
    const trimmed = raw.trim();
    return trimmed === "" ? "None" : trimmed;
  };
  return {
    kind: "cpi_mpl_core_update_v2",
    programAccount: clean(programArg),
    asset: clean(fields.asset),
    collection: fields.collection ? `Some(${clean(stripSomeWrap(fields.collection))})` : "None",
    payer: clean(fields.payer),
    authority: fields.authority ? `Some(${clean(stripSomeWrap(fields.authority))})` : "None",
    newCollection: fields.new_collection ? `Some(${clean(stripSomeWrap(fields.new_collection))})` : "None",
    systemProgram: clean(fields.system_program),
    logWrapper: fields.log_wrapper ? `Some(${clean(stripSomeWrap(fields.log_wrapper))})` : "None",
    newName: passOpt(fields.new_name),
    newUri: passOpt(fields.new_uri),
    signerSeeds,
  };
}

/**
 * Source might write `.collection(Some(&x))` or `.collection(&x)` — the
 * kinobi builder API actually requires the explicit Some(_), but we handle
 * the bare form defensively. Strip one outer Some(...) wrapper if present.
 */
function stripSomeWrap(expr: string): string {
  const trimmed = expr.trim();
  const m = trimmed.match(/^Some\(\s*([\s\S]+?)\s*\)$/);
  return m?.[1] ?? trimmed;
}

function extractMemoCpi(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "spl_memo build_memo", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  // Two call shapes in the wild:
  //   anchor_spl::memo::build_memo(ctx: CpiContext<...>, memo: &[u8])
  //     -> data at arg[1] when arg[0] is a CpiContext binding/expr
  //   spl_memo::build_memo(memo_bytes, signers: &[&[u8]])
  //     -> data at arg[0] (no CpiContext)
  // Detect by inspecting arg[0]: `cpi_ctx` (the consolidator's canonical
  // binding name) or a literal `CpiContext::` expression marks the
  // Anchor-wrapper form.
  const firstText = args[0]?.text.trim() ?? "";
  const isAnchorWrapper =
    firstText === "cpi_ctx" ||
    firstText.startsWith("CpiContext::") ||
    /^cpi_ctx\b|\bCpiContext\b/.test(firstText);
  const dataIdx = isAnchorWrapper ? 1 : 0;
  const data = args[dataIdx]?.text.trim() ?? "&[]";
  return {
    kind: "cpi_memo",
    data,
  };
}

// ─── SPL Token Transfer ─────────────────────────────────────────────────────

function extractSplTransfer(callNode: SyntaxNode, collector?: WarningCollector, cpiCtxLookup?: CpiContextLookup): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "SPL token::transfer", callNode);
    return fallbackPassThrough(callNode);
  }

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
    signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined;
  } else if (firstArg) {
    // Variable-bound CpiContext (`let cpi_ctx = CpiContext::new(...);
    // transfer(cpi_ctx, amount)?;`). Look up the binding via the
    // body-classifier-supplied lookup; on hit we recover signer_seeds and
    // any unresolved struct fields. On miss we emit the loud warning so
    // the user knows signer_seeds was dropped.
    const varName = firstArg.text.trim().replace(/^&\s*/, "");
    const ctx = cpiCtxLookup?.(varName);
    if (ctx) {
      signerSeeds = ctx.signerSeeds;
      if (ctx.from) from = ctx.from;
      if (ctx.to) to = ctx.to;
      if (ctx.authority) authority = ctx.authority;
    } else {
      signerSeeds = undefined;
      collector?.add({
        code: "signer_seeds_lost_variable_binding",
        message: `SPL transfer's CpiContext was variable-bound to '${varName}' and the binding wasn't tracked; signer_seeds on that binding are not carried into emit. PDA-signed transfer may revert at runtime.`,
        snippet: callNode.text,
        loc: locFromNode(callNode),
      });
    }
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

function extractSplMintTo(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "SPL token::mint_to", callNode);
    return fallbackPassThrough(callNode);
  }

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
    signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined;
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

function extractSplBurn(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "SPL token::burn", callNode);
    return fallbackPassThrough(callNode);
  }

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
    signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined;
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

// ─── SPL Token Set Authority ────────────────────────────────────────────────

function extractSplSetAuthority(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "SPL token::set_authority", callNode);
    return fallbackPassThrough(callNode);
  }

  const args = getArguments(argsNode);
  const firstArg = args[0];

  // We can only emit an active set_authority CPI when the first arg carries
  // an inline `CpiContext::new(...)` whose accounts struct lets us extract
  // the SetAuthority { account_or_mint, current_authority } fields. The
  // From-trait shape (`ctx.accounts.into()`) doesn't expose those — fall
  // back to pass_through so the source survives verbatim. (#3 — From-trait
  // inlining — would later promote those sites into the typed IR.)
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "SPL token::set_authority (variable-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }

  // Anchor: `SetAuthority { account_or_mint, current_authority }` — field
  // name is `account_or_mint`, but we model both as `account` in the IR
  // since the SPL instruction takes a single AccountInfo for the target.
  const setAuthStruct = findDescendant(firstArg, "struct_expression");
  if (!setAuthStruct) {
    warnClassificationLost(collector, "SPL token::set_authority (no inline accounts struct)", callNode);
    return fallbackPassThrough(callNode);
  }

  const accountRaw = extractStructField(setAuthStruct, "account_or_mint")
    ?? extractStructField(setAuthStruct, "account");
  const currentAuthorityRaw = extractStructField(setAuthStruct, "current_authority");
  if (!accountRaw || !currentAuthorityRaw) {
    warnClassificationLost(collector, "SPL token::set_authority (missing required struct fields)", callNode);
    return fallbackPassThrough(callNode);
  }

  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;

  // The remaining args are: AuthorityType variant + new_authority option.
  // Both are raw text — emitter maps the AuthorityType variant to the
  // target's enum path. We strip `ctx.accounts.` from new_authority since
  // the body walker emits accounts as flat locals (`<name> = &accounts[i]`).
  const authorityType = args[1]?.text.trim() ?? "AuthorityType::AccountOwner";
  const newAuthority = (args[2]?.text.trim() ?? "None")
    .replace(/\bctx\s*\.\s*accounts\s*\./g, "");

  return {
    kind: "cpi_spl_set_authority",
    account: cleanAccountRef(accountRaw),
    currentAuthority: cleanAccountRef(currentAuthorityRaw),
    authorityType,
    newAuthority,
    signerSeeds,
  };
}

// ─── SPL Token Close Account ────────────────────────────────────────────────

function extractSplCloseAccount(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "SPL token::close_account", callNode);
    return fallbackPassThrough(callNode);
  }

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
    signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined;
  }

  return {
    kind: "cpi_spl_close_account",
    account: cleanAccountRef(account),
    destination: cleanAccountRef(destination),
    authority: cleanAccountRef(authority),
    signerSeeds,
  };
}

// ─── Token-2022 NonTransferable extension init (EM2 Session 1) ──────────────
//
// Anchor source shape:
//   non_transferable_mint_initialize(CpiContext::new(
//       ctx.accounts.token_program.key(),
//       NonTransferableMintInitialize {
//           token_program_id: ctx.accounts.token_program.to_account_info(),
//           mint: ctx.accounts.mint_account.to_account_info(),
//       },
//   ))?;
//
// Extracts mint + tokenProgram from the inline struct. Signer-seeds variant
// supported via new_with_signer. Falls back to pass_through when the
// CpiContext isn't inline (variable-bound CpiContext is the same gap as
// set_authority — handled by the From-trait inliner work).
function extractT22NonTransferableMintInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 non_transferable_mint_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 non_transferable_mint_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_non_transferable_mint_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    signerSeeds,
  };
}

// ─── Token-2022 TransferFee extension init (EM2 Session 1) ──────────────────
//
// Anchor source shape:
//   transfer_fee_initialize(
//       CpiContext::new(
//           ctx.accounts.token_program.key(),
//           TransferFeeInitialize {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint_account.to_account_info(),
//           },
//       ),
//       Some(&ctx.accounts.payer.key()),  // transfer_fee_config_authority
//       Some(&ctx.accounts.payer.key()),  // withdraw_withheld_authority
//       transfer_fee_basis_points,        // u16
//       maximum_fee,                      // u64
//   )?;
function extractT22TransferFeeInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 transfer_fee_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 transfer_fee_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  // Trailing args after the CpiContext: 4 positional values. Carry
  // them as raw text — values may be Anchor expressions
  // (`Some(&ctx.accounts.payer.key())`) that the body-emitter pass
  // pipeline will further resolve via transformCtxAccountsReferences.
  const transferFeeConfigAuthority = args[1]?.text.trim() ?? "None";
  const withdrawWithheldAuthority = args[2]?.text.trim() ?? "None";
  const basisPoints = cleanAmountExpr(args[3]?.text ?? "0u16");
  const maximumFee = cleanAmountExpr(args[4]?.text ?? "0u64");
  return {
    kind: "cpi_t22_transfer_fee_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    transferFeeConfigAuthority,
    withdrawWithheldAuthority,
    basisPoints,
    maximumFee,
    signerSeeds,
  };
}

// ─── Token-2022 TransferFee extension manage: set_fee ───────────────────────
//
// Anchor source shape:
//   transfer_fee_set(
//       CpiContext::new(
//           ctx.accounts.token_program.key(),
//           TransferFeeSetTransferFee {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint_account.to_account_info(),
//               authority: ctx.accounts.authority.to_account_info(),
//           },
//       ),
//       transfer_fee_basis_points,
//       maximum_fee,
//   )?;
function extractT22TransferFeeSet(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 transfer_fee_set", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 transfer_fee_set (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let authority = "authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    authority = extractStructField(accountsStruct, "authority") ?? authority;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  const basisPoints = cleanAmountExpr(args[1]?.text ?? "0u16");
  const maximumFee = cleanAmountExpr(args[2]?.text ?? "0u64");
  return {
    kind: "cpi_t22_transfer_fee_set_fee",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority: cleanAccountRef(authority),
    basisPoints,
    maximumFee,
    signerSeeds,
  };
}

// ─── Token-2022 ImmutableOwner extension init (EM2 Session 2) ───────────────
//
// Anchor source shape:
//   immutable_owner_initialize(CpiContext::new(
//       ctx.accounts.token_program.key(),
//       ImmutableOwnerInitialize {
//           token_program_id: ctx.accounts.token_program.to_account_info(),
//           token_account: ctx.accounts.token_account.to_account_info(),
//       },
//   ))?;
//
// Token-account-level extension (NOT mint-level). Single instruction,
// no manage CPIs.
function extractT22ImmutableOwnerInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 immutable_owner_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 immutable_owner_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let tokenAccount = "token_account";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    tokenAccount =
      extractStructField(accountsStruct, "token_account") ?? tokenAccount;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_immutable_owner_initialize",
    tokenAccount: cleanAccountRef(tokenAccount),
    tokenProgram: cleanAccountRef(tokenProgram),
    signerSeeds,
  };
}

// ─── Token-2022 MintCloseAuthority extension init (EM2 Session 1) ───────────
//
// Anchor source shape:
//   mint_close_authority_initialize(
//       CpiContext::new(
//           ctx.accounts.token_program.to_account_info(),
//           MintCloseAuthorityInitialize {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint.to_account_info(),
//           },
//       ),
//       Some(&ctx.accounts.payer.key()),  // Option<&Pubkey>
//   )?;
//
// Mint-level extension. The close-authority is Option<Pubkey>.
function extractT22MintCloseAuthorityInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 mint_close_authority_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 mint_close_authority_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const closeAuthority = args[1]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_mint_close_authority_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    closeAuthority,
    signerSeeds,
  };
}

// ─── Token-2022 PermanentDelegate extension init (EM2 Session 1) ────────────
//
// Anchor source shape:
//   permanent_delegate_initialize(
//       CpiContext::new(
//           ctx.accounts.token_program.to_account_info(),
//           PermanentDelegateInitialize {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint.to_account_info(),
//           },
//       ),
//       &ctx.accounts.payer.key(),  // &Pubkey (NOT Option)
//   )?;
//
// Mint-level extension. The delegate is a REQUIRED Pubkey.
function extractT22PermanentDelegateInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 permanent_delegate_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 permanent_delegate_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const delegate = args[1]?.text.trim() ?? "&Pubkey::default()";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_permanent_delegate_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    delegate,
    signerSeeds,
  };
}

// ─── Token-2022 TransferHook extension init (EM2 Session 2) ─────────────────
//
// Anchor source shape:
//   transfer_hook_initialize(
//       CpiContext::new(
//           ctx.accounts.token_program.to_account_info(),
//           TransferHookInitialize {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint.to_account_info(),
//           },
//       ),
//       Some(payer_key),                       // Option<Pubkey>
//       Some(transfer_hook_program_id_key),    // Option<Pubkey>
//   )?;
//
// Mint-level extension. Both authority and transfer_hook_program_id are
// OptionalNonZeroPubkey on the wire (flat 32 bytes per Option; all-zero
// = None). Different byte layout from MintCloseAuthority's COption.
function extractT22TransferHookInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 transfer_hook_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 transfer_hook_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const authority = args[1]?.text.trim() ?? "None";
  const transferHookProgramId = args[2]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_transfer_hook_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority,
    transferHookProgramId,
    signerSeeds,
  };
}

// ─── Token-2022 TransferHook extension update (EM2 Session 2) ───────────────
//
// Anchor source shape:
//   transfer_hook_update(
//       CpiContext::new(
//           ctx.accounts.token_program.to_account_info(),
//           TransferHookUpdate {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint.to_account_info(),
//               authority: ctx.accounts.authority.to_account_info(),
//           },
//       ),
//       Some(new_transfer_hook_program_id_key),  // Option<Pubkey>
//   )?;
//
// Single-authority signer required (multisig signers slot is exposed by
// raw spl_token_2022 but not by the anchor-spl wrapper).
function extractT22TransferHookUpdate(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 transfer_hook_update", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 transfer_hook_update (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let authority = "authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    authority =
      extractStructField(accountsStruct, "authority") ?? authority;
  }
  const transferHookProgramId = args[1]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_transfer_hook_update",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority: cleanAccountRef(authority),
    transferHookProgramId,
    signerSeeds,
  };
}

// ─── Token-2022 MetadataPointer extension init (EM2 Session 2) ──────────────
//
// Anchor source shape:
//   metadata_pointer_initialize(
//       CpiContext::new(
//           ctx.accounts.token_program.to_account_info(),
//           MetadataPointerInitialize {
//               token_program_id: ctx.accounts.token_program.to_account_info(),
//               mint: ctx.accounts.mint.to_account_info(),
//           },
//       ),
//       Some(authority_key),         // Option<Pubkey>
//       Some(metadata_account_key),  // Option<Pubkey>
//   )?;
//
// Mint-level extension. Both args use OptionalNonZeroPubkey wire layout.
//
// NOTE: anchor-spl 0.31 and 0.32 expose only the initialize wrapper for
// MetadataPointer — there is no `metadata_pointer_update` helper.
// Programs that need the raw `spl_token_2022::extension::metadata_pointer
// ::instruction::update` will hit pass_through. A typed IR kind for
// update can be added later if a real-world fixture surfaces it.
function extractT22MetadataPointerInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 metadata_pointer_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 metadata_pointer_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const authority = args[1]?.text.trim() ?? "None";
  const metadataAddress = args[2]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_metadata_pointer_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority,
    metadataAddress,
    signerSeeds,
  };
}

// ─── Token-2022 GroupPointer extension init/update (EM2 Session 3) ──────────
//
// Anchor source shapes (anchor_spl::token_2022_extensions::group_pointer):
//   group_pointer_initialize(ctx, authority: Option<Pubkey>, group_address: Option<Pubkey>)
//   group_pointer_update(ctx, group_address: Option<Pubkey>)
//
// Both use OptionalNonZeroPubkey wire layout (flat 32B per Option;
// all-zero = None). Parent disc 40 (TokenInstruction::GroupPointer-
// Extension), sub 0 = Initialize, sub 1 = Update.
//
// NOTE: anchor-spl 0.31 + 0.32 `group_pointer_update` is upstream-
// broken — passes `&[ctx.accounts.authority.key]` as signers but only
// forwards `[token_program_id, mint]` to invoke_signed, producing a
// 3-account ix with only 2 accounts available at runtime ("Instruction
// references an unknown account"). The companion
// `group_member_pointer_update` wrapper is correctly written. Our IR
// + emit for the update path is itself correct (verified via direct
// raw-CPI shape); the differential demo simply skips invoking
// `update_group_pointer` so the broken wrapper isn't exercised in
// byte-equal. If upstream ships a fix, extend the differential to
// exercise update.
function extractT22GroupPointerInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 group_pointer_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 group_pointer_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const authority = args[1]?.text.trim() ?? "None";
  const groupAddress = args[2]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_group_pointer_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority,
    groupAddress,
    signerSeeds,
  };
}

// ─── Token-2022 MetadataPointer update (E1 — EM2 closure) ───────────────────
//
// Mint-level extension. anchor-spl 0.31/0.32 doesn't expose a wrapper,
// but follow this detection convention for any source that wraps the
// raw spl_token_2022 call (custom helpers / future anchor-spl).
// Payload = single OptionalNonZeroPubkey (32 bytes).
function extractT22MetadataPointerUpdate(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 metadata_pointer_update", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 metadata_pointer_update (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let authority = "authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    authority =
      extractStructField(accountsStruct, "authority") ?? authority;
  }
  const metadataAddress = args[1]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_metadata_pointer_update",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority: cleanAccountRef(authority),
    metadataAddress,
    signerSeeds,
  };
}

function extractT22GroupPointerUpdate(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 group_pointer_update", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 group_pointer_update (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let authority = "authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    authority =
      extractStructField(accountsStruct, "authority") ?? authority;
  }
  const groupAddress = args[1]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_group_pointer_update",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority: cleanAccountRef(authority),
    groupAddress,
    signerSeeds,
  };
}

// ─── Token-2022 GroupMemberPointer init/update (EM2 Session 3) ──────────────
//
// Identical shape to GroupPointer, parent disc 41
// (TokenInstruction::GroupMemberPointerExtension).
function extractT22GroupMemberPointerInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 group_member_pointer_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 group_member_pointer_initialize (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const authority = args[1]?.text.trim() ?? "None";
  const memberAddress = args[2]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_group_member_pointer_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority,
    memberAddress,
    signerSeeds,
  };
}

function extractT22GroupMemberPointerUpdate(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 group_member_pointer_update", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 group_member_pointer_update (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let authority = "authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    authority =
      extractStructField(accountsStruct, "authority") ?? authority;
  }
  const memberAddress = args[1]?.text.trim() ?? "None";
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_group_member_pointer_update",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    authority: cleanAccountRef(authority),
    memberAddress,
    signerSeeds,
  };
}

// ─── Token-2022 TransferFee — transfer_checked_with_fee (EM2 1b) ────────────
//
// Anchor source shape:
//   transfer_checked_with_fee(
//       CpiContext::new(token_program, TransferCheckedWithFee {
//           token_program_id, source, mint, destination, authority,
//       }),
//       amount, decimals, fee,
//   )?;
function extractT22TransferCheckedWithFee(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 transfer_checked_with_fee", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 transfer_checked_with_fee (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let source = "source";
  let mint = "mint";
  let destination = "destination";
  let authority = "authority";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    source = extractStructField(accountsStruct, "source") ?? source;
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    destination = extractStructField(accountsStruct, "destination") ?? destination;
    authority = extractStructField(accountsStruct, "authority") ?? authority;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  const amount = cleanAmountExpr(args[1]?.text ?? "0u64");
  const decimals = cleanAmountExpr(args[2]?.text ?? "0u8");
  const fee = cleanAmountExpr(args[3]?.text ?? "0u64");
  return {
    kind: "cpi_t22_transfer_checked_with_fee",
    source: cleanAccountRef(source),
    mint: cleanAccountRef(mint),
    destination: cleanAccountRef(destination),
    authority: cleanAccountRef(authority),
    tokenProgram: cleanAccountRef(tokenProgram),
    amount,
    decimals,
    fee,
    signerSeeds,
  };
}

// ─── Token-2022 TransferFee — withdraw_withheld_tokens_from_mint (EM2 1b) ───
function extractT22WithdrawWithheldFromMint(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 withdraw_withheld_tokens_from_mint", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 withdraw_withheld_tokens_from_mint (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let destination = "destination";
  let authority = "authority";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    destination = extractStructField(accountsStruct, "destination") ?? destination;
    authority = extractStructField(accountsStruct, "authority") ?? authority;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  return {
    kind: "cpi_t22_withdraw_withheld_tokens_from_mint",
    mint: cleanAccountRef(mint),
    destination: cleanAccountRef(destination),
    authority: cleanAccountRef(authority),
    tokenProgram: cleanAccountRef(tokenProgram),
    signerSeeds,
  };
}

// ─── Token-2022 TransferFee — harvest_withheld_tokens_to_mint (EM2 1b) ──────
function extractT22HarvestWithheldToMint(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 harvest_withheld_tokens_to_mint", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(
      collector,
      "T22 harvest_withheld_tokens_to_mint (variable-bound CpiContext)",
      callNode,
    );
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram =
      extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text)
    : undefined;
  // Second arg = sources expression. Keep raw for the emit to consume
  // at runtime (Vec<AccountInfo> length isn't known at compile time).
  const sources = args[1]?.text.trim() ?? "&[]";
  return {
    kind: "cpi_t22_harvest_withheld_tokens_to_mint",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    sources,
    signerSeeds,
  };
}

// ─── Token-2022 DefaultAccountState init/update (EM2 Session 3) ─────────────
function extractT22DefaultAccountStateInit(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 default_account_state_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 default_account_state_initialize (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram = extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const state = args[1]?.text.trim() ?? "&AccountState::Initialized";
  return {
    kind: "cpi_t22_default_account_state_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    state,
    signerSeeds,
  };
}

function extractT22DefaultAccountStateUpdate(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 default_account_state_update", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 default_account_state_update (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let freezeAuthority = "freeze_authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram = extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    freezeAuthority = extractStructField(accountsStruct, "freeze_authority") ?? freezeAuthority;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const state = args[1]?.text.trim() ?? "&AccountState::Initialized";
  return {
    kind: "cpi_t22_default_account_state_update",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    freezeAuthority: cleanAccountRef(freezeAuthority),
    state,
    signerSeeds,
  };
}

// ─── Token-2022 InterestBearingMint init/update_rate (EM2 Session 3) ────────
function extractT22InterestBearingMintInit(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 interest_bearing_mint_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 interest_bearing_mint_initialize (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram = extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const rateAuthority = args[1]?.text.trim() ?? "None";
  const rate = cleanAmountExpr(args[2]?.text ?? "0i16");
  return {
    kind: "cpi_t22_interest_bearing_mint_initialize",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    rateAuthority,
    rate,
    signerSeeds,
  };
}

function extractT22InterestBearingMintUpdateRate(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 interest_bearing_mint_update_rate", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 interest_bearing_mint_update_rate (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let mint = "mint";
  let tokenProgram = "token_program";
  let rateAuthority = "rate_authority";
  if (accountsStruct) {
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    tokenProgram = extractStructField(accountsStruct, "token_program_id") ?? tokenProgram;
    rateAuthority = extractStructField(accountsStruct, "rate_authority") ?? rateAuthority;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const rate = cleanAmountExpr(args[1]?.text ?? "0i16");
  return {
    kind: "cpi_t22_interest_bearing_mint_update_rate",
    mint: cleanAccountRef(mint),
    tokenProgram: cleanAccountRef(tokenProgram),
    rateAuthority: cleanAccountRef(rateAuthority),
    rate,
    signerSeeds,
  };
}

// ─── Token-2022 TokenMetadata initialize (EM2 Session 4) ────────────────────
//
// Uses the spl-token-metadata-interface protocol layered on Token-2022.
// Anchor source shape:
//   token_metadata_initialize(
//       CpiContext::new(token_program, TokenMetadataInitialize {
//           token_program_id, mint, metadata, mint_authority, update_authority,
//       }),
//       name, symbol, uri,  // String args
//   )?;
function extractT22TokenMetadataInitialize(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 token_metadata_initialize", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 token_metadata_initialize (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let metadata = "metadata";
  let mint = "mint";
  let mintAuthority = "mint_authority";
  let updateAuthority = "update_authority";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    metadata = extractStructField(accountsStruct, "metadata") ?? metadata;
    mint = extractStructField(accountsStruct, "mint") ?? mint;
    mintAuthority = extractStructField(accountsStruct, "mint_authority") ?? mintAuthority;
    updateAuthority = extractStructField(accountsStruct, "update_authority") ?? updateAuthority;
    // anchor-spl 0.31 uses `program_id`; older versions used
    // `token_program_id`. Try both.
    tokenProgram =
      extractStructField(accountsStruct, "program_id") ??
      extractStructField(accountsStruct, "token_program_id") ??
      tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const name = args[1]?.text.trim() ?? `String::new()`;
  const symbol = args[2]?.text.trim() ?? `String::new()`;
  const uri = args[3]?.text.trim() ?? `String::new()`;
  return {
    kind: "cpi_t22_token_metadata_initialize",
    metadata: cleanAccountRef(metadata),
    mint: cleanAccountRef(mint),
    mintAuthority: cleanAccountRef(mintAuthority),
    updateAuthority: cleanAccountRef(updateAuthority),
    tokenProgram: cleanAccountRef(tokenProgram),
    name,
    symbol,
    uri,
    signerSeeds,
  };
}

// Anchor source shape:
//   token_metadata_update_field(
//       CpiContext::new(token_program, TokenMetadataUpdateField {
//           token_program_id, metadata, update_authority,
//       }),
//       field, value,
//   )?;
function extractT22TokenMetadataUpdateField(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 token_metadata_update_field", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 token_metadata_update_field (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let metadata = "metadata";
  let updateAuthority = "update_authority";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    metadata = extractStructField(accountsStruct, "metadata") ?? metadata;
    updateAuthority = extractStructField(accountsStruct, "update_authority") ?? updateAuthority;
    tokenProgram =
      extractStructField(accountsStruct, "program_id") ??
      extractStructField(accountsStruct, "token_program_id") ??
      tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const field = args[1]?.text.trim() ?? "";
  const value = args[2]?.text.trim() ?? "String::new()";
  return {
    kind: "cpi_t22_token_metadata_update_field",
    metadata: cleanAccountRef(metadata),
    updateAuthority: cleanAccountRef(updateAuthority),
    tokenProgram: cleanAccountRef(tokenProgram),
    field,
    value,
    signerSeeds,
  };
}

// Anchor source shape:
//   token_metadata_update_authority(
//       CpiContext::new(token_program, TokenMetadataUpdateAuthority {
//           token_program_id, metadata, current_authority, new_authority,
//       }),
//       new_authority_key,  // OptionalNonZeroPubkey
//   )?;
// new_authority is captured as the AccountInfo binding (the on-chain account
// that may or may not be the new authority); new_authority_key is the
// OptionalNonZeroPubkey value passed as the function arg. The Native target
// only uses new_authority_key (passes it to the spl helper); Pinocchio
// recognises literal `OptionalNonZeroPubkey::try_from(...)` patterns and
// emits the corresponding 32-byte payload.
function extractT22TokenMetadataUpdateAuthority(
  callNode: SyntaxNode,
  collector?: WarningCollector,
): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "T22 token_metadata_update_authority", callNode);
    return fallbackPassThrough(callNode);
  }
  const args = getArguments(argsNode);
  const firstArg = args[0];
  if (!firstArg || !firstArg.text.includes("CpiContext::")) {
    warnClassificationLost(collector, "T22 token_metadata_update_authority (var-bound CpiContext)", callNode);
    return fallbackPassThrough(callNode);
  }
  const accountsStruct = findDescendant(firstArg, "struct_expression");
  let metadata = "metadata";
  let currentAuthority = "current_authority";
  let tokenProgram = "token_program";
  if (accountsStruct) {
    metadata = extractStructField(accountsStruct, "metadata") ?? metadata;
    currentAuthority = extractStructField(accountsStruct, "current_authority") ?? currentAuthority;
    tokenProgram =
      extractStructField(accountsStruct, "program_id") ??
      extractStructField(accountsStruct, "token_program_id") ??
      tokenProgram;
  }
  const signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer("))
    ? extractSignerSeedsExpr(firstArg.text) : undefined;
  const newAuthority = args[1]?.text.trim() ?? "OptionalNonZeroPubkey::try_from(None)?";
  return {
    kind: "cpi_t22_token_metadata_update_authority",
    metadata: cleanAccountRef(metadata),
    currentAuthority: cleanAccountRef(currentAuthority),
    tokenProgram: cleanAccountRef(tokenProgram),
    newAuthority,
    signerSeeds,
  };
}

// ─── Associated Token Account Create ────────────────────────────────────────

function extractAtaCreate(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "associated_token::create", callNode);
    return fallbackPassThrough(callNode);
  }

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
    signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined;
  } else {
    // Raw native call: create_associated_token_account(payer, owner, mint, token_program)
    // — positional args, no Create struct to extract from. Bail to pass-through so
    // the user sees the original call rather than a broken stub.
    warnClassificationLost(collector, "associated_token::create (raw native positional form)", callNode);
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

function extractSystemTransfer(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode) {
    warnClassificationLost(collector, "system_program::transfer", callNode);
    return fallbackPassThrough(callNode);
  }

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
    signerSeeds = (firstArg.text.includes("new_with_signer") || firstArg.text.includes(".with_signer(")) ? extractSignerSeedsExpr(firstArg.text) : undefined;
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

function extractCustomCpi(callNode: SyntaxNode, collector?: WarningCollector): BodyStatement {
  const funcText = callNode.childForFieldName("function")?.text ?? "";
  const signerSeeds = funcText === "invoke_signed" ? "signer_seeds" : undefined;

  collector?.add({
    code: "cpi_custom_emitted",
    message: `Custom ${funcText}() CPI emitted as cpi_custom — manual review required to confirm account meta + instruction data carry over to the target framework.`,
    snippet: callNode.text,
    loc: locFromNode(callNode),
  });

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
  // Fluent form: `CpiContext::new(prog, accs).with_signer(seeds)`.
  // Detect first since it's the simpler shape and the more common
  // pattern in real Anchor source (pda-mint-authority and most
  // Metaplex-CPI fixtures from solana-developers use this).
  const fluentIdx = firstArgText.indexOf(".with_signer(");
  if (fluentIdx !== -1) {
    const start = fluentIdx + ".with_signer(".length;
    let depth = 0;
    let end = -1;
    for (let i = start; i < firstArgText.length; i++) {
      const ch = firstArgText[i];
      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
        if (depth === 0) { end = i; break; }
        depth--;
      }
    }
    if (end > start) {
      const expr = firstArgText.slice(start, end).trim().replace(/,\s*$/, "");
      return expr.length > 0 ? expr : "signer_seeds";
    }
  }
  // Legacy form: `CpiContext::new_with_signer(prog, accs, seeds)`.
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
  let expr = firstArgText.slice(args[2]!, args[3]!).trim().replace(/,\s*$/, "");
  if (/^&\s*signer_seeds\s*$/.test(expr)) {
    expr = "signer_seeds";
  }
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
