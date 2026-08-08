/**
 * MagicBlock Ephemeral Rollups — emit coverage, both targets.
 *
 *   Pinocchio: vendored port of ephemeral-rollups-pinocchio 0.16.2 against
 *   the pinocchio 0.9 API (helpers magicblock_delegate_account /
 *   magicblock_schedule_commit / magicblock_undelegate_account), no new
 *   Cargo deps.
 *
 *   Native: fully-qualified wrappers over the real ephemeral-rollups-sdk
 *   crate (backward-compat feature), added via NATIVE_OPTIONAL_DEPS.
 *
 * Also locks the flush-before-commit fixup: state mutated in the same
 * instruction is T::save'd BEFORE the commit CPI, and the committed-account
 * list passes the AccountInfo alias, not the deserialized struct.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import { buildProjectScaffold } from "../src/emitter/project-scaffold.ts";
import type { SolanaIR } from "../src/ir/schema.ts";

const DEMO = readFileSync(
  join(import.meta.dir, "..", "src", "demo-programs", "magicblock-counter.rs"),
  "utf-8",
);

let cachedIr: SolanaIR | null = null;
async function demoIr(): Promise<SolanaIR> {
  if (cachedIr) return cachedIr;
  const r = await parseAnchor(DEMO);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  cachedIr = r.ir;
  return r.ir;
}

describe("MagicBlock emit — Pinocchio", () => {
  test("emits vendored helpers + typed call sites, validator-clean", async () => {
    const ir = await demoIr();
    const out = emitPinocchioFull(ir);
    const code = out.singleFile;
    // helpers present
    expect(code).toContain("pub fn magicblock_delegate_account(");
    expect(code).toContain("pub fn magicblock_schedule_commit(");
    expect(code).toContain("pub fn magicblock_undelegate_account(");
    expect(code).toContain("pub const MAGICBLOCK_DLP_ID: Pubkey");
    // dlp wire facts: any-validator discriminator + ScheduleCommit tags
    expect(code).toContain("if any_validator { 19 } else { 0 }");
    expect(code).toContain("[2, 0, 0, 0] } else { [1, 0, 0, 0] }");
    // undelegate buffer must be the canonical PDA
    expect(code).toContain('b"undelegate-buffer"');
    // router dispatches the callback on the external undelegate discriminator
    expect(code).toContain("[196, 28, 41, 206, 48, 37, 51, 167] => process_undelegation(");
    // sdk imports never survive (vendored port, no crate dep)
    expect(code).not.toContain("use ephemeral_rollups_sdk");
    const errors = validateEmitterOutput(ir, out).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  test("state is flushed before the commit CPI and the AccountInfo alias is passed", async () => {
    const ir = await demoIr();
    const code = emitPinocchioFull(ir).singleFile;
    const saveIdx = code.indexOf("Counter::save(counter_account, &counter)?;");
    const commitBlock = /magicblock_schedule_commit\(\s*payer,\s*magic_context,\s*magic_program,\s*&\[counter_account\]/m;
    expect(commitBlock.test(code)).toBe(true);
    // the flush precedes the intent-bundle commit call site
    const commitIdx = code.search(commitBlock);
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(commitIdx);
    // the plain `commit` instruction (no state mutation) passes the raw binding
    expect(code).toMatch(/magicblock_schedule_commit\(\s*payer,\s*magic_context,\s*magic_program,\s*&\[counter\],/m);
  });

  test("Cargo.toml gains NO new deps on pinocchio", async () => {
    const ir = await demoIr();
    const cargo = buildProjectScaffold(ir, "pinocchio").find((f) => f.path === "Cargo.toml")!.content;
    expect(cargo).not.toContain("ephemeral-rollups");
  });
});

describe("MagicBlock emit — Native", () => {
  test("wraps ephemeral-rollups-sdk fully-qualified, validator-clean", async () => {
    const ir = await demoIr();
    const out = emitNativeFull(ir);
    const code = out.singleFile;
    expect(code).toContain("ephemeral_rollups_sdk::cpi::DelegateAccounts");
    expect(code).toContain("ephemeral_rollups_sdk::cpi::delegate_account(");
    expect(code).toContain("ephemeral_rollups_sdk::ephem::commit_accounts(");
    expect(code).toContain("ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder::new(");
    expect(code).toContain("ephemeral_rollups_sdk::cpi::undelegate_account(");
    // anchor-flavored source imports are dropped (crate built w/o `anchor` feature)
    expect(code).not.toContain("use ephemeral_rollups_sdk::anchor");
    const errors = validateEmitterOutput(ir, out).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  test("Cargo.toml gains the sdk dep with backward-compat", async () => {
    const ir = await demoIr();
    const cargo = buildProjectScaffold(ir, "native").find((f) => f.path === "Cargo.toml")!.content;
    expect(cargo).toContain('ephemeral-rollups-sdk = { version = "0.16", features = ["backward-compat"] }');
  });
});
