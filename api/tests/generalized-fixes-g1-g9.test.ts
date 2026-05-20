// Regression tests for the G1-G9 generalized fixes that lifted external
// clean-build rate from 70% (14/20) to 80% (16/20) on the external
// Anchor sweep. Each fix is a source-level or emit-level transform
// that generalizes across programs — not per-fixture patches.
//
// Lock the trigger patterns in synthetic minimal source so a future
// refactor can't silently drop the fix.
import { describe, test, expect } from "bun:test";
import {
  vendorExternalProgramIDs,
  disambiguateSiblingModConsts,
  rewriteSolanaHashCalls,
} from "../src/parser/project-source.ts";

describe("G1 — Solana hash helper rewrites", () => {
  test("solana_sha256_hasher::hashv(slices).to_bytes() → anvil_sha256_hashv(slices)", () => {
    const src = `let h = solana_sha256_hasher::hashv(&[left.as_ref(), right.as_ref()]).to_bytes();`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.source).toContain("anvil_sha256_hashv(&[left.as_ref(), right.as_ref()])");
    expect(r.source).not.toContain("solana_sha256_hasher");
    expect(r.source).not.toContain(".to_bytes()");
    expect(r.needsSha256).toBe(true);
  });

  test("solana_keccak_hasher::hashv preserved correctly even with nested parens", () => {
    const src = `let h = solana_keccak_hasher::hashv(&[a.as_ref(), b.as_ref()]).to_bytes();`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.source).toContain("anvil_keccak_hashv(&[a.as_ref(), b.as_ref()])");
    expect(r.needsKeccak).toBe(true);
  });

  test("bare hashv() rewritten when source has matching `use` import", () => {
    const src = `use solana_keccak_hasher::hashv;\nfn h(data: &[u8]) -> [u8; 32] { hashv(&[data]).0 }`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.source).toContain("anvil_keccak_hashv(&[data])");
    expect(r.needsKeccak).toBe(true);
  });

  test("no match when source has no hash usage", () => {
    const src = `let x = 42;`;
    const r = rewriteSolanaHashCalls(src);
    expect(r.needsSha256).toBe(false);
    expect(r.needsKeccak).toBe(false);
  });
});

describe("G7 — vendor more well-known program IDs", () => {
  test("spl_token::ID as TOKEN_PROGRAM_ID is vendored", () => {
    const src = `use spl_token::ID as TOKEN_PROGRAM_ID;`;
    const out = vendorExternalProgramIDs(src);
    expect(out).toContain("pub const TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array(");
  });

  test("spl_token_2022::ID as TOKEN_2022_PROGRAM_ID is vendored", () => {
    const src = `use spl_token_2022::ID as TOKEN_2022_PROGRAM_ID;`;
    const out = vendorExternalProgramIDs(src);
    expect(out).toContain("pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array(");
  });

  test("spl_associated_token_account::ID as ASSOC_TOKEN_PROGRAM_ID is vendored", () => {
    const src = `use spl_associated_token_account::ID as ASSOC_TOKEN_PROGRAM_ID;`;
    const out = vendorExternalProgramIDs(src);
    expect(out).toContain("pub const ASSOC_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array(");
  });
});

describe("Sibling-mod const disambiguation (raydium pattern)", () => {
  test("two pub mods with same const name → renamed + refs rewritten", () => {
    const src = `pub mod admin {
    pub const ID: Pubkey = Pubkey::new_from_array([1; 32]);
}
pub mod limit_order_admin {
    pub const ID: Pubkey = Pubkey::new_from_array([2; 32]);
}
fn check(p: &Pubkey) -> bool { *p == admin::ID || *p == limit_order_admin::ID }`;
    const out = disambiguateSiblingModConsts(src);
    expect(out).toContain("pub const admin_ID");
    expect(out).toContain("pub const limit_order_admin_ID");
    expect(out).toContain("admin_ID || *p == limit_order_admin_ID");
  });
});

