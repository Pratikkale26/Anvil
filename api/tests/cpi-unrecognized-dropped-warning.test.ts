/**
 * B6 regression — `cpi_unrecognized_dropped` parser warning surface.
 *
 * Pre-B6 the parser silently dropped CPI shapes it didn't recognize. The
 * canonical case: a body containing `anchor_spl::weird_extension::do_thing(...)`
 * (or any cpi-namespace call the typed extractors don't model) would land
 * in pass_through. Pinocchio post-process then strips it as Anchor-only —
 * the on-chain CPI vanishes from the emit with NO warning.
 *
 * This was the #1 silent-correctness footgun for users porting away from
 * Anchor: their program would compile, deploy, and the missing CPI would
 * surface as off-chain analytics quietly diverging.
 *
 * Post-B6: detectUnrecognizedCpiShape scans the pass-through text for
 * 4 patterns (anchor_spl::*, token_interface::*, <crate>::cpi::*,
 * invoke{,_signed}). Any match emits a `cpi_unrecognized_dropped`
 * warning with the call shape + truncated source snippet + source location.
 *
 * The pattern detection is text-based AFTER stripping comments and string
 * literals so we don't false-positive on `// invoke(...)` documentation
 * or `"call invoke()" + ...` string concatenations.
 */
import { describe, test, expect } from "bun:test";
import { detectUnrecognizedCpiShape } from "../src/parser/ast-helpers.ts";

describe("B6 — detectUnrecognizedCpiShape: positive matches", () => {
  test("anchor_spl::token::transfer( → matches", () => {
    const out = detectUnrecognizedCpiShape("anchor_spl::token::transfer(ctx, 100)?;");
    expect(out).toBe("anchor_spl::…::transfer(...)");
  });

  test("anchor_spl::token_2022::mint_to( → matches", () => {
    const out = detectUnrecognizedCpiShape("anchor_spl::token_2022::mint_to(ctx, 50)?;");
    expect(out).toBe("anchor_spl::…::mint_to(...)");
  });

  test("token_interface::burn( → matches", () => {
    const out = detectUnrecognizedCpiShape("token_interface::burn(ctx, 10)?;");
    expect(out).toBe("token_interface::burn(...)");
  });

  test("<crate>::cpi::<fn>( → matches", () => {
    const out = detectUnrecognizedCpiShape("mpl_token_metadata::cpi::burn_v1(cpi_ctx, args)?;");
    expect(out).toBe("mpl_token_metadata::cpi::burn_v1(...)");
  });

  test("invoke(...) → matches", () => {
    const out = detectUnrecognizedCpiShape(`invoke(
      &Instruction { program_id: PROG, accounts: vec![], data: vec![] },
      &[acc1.clone(), acc2.clone()],
    )?;`);
    expect(out).toBe("invoke(...)");
  });

  test("invoke_signed(...) → matches", () => {
    const out = detectUnrecognizedCpiShape("invoke_signed(&ix, accounts, signers)?;");
    expect(out).toBe("invoke_signed(...)");
  });

  test("call inside if-block control flow → still matches", () => {
    const text = `if amount > 0 {
      anchor_spl::token::transfer(ctx, amount)?;
    }`;
    const out = detectUnrecognizedCpiShape(text);
    expect(out).toBe("anchor_spl::…::transfer(...)");
  });
});

describe("B6 — detectUnrecognizedCpiShape: negative (no match)", () => {
  test("plain Rust → null", () => {
    expect(detectUnrecognizedCpiShape("let x = state.balance + amount;")).toBeNull();
  });

  test("`use anchor_spl::token;` import → null (not a call)", () => {
    expect(detectUnrecognizedCpiShape("use anchor_spl::token;")).toBeNull();
  });

  test("comment containing invoke(...) → null (comments stripped)", () => {
    expect(detectUnrecognizedCpiShape("// invoke(...) example — see docs"))
      .toBeNull();
  });

  test("string literal containing anchor_spl::token::transfer → null", () => {
    expect(detectUnrecognizedCpiShape(`msg!("called anchor_spl::token::transfer here")`))
      .toBeNull();
  });

  test("block comment with cpi call inside → null", () => {
    expect(detectUnrecognizedCpiShape(`/* anchor_spl::token::burn(ctx, 1)?; */ let x = 1;`))
      .toBeNull();
  });

  test("ctx.accounts.foo.invoke_other_method() → null (not the bare CPI primitive)", () => {
    expect(detectUnrecognizedCpiShape("ctx.accounts.foo.invoke_other_method()?;"))
      .toBeNull();
  });
});

describe("B6 — function-name precision (matches what we report)", () => {
  test("token_interface::set_authority captures the function name", () => {
    const out = detectUnrecognizedCpiShape("token_interface::set_authority(ctx, ty, Some(pk))?;");
    expect(out).toContain("set_authority");
  });

  test("crate::cpi::fn reports both crate AND fn for triage clarity", () => {
    const out = detectUnrecognizedCpiShape("custom_crate::cpi::do_thing(c)?;");
    expect(out).toBe("custom_crate::cpi::do_thing(...)");
  });
});
