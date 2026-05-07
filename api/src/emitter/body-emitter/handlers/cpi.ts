/**
 * CPI handlers — typed CPIs (cpi_system_transfer, cpi_spl_*) plus the
 * pass-through cpi_custom which preserves the original Rust block.
 */

import type { BodyStatement } from "../../../ir/schema.js";
import { snakeCase } from "../../emitter-utils.js";
import type { BodyWalker } from "../walker.js";

type CpiSystemTransfer = Extract<BodyStatement, { kind: "cpi_system_transfer" }>;
type CpiSplTransfer = Extract<BodyStatement, { kind: "cpi_spl_transfer" }>;
type CpiSplMintTo = Extract<BodyStatement, { kind: "cpi_spl_mint_to" }>;
type CpiSplBurn = Extract<BodyStatement, { kind: "cpi_spl_burn" }>;
type CpiSplCloseAccount = Extract<BodyStatement, { kind: "cpi_spl_close_account" }>;
type CpiSplSetAuthority = Extract<BodyStatement, { kind: "cpi_spl_set_authority" }>;
type CpiT22NonTransferableMintInit = Extract<BodyStatement, { kind: "cpi_t22_non_transferable_mint_initialize" }>;
type CpiT22TransferFeeInit = Extract<BodyStatement, { kind: "cpi_t22_transfer_fee_initialize" }>;
type CpiT22TransferFeeSetFee = Extract<BodyStatement, { kind: "cpi_t22_transfer_fee_set_fee" }>;
type CpiT22ImmutableOwnerInit = Extract<BodyStatement, { kind: "cpi_t22_immutable_owner_initialize" }>;
type CpiT22TransferCheckedWithFee = Extract<BodyStatement, { kind: "cpi_t22_transfer_checked_with_fee" }>;
type CpiT22WithdrawWithheldFromMint = Extract<BodyStatement, { kind: "cpi_t22_withdraw_withheld_tokens_from_mint" }>;
type CpiT22HarvestWithheldToMint = Extract<BodyStatement, { kind: "cpi_t22_harvest_withheld_tokens_to_mint" }>;
type CpiT22DefaultAccountStateInit = Extract<BodyStatement, { kind: "cpi_t22_default_account_state_initialize" }>;
type CpiT22DefaultAccountStateUpdate = Extract<BodyStatement, { kind: "cpi_t22_default_account_state_update" }>;
type CpiT22InterestBearingMintInit = Extract<BodyStatement, { kind: "cpi_t22_interest_bearing_mint_initialize" }>;
type CpiT22InterestBearingMintUpdateRate = Extract<BodyStatement, { kind: "cpi_t22_interest_bearing_mint_update_rate" }>;
type CpiAtaCreate = Extract<BodyStatement, { kind: "cpi_ata_create" }>;
type CpiMemo = Extract<BodyStatement, { kind: "cpi_memo" }>;
type CpiCustom = Extract<BodyStatement, { kind: "cpi_custom" }>;
type CpiMplCreateMetadataV3 = Extract<BodyStatement, { kind: "cpi_mpl_create_metadata_v3" }>;
type CpiMplCreateMasterEditionV3 = Extract<BodyStatement, { kind: "cpi_mpl_create_master_edition_v3" }>;

export function shouldEmitSignerSeedsPrelude(w: BodyWalker, signerSeeds: string | undefined): boolean {
  if (!signerSeeds) return false;
  // The prelude generates a standardized `let seeds = &[…]; let signer_seeds
  // = &[&seeds[..]];` block tailored to the legacy default var name. When
  // the IR carries a user-defined name (extracted from
  // `CpiContext::new_with_signer(_, _, &signers_seeds)`), the user already
  // has those bindings in scope — emitting our prelude would shadow `seeds`
  // and produce E0716 lifetime errors on the synthesized seeds list.
  const isLegacyDefault = signerSeeds === "signer_seeds";
  if (!isLegacyDefault) return false;
  return !(isLegacyDefault && w.signerSeedsInScope);
}

