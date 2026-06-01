/**
 * #20 — resolve the SPL transfer-hook interface discriminators.
 *
 * Transfer-hook programs declare their interface handlers with
 * `#[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]`
 * (and the InitializeExtraAccountMetaList / UpdateExtraAccountMetaList variants).
 * These are EXTERNAL-crate consts whose definition Anvil can't see, so they
 * couldn't resolve as local const refs → the router fell back to
 * sha256("global:<fn>")[..8]. That fallback COMPILES CLEAN (0 validator errors)
 * but dispatches on the WRONG discriminator — a SILENT misroute that makes the
 * hook non-functional.
 *
 * Fix: the SPL discriminator scheme is fixed and public — SplDiscriminate derives
 * the 8-byte slice as sha256(<discriminator_hash_input>)[..8]
 * (spl-discriminator-0.5.2). The three transfer-hook interface structs' hash
 * inputs are read verbatim from spl-transfer-hook-interface-0.9.0. So the
 * discriminator resolves correctly, by construction, with no guessing — and any
 * UNKNOWN `<Struct>::SPL_DISCRIMINATOR_SLICE` still falls through to the existing
 * loud unresolved-discriminator warning (never a guessed namespace).
 *
 * Scope: this fixes DISPATCH. Transfer-hook program BODIES (spl-tlv-account-
 * resolution / extra-account-meta machinery) remain unsupported and still
 * loud-refuse — fixing dispatch does not unblock the whole transfer-hook class.
 */
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { resolveDiscriminatorRhs } from "../src/parser/account-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";

// Independent reference: sha256(namespace)[..8] — NOT via Anvil's resolver.
const ref = (ns: string) => [...createHash("sha256").update(ns).digest().subarray(0, 8)];

describe("#20 — SPL transfer-hook interface discriminator resolution", () => {
  test("resolves the three known interface structs to the grounded bytes", () => {
    expect(resolveDiscriminatorRhs("ExecuteInstruction::SPL_DISCRIMINATOR_SLICE"))
      .toEqual(ref("spl-transfer-hook-interface:execute"));
    expect(resolveDiscriminatorRhs("InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE"))
      .toEqual(ref("spl-transfer-hook-interface:initialize-extra-account-metas"));
    expect(resolveDiscriminatorRhs("UpdateExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE"))
      .toEqual(ref("spl-transfer-hook-interface:update-extra-account-metas"));
  });

  test("Execute discriminator equals the canonical [105,37,101,197,75,251,102,26]", () => {
    // Cross-check against the published SPL transfer-hook Execute discriminator.
    expect(resolveDiscriminatorRhs("ExecuteInstruction::SPL_DISCRIMINATOR_SLICE"))
      .toEqual([105, 37, 101, 197, 75, 251, 102, 26]);
  });

  test("fully-qualified path + the non-SLICE const form both resolve", () => {
    const exp = ref("spl-transfer-hook-interface:execute");
    expect(resolveDiscriminatorRhs(
      "spl_transfer_hook_interface::instruction::ExecuteInstruction::SPL_DISCRIMINATOR_SLICE",
    )).toEqual(exp);
    expect(resolveDiscriminatorRhs("ExecuteInstruction::SPL_DISCRIMINATOR")).toEqual(exp);
  });

  test("UNKNOWN struct falls through to undefined (loud-by-default preserved)", () => {
    expect(resolveDiscriminatorRhs("FooInstruction::SPL_DISCRIMINATOR_SLICE")).toBeUndefined();
    expect(resolveDiscriminatorRhs("Bar::SPL_DISCRIMINATOR")).toBeUndefined();
  });

  test("end-to-end: warning gone + router dispatches on the real discriminator", async () => {
    const SRC = `
use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
declare_id!("Hook1111111111111111111111111111111111111111");
#[program]
pub mod hook {
    use super::*;
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: hook source
    pub source: AccountInfo<'info>,
    /// CHECK: hook mint
    pub mint: AccountInfo<'info>,
    /// CHECK: hook destination
    pub destination: AccountInfo<'info>,
    /// CHECK: hook owner
    pub owner: AccountInfo<'info>,
    /// CHECK: extra metas
    pub extra_account_meta_list: AccountInfo<'info>,
}
`;
    const r = await parseAnchor(SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The silent-misroute warning is gone (the override now resolves).
    expect(r.ir.warnings.filter((w) => /discriminator_override_unsupported/.test(w.code ?? "")))
      .toEqual([]);
    const ix = r.ir.instructions.find((i) => i.name === "execute") as unknown as {
      discriminator?: string; customDiscriminator?: { bytes: number[] };
    };
    expect(ix?.customDiscriminator?.bytes).toEqual([105, 37, 101, 197, 75, 251, 102, 26]);
    // The emitted router dispatches on the resolved bytes (not sha256("global:execute")).
    const out = emitPinocchioFull(r.ir);
    expect(/105\s*,\s*37\s*,\s*101\s*,\s*197\s*,\s*75\s*,\s*251\s*,\s*102\s*,\s*26/.test(out.singleFile)).toBe(true);
  });
});