describe("G19 — pub fn id() + pub const ID emit + Error stub", () => {
  // Anchor's declare_id!() expands to `pub const ID: Pubkey = ...;` and
  // `pub fn id() -> Pubkey { ID }`. Anvil's emit previously skipped both;
  // carried code referencing crate::id() / crate::ID hit E0425/E0433.
  // Raydium-clmm had 6x crate::id() and 3x crate::ID references.
  test("ID const + id() fn emitted when ir.programId present (Pinocchio)", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "my_program",
      programId: "11111111111111111111111111111111", // base58 for [0u8; 32]
      accounts: [], types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).toContain("pub const ID: Pubkey =");
    expect(lib).toContain("pub fn id() -> Pubkey { ID }");
    // Pinocchio uses [u8; 32] bare literal.
    expect(lib).toContain("pub const ID: Pubkey = [0, 0, 0, 0, 0, 0, 0, 0,");
  });

  test("Native target wraps with Pubkey::new_from_array()", async () => {
    const { NativeEmitter } = await import("../src/emitter/native-emitter.ts");
    const ir: any = {
      name: "my_program",
      programId: "11111111111111111111111111111111",
      accounts: [], types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new NativeEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).toContain("pub const ID: Pubkey = Pubkey::new_from_array([");
  });

  test("No ID const when ir.programId is undefined", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "p", accounts: [], types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).not.toContain("pub const ID:");
    expect(lib).not.toContain("pub fn id()");
  });

  test("Error stub emitted when helper code references Error::", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "p",
      accounts: [], types: [],
      helperFns: [
        {
          name: "h", signature: "fn h() -> Result<(), ProgramError>",
          rawCode: `fn h() -> Result<(), ProgramError> { Err(Error::from(MyErr::X)) }`,
          body: `Err(Error::from(MyErr::X))`,
        },
      ],
      events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).toContain("pub struct Error(pub ProgramError)");
    expect(lib).toContain("pub fn with_pubkeys<T>");
    expect(lib).toContain("pub fn with_source<T>");
  });

  test("No Error stub when carried code doesn't reference Error", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "p",
      accounts: [], types: [],
      helperFns: [
        { name: "h", signature: "fn h() -> u64", rawCode: `fn h() -> u64 { 42 }`, body: `42` },
      ],
      events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).not.toContain("pub struct Error");
  });
});