/**
 * Resolve the actual signer-seeds expression to pass to the framework's CPI
 * builder.
 *
 * The IR captures the source-level identifier (e.g. `&[vault_seeds]` from
 * Anchor's `CpiContext::new_with_signer(_, _, &[vault_seeds])`). But the
 * source's `let vault_seeds = &[...]` binding is consumed by the CPI
 * consolidator pre-pass and never makes it to the emitted body — meanwhile
 * the typed `pda_signer_seeds` handler emits a fresh
 * `let seeds = ...; let signer_seeds = ...` block with hardcoded names.
 * Result: the user-defined identifier is dangling at the CPI call site
 * (E0425 cannot find value `vault_seeds`).
 *
 * Fix: when the typed pda_signer_seeds block has fired (signerSeedsInScope),
 * override the IR's source-level name with the prelude's `signer_seeds`
 * variable. The legacy default `signer_seeds` already maps to itself.
 */
export function resolveSignerSeedsExpr(w: BodyWalker, signerSeeds: string | undefined): string | undefined {
  if (!signerSeeds) return signerSeeds;
  // Already the canonical name — pass through.
  if (signerSeeds === "signer_seeds") return signerSeeds;
  // The typed pda_signer_seeds handler has emitted `let signer_seeds = ...`
  // already; rewrite the IR's source-level reference (e.g. `&[vault_seeds]`,
  // `&[fee_vault_seeds]`) to point at it.
  if (w.signerSeedsInScope) return "signer_seeds";
  // Inline literal signer-seeds — `&[&[ctx.accounts.X.key().as_ref(),
  // &[ctx.bumps.Y]]]` style — appears when the source uses
  // `CpiContext::new_with_signer(prog, accounts, &[&[...]])` with the seeds
  // built inline rather than via a `let X_seeds = ...;` binding. The IR
  // captures the verbatim text. Pass it through transformCtxAccountsReferences
  // and replaceBumpRefs so ctx.accounts.X / ctx.bumps.Y become the local
  // AccountInfo / bump_X identifiers the rest of the emit uses. Only fires
  // on signerSeeds expressions that contain literal `ctx.accounts` /
  // `ctx.bumps` patterns — non-literal variable references aren't touched.
  if (/\bctx\.accounts\b|\bctx\.bumps\b/.test(signerSeeds)) {
    const { code: transformedSeeds } = w.replaceBumpRefs(
      w.transformCtxAccountsReferences(signerSeeds),
    );
    return transformedSeeds;
  }
  // No prelude in scope and a non-default name — leave it alone. This is the
  // case the original prelude-skip logic was protecting.
  return signerSeeds;
}

export function handleCpiSystemTransfer(w: BodyWalker, stmt: CpiSystemTransfer): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: system_program::transfer(${stmt.from} → ${stmt.to})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.from)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitSystemTransfer(
      snakeCase(stmt.from),
      snakeCase(stmt.to),
      w.resolveAmountExpr(stmt.amount),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiSplTransfer(w: BodyWalker, stmt: CpiSplTransfer): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: token::transfer(${stmt.from} → ${stmt.to})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  const authority = stmt.signerSeeds
    ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
    : snakeCase(stmt.authority);
  w.lines.push(
    w.emitter.emitSplTransfer(
      snakeCase(stmt.from),
      snakeCase(stmt.to),
      authority,
      w.resolveAmountExpr(stmt.amount),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.mint ? { mint: snakeCase(stmt.mint) } : {}),
        ...(stmt.decimals ? { decimals: stmt.decimals } : {}),
        // Runtime program-ID dispatch (TokenInterface). When set, the
        // emit reads <tokenProgramArg>.key() instead of a hardcoded
        // const program ID at the invoke site.
        ...(stmt.tokenProgramArg ? { tokenProgramArg: snakeCase(stmt.tokenProgramArg) } : {}),
      },
    ),
  );
}

