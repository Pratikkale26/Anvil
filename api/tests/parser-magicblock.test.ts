/**
 * MagicBlock Ephemeral Rollups — parser + pre-parse expansion coverage.
 *
 * Verifies against ephemeral-rollups-sdk 0.16.2 semantics:
 *   - #[delegate]/#[commit]/#[ephemeral] textual expansions (companion
 *     accounts, magic_program/magic_context injection, synthesized
 *     process_undelegation callback)
 *   - typed IR lowering of delegate_<field>() / commit_accounts /
 *     MagicIntentBundleBuilder chains / undelegate_account
 *   - the process_undelegation discriminator equals the delegation
 *     program's EXTERNAL_UNDELEGATE_DISCRIMINATOR (sha256(
 *     "global:process_undelegation")[..8] == [196,28,41,206,48,37,51,167])
 *   - loud refuse (magicblock_unsupported) for out-of-catalog constructs
 *   - byte-neutrality: non-MagicBlock sources pass through the pre-parse
 *     expansion untouched
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { expandMagicBlockMacros } from "../src/parser/magicblock-preparse.ts";
import { detectMagicBlockResidualCpi } from "../src/parser/ast-helpers.ts";
import { SolanaIRSchema, type BodyStatement, type SolanaIR } from "../src/ir/schema.ts";

const DEMO = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "magicblock-counter.rs"),
  "utf-8",
);

async function parseDemo() {
  const r = await parseAnchor(DEMO);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.ir;
}

describe("MagicBlock pre-parse expansion", () => {
  test("non-MagicBlock source is byte-identical through the expansion", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "demo-programs", "counter.rs"),
      "utf-8",
    );
    const out = expandMagicBlockMacros(src);
    expect(out.sawMagicBlock).toBe(false);
    expect(out.source).toBe(src);
  });

  test("expansion is flagged and attributes are consumed", () => {
    const out = expandMagicBlockMacros(DEMO);
    expect(out.sawMagicBlock).toBe(true);
    expect(out.sawEphemeral).toBe(true);
    expect(out.sawDelegate).toBe(true);
    expect(out.sawCommit).toBe(true);
    expect(out.unsupported).toEqual([]);
    // Line-anchored: the demo's header comment mentions the attribute names,
    // which the expansion deliberately leaves untouched.
    expect(out.source).not.toMatch(/^[ \t]*#\[\s*ephemeral\s*\]/m);
    expect(out.source).not.toMatch(/^[ \t]*#\[\s*delegate\s*\]/m);
    expect(out.source).not.toMatch(/^[ \t]*#\[\s*commit\s*\]/m);
    // del marker stripped from the pda field, attribute still mut
    expect(out.source).not.toMatch(/#\[account\([^\]]*\bdel\b/);
    // vendored program-id consts appended
    expect(out.source).toContain("pub const MAGICBLOCK_DELEGATION_PROGRAM_ID: Pubkey");
    expect(out.source).toContain("pub const MAGICBLOCK_MAGIC_PROGRAM_ID: Pubkey");
    expect(out.source).toContain("pub const MAGICBLOCK_MAGIC_CONTEXT_ID: Pubkey");
  });

  test("#[ephemeral_accounts] / #[action] are reported as unsupported", () => {
    const src = `use ephemeral_rollups_sdk::anchor::ephemeral;\n#[ephemeral_accounts]\npub struct X {}\n`;
    const out = expandMagicBlockMacros(src);
    expect(out.unsupported).toContain("#[ephemeral_accounts]");
  });
});

describe("MagicBlock parser lowering", () => {
  test("all six instructions parse, including the injected callback", async () => {
    const ir = await parseDemo();
    expect(ir.instructions.map((i) => i.name)).toEqual([
      "initialize", "increment", "delegate", "commit",
      "increment_and_undelegate", "process_undelegation",
    ]);
  });

  test("#[delegate] expansion injects companion + tail accounts in macro order", async () => {
    const ir = await parseDemo();
    const dele = ir.instructions.find((i) => i.name === "delegate")!;
    expect(dele.accounts.map((a) => a.name)).toEqual([
      "payer",
      "buffer_pda", "delegation_record_pda", "delegation_metadata_pda", "pda",
      "owner_program", "delegation_program", "system_program",
    ]);
  });

  test("#[commit] expansion injects magic_program + magic_context", async () => {
    const ir = await parseDemo();
    const commit = ir.instructions.find((i) => i.name === "commit")!;
    const names = commit.accounts.map((a) => a.name);
    expect(names).toContain("magic_program");
    expect(names).toContain("magic_context");
  });

  test("delegate_pda() lowers to cpi_magicblock_delegate with derived companions", async () => {
    const ir = await parseDemo();
    const stmt = ir.instructions
      .find((i) => i.name === "delegate")!
      .body.find((s) => s.kind === "cpi_magicblock_delegate") as Extract<BodyStatement, { kind: "cpi_magicblock_delegate" }>;
    expect(stmt).toBeDefined();
    expect(stmt.pda).toBe("pda");
    expect(stmt.payer).toBe("payer");
    expect(stmt.buffer).toBe("buffer_pda");
    expect(stmt.delegationRecord).toBe("delegation_record_pda");
    expect(stmt.delegationMetadata).toBe("delegation_metadata_pda");
    expect(stmt.seedsExpr).toBe("&[COUNTER_SEED]");
    // DelegateConfig::default() → both config fields default
    expect(stmt.commitFrequencyMs).toBeUndefined();
    expect(stmt.validator).toBeUndefined();
  });

  test("commit_accounts (5-arg) lowers to cpi_magicblock_commit", async () => {
    const ir = await parseDemo();
    const stmt = ir.instructions
      .find((i) => i.name === "commit")!
      .body.find((s) => s.kind === "cpi_magicblock_commit") as Extract<BodyStatement, { kind: "cpi_magicblock_commit" }>;
    expect(stmt).toBeDefined();
    expect(stmt.accounts).toEqual(["counter"]);
    expect(stmt.undelegate).toBe(false);
    expect(stmt.viaIntentBundle).toBeUndefined();
    expect(stmt.magicFeeVault).toBeUndefined();
  });

  test("MagicIntentBundleBuilder chain lowers with undelegate + viaIntentBundle + downgrade warning", async () => {
    const ir = await parseDemo();
    const stmt = ir.instructions
      .find((i) => i.name === "increment_and_undelegate")!
      .body.find((s) => s.kind === "cpi_magicblock_commit") as Extract<BodyStatement, { kind: "cpi_magicblock_commit" }>;
    expect(stmt).toBeDefined();
    expect(stmt.undelegate).toBe(true);
    expect(stmt.viaIntentBundle).toBe(true);
    expect(ir.warnings?.some((w) => w.code === "magicblock_intent_bundle_downgraded")).toBe(true);
  });

  test("process_undelegation carries cpi_magicblock_undelegate + Vec<Vec<u8>> arg", async () => {
    const ir = await parseDemo();
    const undel = ir.instructions.find((i) => i.name === "process_undelegation")!;
    expect(undel.args).toEqual([{ name: "account_seeds", type: "Vec<Vec<u8>>" }]);
    const stmt = undel.body.find((s) => s.kind === "cpi_magicblock_undelegate") as Extract<BodyStatement, { kind: "cpi_magicblock_undelegate" }>;
    expect(stmt.baseAccount).toBe("base_account");
    expect(stmt.buffer).toBe("buffer");
    expect(stmt.seedsArg).toBe("account_seeds");
  });

  test("process_undelegation anchor discriminator == EXTERNAL_UNDELEGATE_DISCRIMINATOR", () => {
    const disc = createHash("sha256").update("global:process_undelegation").digest().subarray(0, 8);
    expect(Array.from(disc)).toEqual([196, 28, 41, 206, 48, 37, 51, 167]);
  });

  test("magicblock IR kinds survive a JSON roundtrip", async () => {
    const ir = await parseDemo();
    const again = SolanaIRSchema.parse(JSON.parse(JSON.stringify(ir))) as SolanaIR;
    const kinds = (x: SolanaIR) => x.instructions.map((i) => i.body.map((s) => s.kind));
    expect(kinds(again)).toEqual(kinds(ir));
  });
});

describe("MagicBlock refuse points", () => {
  test("delegate_account_with_actions refuses with magicblock_unsupported", async () => {
    const src = DEMO.replace(
      /ctx\.accounts\.delegate_pda\([\s\S]*?\)\?;/,
      `ephemeral_rollups_sdk::cpi::delegate_account_with_actions(accounts, &[COUNTER_SEED], DelegateConfig::default(), actions, &[])?;`,
    );
    const r = await parseAnchor(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.ir.warnings?.some((w) => w.code === "magicblock_unsupported")).toBe(true);
  });

  test("build_and_invoke_signed refuses", async () => {
    const src = DEMO.replace(".build_and_invoke()?;", ".build_and_invoke_signed(&[&[COUNTER_SEED]])?;");
    const r = await parseAnchor(src);
    if (!r.ok) throw new Error(r.error);
    expect(r.ir.warnings?.some((w) => w.code === "magicblock_unsupported")).toBe(true);
    const iu = r.ir.instructions.find((i) => i.name === "increment_and_undelegate")!;
    expect(iu.body.some((s) => s.kind === "cpi_magicblock_commit")).toBe(false);
  });

  test("residual detector catches deprecated MagicInstructionBuilder + raw sdk paths", () => {
    expect(detectMagicBlockResidualCpi("MagicInstructionBuilder::new()")).toContain("deprecated");
    expect(detectMagicBlockResidualCpi("ephemeral_rollups_sdk::ephem::create_schedule_commit_ix(a, b)")).toBeTruthy();
    expect(detectMagicBlockResidualCpi("let x = 1;")).toBeNull();
    // supported catalog text should NOT trip the residual detector once lowered —
    // the detector only ever sees pass_through leftovers, but keep it honest on
    // plain state code:
    expect(detectMagicBlockResidualCpi("counter.count += 1;")).toBeNull();
  });

  test("user-defined delegate_* helper method does NOT misroute", async () => {
    // No DelegateConfig third arg → the delegate-method branch must not fire.
    const src = `use anchor_lang::prelude::*;
declare_id!("79sGyNW41g8TrKyQwk7SZu432SH9ZfHmtRzEtR6CSt3n");
#[program]
pub mod not_magicblock {
    use super::*;
    pub fn go(ctx: Context<Go>) -> Result<()> {
        ctx.accounts.delegate_thing(1, 2)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Go<'info> {
    pub payer: Signer<'info>,
}
`;
    const r = await parseAnchor(src);
    if (!r.ok) throw new Error(r.error);
    const go = r.ir.instructions.find((i) => i.name === "go")!;
    expect(go.body.some((s) => s.kind === "cpi_magicblock_delegate")).toBe(false);
  });
});