describe("G17 — ZeroCopy / Owner / Discriminator trait stubs", () => {
  // Raydium-clmm and similar programs define user wrappers like
  //   pub struct AccountLoad<'info, T: ZeroCopy + Owner> { ... }
  // which carry anchor_lang trait bounds verbatim into emitted helpers.rs.
  // Anvil strips anchor_lang imports, so those bounds need somewhere to
  // resolve. G17 emits stub traits at lib.rs scope when any account or
  // typedef is isZeroCopy, plus impl blocks per zero-copy account.
  test("ZeroCopy traits emitted at lib.rs scope when isZeroCopy account present", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "zc_program",
      accounts: [
        { name: "PoolState", isZeroCopy: true, fields: [{ name: "owner", type: "Pubkey" }, { name: "tick", type: "u16" }], implItems: [] },
      ],
      types: [],
      helperFns: [],
      events: [],
      errors: [],
      constants: [],
      instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).toContain("pub trait Discriminator {");
    expect(lib).toContain("pub trait Owner {");
    expect(lib).toContain("pub trait ZeroCopy: Discriminator + Owner {}");
    const state = out.files.find((f: any) => f.path === "state.rs")?.content ?? "";
    expect(state).toContain("impl Discriminator for PoolState");
    expect(state).toContain("impl Owner for PoolState");
    expect(state).toContain("impl ZeroCopy for PoolState");
  });

  test("Native target emits owner() with Pubkey::default()", async () => {
    const { NativeEmitter } = await import("../src/emitter/native-emitter.ts");
    const ir: any = {
      name: "zc_program",
      accounts: [
        { name: "PoolState", isZeroCopy: true, fields: [{ name: "owner", type: "Pubkey" }], implItems: [] },
      ],
      types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new NativeEmitter().emit(ir);
    const state = out.files.find((f: any) => f.path === "state.rs")?.content ?? "";
    expect(state).toContain("fn owner() -> Pubkey { Pubkey::default() }");
  });

  test("Pinocchio target emits owner() with [0u8; 32]", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "zc_program",
      accounts: [
        { name: "PoolState", isZeroCopy: true, fields: [{ name: "owner", type: "Pubkey" }], implItems: [] },
      ],
      types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const state = out.files.find((f: any) => f.path === "state.rs")?.content ?? "";
    expect(state).toContain("fn owner() -> Pubkey { [0u8; 32] }");
  });

  test("No trait stubs emitted when no isZeroCopy account/typeDef exists", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "regular_program",
      accounts: [{ name: "Foo", fields: [{ name: "v", type: "u64" }], implItems: [] }],
      types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const lib = out.files.find((f: any) => f.path === "lib.rs")?.content ?? "";
    expect(lib).not.toContain("pub trait ZeroCopy");
    expect(lib).not.toContain("pub trait Owner");
  });

  test("Regular accounts do not get trait impls", async () => {
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const ir: any = {
      name: "zc_program",
      accounts: [
        { name: "PoolState", isZeroCopy: true, fields: [{ name: "owner", type: "Pubkey" }], implItems: [] },
        { name: "RegularAcc", fields: [{ name: "v", type: "u64" }], implItems: [] },
      ],
      types: [], helperFns: [], events: [], errors: [], constants: [], instructions: [],
    };
    const out = new PinocchioEmitter().emit(ir);
    const state = out.files.find((f: any) => f.path === "state.rs")?.content ?? "";
    expect(state).not.toMatch(/impl\s+ZeroCopy\s+for\s+RegularAcc/);
    expect(state).not.toMatch(/impl\s+Owner\s+for\s+RegularAcc/);
  });
});

