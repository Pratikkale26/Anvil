/**
 * #60 — Anchor 1.x discriminator override coverage.
 *
 * The variable-length INSTRUCTION-discriminator rework has landed: resolvable
 * overrides (int / short array / byte-string / const-ref) are now honored by the
 * router (`buildRouter` emits `[<bytes>, data @ ..]` slice patterns) and
 * byte-equal verified in differential-custom-instruction-disc.test.ts — so they
 * DROP the warning and carry `customDiscriminator.bytes`. Only an UNRESOLVABLE
 * form (const fn) keeps the loud `instruction_discriminator_override_unsupported`
 * warning. Account/event-disc overrides are likewise honored (no warning). This
 * file pins both directions so the "still unsupported" boundary stays visible.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const SCALAR_INSTRUCTION = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    #[instruction(discriminator = 1)]
    pub fn one_byte(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;

const SHORT_ARRAY_INSTRUCTION = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    #[instruction(discriminator = [1, 2, 3, 4])]
    pub fn four_byte(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;

const CONST_INSTRUCTION = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

const MY_DISC: &'static [u8] = &[55, 66, 77, 88];

#[program]
pub mod test_program {
    use super::*;
    #[instruction(discriminator = MY_DISC)]
    pub fn const_ref(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;

// const-fn override: not statically resolvable by the parser → still warns.
const CONST_FN_INSTRUCTION = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

const fn get_disc(input: &str) -> &'static [u8] {
    match input.as_bytes() {
        b"wow" => &[9, 11],
        _ => unimplemented!(),
    }
}

#[program]
pub mod test_program {
    use super::*;
    #[instruction(discriminator = get_disc("wow"))]
    pub fn const_fn_ix(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;

const ACCOUNT_OVERRIDE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    pub fn noop(_ctx: Context<Empty>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}

#[account(discriminator = 1)]
pub struct MyAccount {
    pub field: u8,
}
`;

const EVENT_OVERRIDE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    pub fn noop(_ctx: Context<Empty>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}

#[event(discriminator = 1)]
pub struct MyEvent {
    pub field: u8,
}
`;

const NO_OVERRIDE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    pub fn noop(_ctx: Context<Empty>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}

#[account]
pub struct MyAccount {
    pub field: u8,
}
`;

describe("#60 — Anchor 1.x discriminator override warnings", () => {
  // Resolvable instruction-disc overrides (int / short-array / byte-string /
  // const-ref) are now HONORED by the variable-length router → no warning. Only
  // unresolvable forms (const fn) still warn. (account/event-disc tested below.)
  test("scalar instruction discriminator → no warning, IR carries customDiscriminator", async () => {
    const r = await parseAnchor(SCALAR_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeUndefined();
    const ix = r.ir.instructions.find((i) => i.name === "one_byte");
    // Non-8-byte → legacy hex field stays empty; bytes live on customDiscriminator.
    expect(ix?.discriminator).toBeUndefined();
    expect(ix?.customDiscriminator).toEqual({ bytes: [1] });
  });

  test("short-array instruction discriminator → no warning, IR carries bytes", async () => {
    const r = await parseAnchor(SHORT_ARRAY_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeUndefined();
    const ix = r.ir.instructions.find((i) => i.name === "four_byte");
    expect(ix?.customDiscriminator).toEqual({ bytes: [1, 2, 3, 4] });
  });

  test("const-reference instruction discriminator resolves → no warning", async () => {
    const r = await parseAnchor(CONST_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeUndefined();
    const ix = r.ir.instructions.find((i) => i.name === "const_ref");
    expect(ix?.customDiscriminator).toEqual({ bytes: [55, 66, 77, 88] });
  });

  test("const-FN instruction discriminator (unresolvable) → STILL warns, no customDiscriminator", async () => {
    const r = await parseAnchor(CONST_FN_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.instruction).toBe("const_fn_ix");
    const ix = r.ir.instructions.find((i) => i.name === "const_fn_ix");
    expect(ix?.customDiscriminator).toBeUndefined();
  });

  test("#[account(discriminator = N)] populates customDiscriminator (no warning)", async () => {
    const r = await parseAnchor(ACCOUNT_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Resolvable forms no longer warn — they populate IR.customDiscriminator
    // so emit honors the bytes.
    const acc = r.ir.accounts.find((a) => a.name === "MyAccount");
    expect(acc?.customDiscriminator).toEqual({ bytes: [1] });
    const w = r.ir.warnings?.find(
      (w) => w.code === "account_discriminator_override_unsupported",
    );
    expect(w).toBeUndefined();
  });

  test("#[event(discriminator = N)] populates customDiscriminator (no warning)", async () => {
    const r = await parseAnchor(EVENT_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = r.ir.events?.find((e) => e.name === "MyEvent");
    expect(ev?.customDiscriminator).toEqual({ bytes: [1] });
    const w = r.ir.warnings?.find(
      (w) => w.code === "event_discriminator_override_unsupported",
    );
    expect(w).toBeUndefined();
  });

  test("#[account(discriminator = MY_DISC)] resolves const → populates customDiscriminator", async () => {
    const ACCOUNT_CONST_OVERRIDE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

pub const MY_DISC: &'static [u8] = &[9, 8, 7];

#[program]
pub mod test_program {
    use super::*;
    pub fn noop(_ctx: Context<Empty>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}

#[account(discriminator = MY_DISC)]
pub struct MyAccount {
    pub field: u8,
}
`;
    const r = await parseAnchor(ACCOUNT_CONST_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const acc = r.ir.accounts.find((a) => a.name === "MyAccount");
    expect(acc?.customDiscriminator).toEqual({ bytes: [9, 8, 7] });
  });

  test("#[account(discriminator = unresolvable_fn())] warns (no IR field)", async () => {
    const ACCOUNT_UNRESOLVABLE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    pub fn noop(_ctx: Context<Empty>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}

#[account(discriminator = get_disc("x"))]
pub struct MyAccount {
    pub field: u8,
}
`;
    const r = await parseAnchor(ACCOUNT_UNRESOLVABLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const acc = r.ir.accounts.find((a) => a.name === "MyAccount");
    expect(acc?.customDiscriminator).toBeUndefined();
    const w = r.ir.warnings?.find(
      (w) => w.code === "account_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.snippet).toBe(`get_disc("x")`);
  });

  test("plain #[account] without override does NOT warn", async () => {
    const r = await parseAnchor(NO_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warnings = r.ir.warnings ?? [];
    expect(
      warnings.some((w) =>
        w.code === "account_discriminator_override_unsupported" ||
        w.code === "event_discriminator_override_unsupported" ||
        w.code === "instruction_discriminator_override_unsupported"
      ),
    ).toBe(false);
  });

  test("8-byte literal-array instruction (supported) does NOT warn", async () => {
    const SUPPORTED = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    #[instruction(discriminator = [1, 2, 3, 4, 5, 6, 7, 8])]
    pub fn eight_byte(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;
    const r = await parseAnchor(SUPPORTED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const warnings = r.ir.warnings ?? [];
    expect(
      warnings.some(
        (w) => w.code === "instruction_discriminator_override_unsupported",
      ),
    ).toBe(false);
    const ix = r.ir.instructions.find((i) => i.name === "eight_byte");
    expect(ix?.discriminator).toBe("0102030405060708");
  });
});
