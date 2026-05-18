/**
 * Regression: checkExternalCrateDependencies must respect identifiers
 * brought into local scope via `use` statements.
 *
 * Pre-fix, the bare-call regex flagged every `system_instruction::transfer(...)`
 * as an unexpected crate even though the emit's lib.rs imported
 * `use solana_program::system_instruction;` via a brace-import. Same for
 * scaffold-injected re-exports like `spl_token_metadata_interface::*` and
 * cross-file `use super::*;` reachability chains.
 *
 * Locks three behaviors:
 *   1. Brace-import: `use solana_program::{system_instruction, ...};` makes
 *      `system_instruction::*` bare calls safe.
 *   2. Alias: `use foo::bar::baz as quux;` makes `quux::*` safe.
 *   3. Cross-file reachability: a binding in lib.rs is reachable from
 *      instructions/x.rs via `use super::*;` — same warning would have
 *      fired before this fix because each file was checked in isolation.
 *   4. Commented-out code: `// token::transfer(...)` (in a dead-code helper)
 *      no longer fires a bare-call warning. Block-comment bodies same.
 */
import { describe, test, expect } from "bun:test";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import type { SolanaIR, EmitterOutput } from "../src/ir/schema.ts";

const baseIr: SolanaIR = {
  name: "test",
  instructions: [],
  accounts: [],
  types: [],
  constants: [],
  errors: [],
  helperFns: [],
  events: [],
  imports: [],
  userTraitImpls: [],
  warnings: [],
  metadata: { sourceFramework: "anchor", anvilVersion: "0.2.0", parsedAt: new Date().toISOString() },
};

function asOutput(files: Array<{ path: string; content: string }>): EmitterOutput {
  return { files, singleFile: "", warnings: [] };
}

function warnMessages(o: EmitterOutput): string[] {
  return validateEmitterOutput(baseIr, o)
    .filter((i) => i.severity === "warning")
    .map((i) => i.message);
}

describe("use-binding-aware external crate check", () => {
  test("brace-imported submodule is not flagged as an external crate", () => {
    const lib = `
      use solana_program::{
          account_info::AccountInfo,
          program_error::ProgramError,
          system_instruction,
      };

      pub fn raw_transfer(from: &AccountInfo) -> Result<(), ProgramError> {
          let ix = system_instruction::transfer(from.key, from.key, 0u64);
          Ok(())
      }
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    expect(warns.some((w) => w.includes("system_instruction"))).toBe(false);
  });

  test("aliased binding is not flagged", () => {
    const lib = `
      use foo::bar::baz as legit_alias;

      pub fn x() {
          legit_alias::doit();
      }
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    expect(warns.some((w) => w.includes("legit_alias"))).toBe(false);
  });

  test("nested brace-import binds each leaf", () => {
    const lib = `
      use foo::{bar::baz, quux::frob};

      pub fn x() {
          baz::run();
          frob::run();
      }
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    expect(warns.some((w) => w.includes("baz") || w.includes("frob"))).toBe(false);
  });

  test("cross-file: binding in lib.rs reachable from instructions via use super::*", () => {
    const lib = `
      use solana_program::{system_instruction};
    `;
    const ix = `
      use super::*;

      pub fn raw_transfer() {
          let _ = system_instruction::transfer(/*…*/);
      }
    `;
    const warns = warnMessages(asOutput([
      { path: "lib.rs", content: lib },
      { path: "instructions/raw_transfer.rs", content: ix },
    ]));
    expect(warns.some((w) => w.includes("system_instruction"))).toBe(false);
  });

  test("genuinely unexpected crate is still flagged", () => {
    const lib = `
      use solana_program::account_info::AccountInfo;

      pub fn x() {
          let _ = pyth_sdk_solana::load_price_feed_from_account_info();
      }
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    expect(warns.some((w) => w.includes("pyth_sdk_solana"))).toBe(true);
  });

  test("commented-out bare call is not flagged (line-comment)", () => {
    const lib = `
      pub fn x() {
          // unsalvageable: token::transfer(/*…*/);
          // unsalvageable: token::mint_to(/*…*/);
      }
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    expect(warns.some((w) => w.includes("'token'"))).toBe(false);
  });

  test("commented-out bare call is not flagged (block-comment)", () => {
    const lib = `
      /*
         legacy:
           token::transfer(...)
      */
      pub fn x() {}
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    expect(warns.some((w) => w.includes("'token'"))).toBe(false);
  });

  test("allowlist still covers scaffold-injected crates referenced bare", () => {
    const lib = `
      pub fn x() {
          let _ = spl_token_metadata_interface::instruction::initialize();
          let _ = pinocchio_associated_token_account::instructions::CreateAta {};
          let _ = mpl_token_metadata::instructions::CreateMetadataAccountV3 {};
      }
    `;
    const warns = warnMessages(asOutput([{ path: "lib.rs", content: lib }]));
    const noisy = warns.filter((w) =>
      w.includes("spl_token_metadata_interface") ||
      w.includes("pinocchio_associated_token_account") ||
      w.includes("mpl_token_metadata"),
    );
    expect(noisy).toEqual([]);
  });
});