describe("G16 — kamino orphan-chain + drift overshoot prevention", () => {
  // Layer A: pre-filter drops nested invocations inside macro_rules!
  // definition bodies — chain walker can no longer overshoot the def
  // closer (drift macros.rs → #[program] regression class).
  // Layer B: whitelist-only walker after macro's matching `)` extends
  // range through `.ident(...)`, `?`, terminal `;` — closes kamino's
  // `MACRO!(x).validating(v).set(&y)?;` orphan-chain.
  test("Kamino orphan-chain after macro_rules! is fully consumed", async () => {
    const { neutralizeUnsupportedMacros } = await import("../src/parser/project-source.ts");
    const src = `macro_rules! for_named_field {
    ($expr:expr) => { for_field($expr).named(stringify!($expr)) };
}

fn update(value: u8, market: &mut Market) -> Result<()> {
    for_named_field!(&mut market.emergency_mode)
        .validating(validations::check_bool)
        .set(&value)?;
    Ok(())
}`;
    const out = neutralizeUnsupportedMacros(src);
    // .validating( and .set( must NOT remain on uncommented lines.
    expect(out).not.toMatch(/^(?!\s*\/\/).*\.validating\(/m);
    expect(out).not.toMatch(/^(?!\s*\/\/).*\.set\(\&value\)/m);
  });

  test("Drift macro_rules! body invocation doesn't overshoot definition closer", async () => {
    const { neutralizeUnsupportedMacros } = await import("../src/parser/project-source.ts");
    const src = `macro_rules! validate {
    ($cond:expr, $err:expr) => {
        if !$cond {
            msg!("validation failed");
            return Err($err.into());
        }
    };
}

#[program]
pub mod drift {
    use super::*;
    pub fn initialize(ctx: Context<Init>) -> Result<()> {
        validate!(ctx.accounts.foo.bar > 0, ErrorCode::Invalid);
        Ok(())
    }
}`;
    const out = neutralizeUnsupportedMacros(src);
    // #[program] line must exist and not be commented out.
    const programLine = out.split("\n").find((l) => l.includes("#[program]"));
    expect(programLine).toBeDefined();
    expect(programLine!.trim().startsWith("//")).toBe(false);
    // `pub mod drift` must still be present uncommented.
    expect(out).toMatch(/^(?!\s*\/\/).*pub mod drift/m);
  });

  test("Statement-form macro with trailing ; gets line-commented", async () => {
    const { neutralizeUnsupportedMacros } = await import("../src/parser/project-source.ts");
    const src = `macro_rules! my_macro { ($a:expr, $b:expr) => { () } }
fn x() {
    my_macro!(a, b);
}`;
    const out = neutralizeUnsupportedMacros(src);
    // `my_macro!(a, b);` line must be commented.
    const myMacroLine = out.split("\n").find((l) => l.includes("my_macro!(a, b);"));
    expect(myMacroLine).toBeDefined();
    expect(myMacroLine!.trim().startsWith("//")).toBe(true);
  });

  test("Inner-expression macro substitutes todo!() preserving outer parens", async () => {
    const { neutralizeUnsupportedMacros } = await import("../src/parser/project-source.ts");
    const src = `macro_rules! my_macro { ($e:expr) => { || $e.into() } }
fn x() -> Result<()> {
    Err(my_macro!(ErrorCode::Foo)())
}`;
    const out = neutralizeUnsupportedMacros(src);
    expect(out).toContain("todo!");
    // Outer `Err(` and `)` should remain balanced.
    let depth = 0;
    let inComment = false;
    let inStr = false;
    for (let i = 0; i < out.length; i++) {
      if (inComment) {
        if (out[i] === "\n") inComment = false;
        continue;
      }
      if (out[i] === "/" && out[i + 1] === "/") { inComment = true; continue; }
      if (inStr) {
        if (out[i] === "\\") { i++; continue; }
        if (out[i] === '"') inStr = false;
        continue;
      }
      if (out[i] === '"') { inStr = true; continue; }
      if (out[i] === "(") depth++;
      else if (out[i] === ")") depth--;
    }
    expect(depth).toBe(0);
  });
});

describe("G15 — drift carried-helper emit! comment strip", () => {
  // Drift's controller/funding.rs has emit!(Event { f: v, //1e9 ... });
  // shapes. transformHelperCode collapses to single-line `};`, so any
  // trailing `//comment` on the last field swallows the closer →
  // "unclosed delimiter" cargo error at file end. stripFieldComments
  // mirrors the IR path's per-field comment scrub.
  test("trailing // comments on emit! fields don't swallow }; in carried-helper rewrite", async () => {
    const { transformHelperCode } = await import("../src/emitter/anchor-transforms.ts");
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const emitter = new PinocchioEmitter();
    const src = `fn x() -> Result<()> {
  emit!(Evt {
    ts: now,
    funding_payment: payment, //1e6
    base_asset_amount: market.base_asset_amount, //1e9
  });
  Ok(())
}`;
    const out = transformHelperCode(
      src,
      (e, f) => emitter.emitEmit(e, f),
      (m) => `pinocchio::msg!(${m});`,
    );
    expect(out).not.toMatch(/\/\/[^\n]*\};/);
    expect(out).toContain("base_asset_amount: market.base_asset_amount }");
    // braces balance
    let depth = 0;
    for (const ch of out) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    expect(depth).toBe(0);
  });

  test("emit! with no comments survives unchanged in structure", async () => {
    const { transformHelperCode } = await import("../src/emitter/anchor-transforms.ts");
    const { PinocchioEmitter } = await import("../src/emitter/pinocchio-emitter.ts");
    const emitter = new PinocchioEmitter();
    const src = `fn x() -> Result<()> { emit!(Evt { a: 1, b: 2 }); Ok(()) }`;
    const out = transformHelperCode(
      src,
      (e, f) => emitter.emitEmit(e, f),
      (m) => `pinocchio::msg!(${m});`,
    );
    expect(out).toContain("Evt { a: 1, b: 2 }");
  });
});