export function handleCpiSplMintTo(w: BodyWalker, stmt: CpiSplMintTo): void {
  w.ctx.transformedCount++;
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  const authority = stmt.signerSeeds
    ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
    : snakeCase(stmt.authority);
  w.lines.push(
    w.emitter.emitSplMintTo(
      snakeCase(stmt.mint),
      snakeCase(stmt.to),
      authority,
      w.resolveAmountExpr(stmt.amount),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.decimals ? { decimals: stmt.decimals } : {}),
      },
    ),
  );
}

export function handleCpiSplBurn(w: BodyWalker, stmt: CpiSplBurn): void {
  w.ctx.transformedCount++;
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  const authority = stmt.signerSeeds
    ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
    : snakeCase(stmt.authority);
  w.lines.push(
    w.emitter.emitSplBurn(
      snakeCase(stmt.from),
      snakeCase(stmt.mint),
      authority,
      w.resolveAmountExpr(stmt.amount),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.decimals ? { decimals: stmt.decimals } : {}),
      },
    ),
  );
}

export function handleCpiSplCloseAccount(w: BodyWalker, stmt: CpiSplCloseAccount): void {
  w.ctx.transformedCount++;
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  const authority = stmt.signerSeeds
    ? w.resolveAccountInfoVar(snakeCase(stmt.authority))
    : snakeCase(stmt.authority);
  w.lines.push(
    w.emitter.emitSplCloseAccount(
      snakeCase(stmt.account),
      snakeCase(stmt.destination),
      authority,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      { tokenProgram: stmt.tokenProgram },
    ),
  );
}

export function handleCpiSplSetAuthority(w: BodyWalker, stmt: CpiSplSetAuthority): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(
    `Transformed: token::set_authority(${stmt.account}, ${stmt.authorityType})`,
  );
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.currentAuthority)) {
      w.lines.push(preludeLine);
    }
  }
  const currentAuthority = stmt.signerSeeds
    ? w.resolveAccountInfoVar(snakeCase(stmt.currentAuthority))
    : snakeCase(stmt.currentAuthority);
  w.lines.push(
    w.emitter.emitSplSetAuthority(
      snakeCase(stmt.account),
      currentAuthority,
      stmt.authorityType,
      stmt.newAuthority,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
      { tokenProgram: stmt.tokenProgram },
    ),
  );
}

