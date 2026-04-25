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
type CpiAtaCreate = Extract<BodyStatement, { kind: "cpi_ata_create" }>;
type CpiMemo = Extract<BodyStatement, { kind: "cpi_memo" }>;
type CpiCustom = Extract<BodyStatement, { kind: "cpi_custom" }>;

function shouldEmitSignerSeedsPrelude(w: BodyWalker, signerSeeds: string | undefined): boolean {
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
      stmt.signerSeeds,
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
      stmt.signerSeeds,
      {
        tokenProgram: stmt.tokenProgram,
        ...(stmt.mint ? { mint: snakeCase(stmt.mint) } : {}),
        ...(stmt.decimals ? { decimals: stmt.decimals } : {}),
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
      stmt.signerSeeds,
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
      stmt.signerSeeds,
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
      stmt.signerSeeds,
      { tokenProgram: stmt.tokenProgram },
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
      stmt.signerSeeds,
    ),
  );
}

export function handleCpiMemo(w: BodyWalker, stmt: CpiMemo): void {
  w.ctx.transformedCount++;
  w.ctx.details.push(`Transformed: spl_memo::build_memo`);
  w.lines.push(w.emitter.emitMemo(stmt.data));
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