export function handleCpiT22NonTransferableMintInit(
  w: BodyWalker,
  stmt: CpiT22NonTransferableMintInit,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: non_transferable_mint_initialize(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.mint)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22NonTransferableMintInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22TransferFeeInit(
  w: BodyWalker,
  stmt: CpiT22TransferFeeInit,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: transfer_fee_initialize(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.mint)) {
      w.lines.push(preludeLine);
    }
  }
  // Authority expressions reference Anchor-side ctx.accounts.X.key();
  // run them through the same passes the body emitter uses for typed
  // CPI value args so they resolve to the local AccountInfo bindings.
  const tfca = w.transformCtxAccountsReferences(stmt.transferFeeConfigAuthority);
  const wwa = w.transformCtxAccountsReferences(stmt.withdrawWithheldAuthority);
  w.lines.push(
    w.emitter.emitT22TransferFeeInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      tfca,
      wwa,
      stmt.basisPoints,
      stmt.maximumFee,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22TransferCheckedWithFee(
  w: BodyWalker,
  stmt: CpiT22TransferCheckedWithFee,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: transfer_checked_with_fee(${stmt.source} -> ${stmt.destination})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22TransferCheckedWithFee(
      snakeCase(stmt.source),
      snakeCase(stmt.mint),
      snakeCase(stmt.destination),
      snakeCase(stmt.authority),
      snakeCase(stmt.tokenProgram),
      stmt.amount,
      stmt.decimals,
      stmt.fee,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22WithdrawWithheldFromMint(
  w: BodyWalker,
  stmt: CpiT22WithdrawWithheldFromMint,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: withdraw_withheld_tokens_from_mint(${stmt.mint} -> ${stmt.destination})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22WithdrawWithheldFromMint(
      snakeCase(stmt.mint),
      snakeCase(stmt.destination),
      snakeCase(stmt.authority),
      snakeCase(stmt.tokenProgram),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22HarvestWithheldToMint(
  w: BodyWalker,
  stmt: CpiT22HarvestWithheldToMint,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: harvest_withheld_tokens_to_mint(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.mint)) {
      w.lines.push(preludeLine);
    }
  }
  // sources expression may reference ctx.accounts.X / ctx.remaining_accounts;
  // run through the same passes the body emitter uses for value args.
  const sourcesResolved = w.transformCtxAccountsReferences(stmt.sources);
  w.lines.push(
    w.emitter.emitT22HarvestWithheldToMint(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      sourcesResolved,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22DefaultAccountStateInit(
  w: BodyWalker,
  stmt: CpiT22DefaultAccountStateInit,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: default_account_state_initialize(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.mint)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22DefaultAccountStateInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      stmt.state,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22DefaultAccountStateUpdate(
  w: BodyWalker,
  stmt: CpiT22DefaultAccountStateUpdate,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: default_account_state_update(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.freezeAuthority)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22DefaultAccountStateUpdate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.freezeAuthority),
      stmt.state,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22InterestBearingMintInit(
  w: BodyWalker,
  stmt: CpiT22InterestBearingMintInit,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: interest_bearing_mint_initialize(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.mint)) {
      w.lines.push(preludeLine);
    }
  }
  // Rate-authority arg may reference ctx.accounts.X.key().
  const rateAuth = w.transformCtxAccountsReferences(stmt.rateAuthority);
  w.lines.push(
    w.emitter.emitT22InterestBearingMintInitialize(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      rateAuth,
      stmt.rate,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22InterestBearingMintUpdateRate(
  w: BodyWalker,
  stmt: CpiT22InterestBearingMintUpdateRate,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: interest_bearing_mint_update_rate(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.rateAuthority)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22InterestBearingMintUpdateRate(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.rateAuthority),
      stmt.rate,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22ImmutableOwnerInit(
  w: BodyWalker,
  stmt: CpiT22ImmutableOwnerInit,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: immutable_owner_initialize(${stmt.tokenAccount})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.tokenAccount)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22ImmutableOwnerInitialize(
      snakeCase(stmt.tokenAccount),
      snakeCase(stmt.tokenProgram),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiT22TransferFeeSetFee(
  w: BodyWalker,
  stmt: CpiT22TransferFeeSetFee,
): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: transfer_fee_set(${stmt.mint})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.authority)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitT22TransferFeeSetFee(
      snakeCase(stmt.mint),
      snakeCase(stmt.tokenProgram),
      snakeCase(stmt.authority),
      stmt.basisPoints,
      stmt.maximumFee,
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiAtaCreate(w: BodyWalker, stmt: CpiAtaCreate): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: associated_token::create(${stmt.ata})`);
  if (shouldEmitSignerSeedsPrelude(w, stmt.signerSeeds)) {
    for (const preludeLine of w.ensureSignerSeedsForAccount(stmt.payer)) {
      w.lines.push(preludeLine);
    }
  }
  w.lines.push(
    w.emitter.emitCreateAta(
      snakeCase(stmt.ata),
      snakeCase(stmt.payer),
      snakeCase(stmt.mint),
      snakeCase(stmt.authority),
      resolveSignerSeedsExpr(w, stmt.signerSeeds),
    ),
  );
}

export function handleCpiMemo(w: BodyWalker, stmt: CpiMemo): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: spl_memo::build_memo`);
  w.lines.push(w.emitter.emitMemo(stmt.data));
}

/**
 * Metaplex create_metadata_accounts_v3 — typed stub emit (#29).
 *
 * The full Metaplex catalog (12 instructions + per-target real CPI emit
 * + 4 differential fixtures) is grant-M3 / ~5-week scope. Until then,
 * this handler emits a STRUCTURED stub: the user sees every account
 * binding + DataV2 field broken out by name, ready to wire into a
 * hand-rolled mpl_token_metadata::cpi:: call. Strictly better than the
 * old text-regex stub: the IR carried the parsed fields, so the comment
 * uses the user's actual variable names rather than placeholders.
 */
export function handleCpiMplCreateMetadataV3(w: BodyWalker, stmt: CpiMplCreateMetadataV3): void {
  w.ctx.transformedCount++;
  w.ctx.warnings.push(
    `Metaplex create_metadata_accounts_v3 emitted as structured stub — see TODO(manual) in output for the field map.`,
  );
  const lines = [
    `    // ⚠️ Anvil: Metaplex create_metadata_accounts_v3 CPI — manual rebuild required`,
    `    // Anvil parsed the call into these typed fields:`,
    `    //   metadata          = ${stmt.metadata}`,
    `    //   mint              = ${stmt.mint}`,
    `    //   mint_authority    = ${stmt.mintAuthority}`,
    `    //   payer             = ${stmt.payer}`,
    `    //   update_authority  = ${stmt.updateAuthority}`,
    `    //   name              = ${stmt.name}`,
    `    //   symbol            = ${stmt.symbol}`,
    `    //   uri               = ${stmt.uri}`,
    `    //   seller_fee_bps    = ${stmt.sellerFeeBasisPoints}`,
    `    //   is_mutable        = ${stmt.isMutable}`,
    `    //   update_auth_signer= ${stmt.updateAuthorityIsSigner}`,
    `    // TODO(manual): rebuild against mpl_token_metadata for ${w.emitter.frameworkName}.`,
    `    //   Add 'mpl-token-metadata' to Cargo.toml on Native; pinocchio`,
    `    //   need a hand-rolled invoke against the Token Metadata program ID.`,
    `    //   See N1-DEDUP-DESIGN-NOTE for the per-target vocab pattern.`,
  ];
  for (const line of lines) w.lines.push(line);
}

/**
 * Metaplex create_master_edition_v3 — typed stub emit (#29).
 * Same shape as the create_metadata_v3 handler; field map differs.
 */
export function handleCpiMplCreateMasterEditionV3(w: BodyWalker, stmt: CpiMplCreateMasterEditionV3): void {
  w.ctx.transformedCount++;
  w.ctx.warnings.push(
    `Metaplex create_master_edition_v3 emitted as structured stub — see TODO(manual) in output for the field map.`,
  );
  const lines = [
    `    // ⚠️ Anvil: Metaplex create_master_edition_v3 CPI — manual rebuild required`,
    `    // Anvil parsed the call into these typed fields:`,
    `    //   edition           = ${stmt.edition}`,
    `    //   mint              = ${stmt.mint}`,
    `    //   mint_authority    = ${stmt.mintAuthority}`,
    `    //   payer             = ${stmt.payer}`,
    `    //   metadata          = ${stmt.metadata}`,
    `    //   update_authority  = ${stmt.updateAuthority}`,
    `    //   max_supply        = ${stmt.maxSupply}`,
    `    // TODO(manual): rebuild against mpl_token_metadata for ${w.emitter.frameworkName}.`,
  ];
  for (const line of lines) w.lines.push(line);
}

export function handleCpiCustom(w: BodyWalker, stmt: CpiCustom): void {
  w.ctx.transformedCount++;
  w.ctx.warnings.push(
    `Custom CPI to '${stmt.programAccount}' — passed through as raw code. Verify framework compatibility.`,
  );
  // Apply ctx.bumps and ctx.accounts transforms to the raw CPI code.
  const { prelude: cpiPrelude, code: cpiCode } = w.replaceBumpRefs(stmt.rawCode);
  let transformedCpiCode = w.normalizeKeyValueUsages(
    w.transformAccountReferences(
      w.transformCtxAccountsReferences(w.transformNestedAnchorCode(cpiCode)),
    ),
  );
  if (w.emitter.frameworkName !== "Native") {
    transformedCpiCode = transformedCpiCode.replace(/\.to_account_info\(\)/g, "");
  }
  for (const preludeLine of cpiPrelude) {
    w.lines.push(preludeLine);
  }
  w.lines.push(`    // ⚠️ Anvil: Custom CPI — verify this works with ${w.emitter.frameworkName}`);
  w.lines.push(`    ${transformedCpiCode}`);
}
