/**
 * #60 — Loud-signal coverage for Anchor 1.x discriminator overrides that
 * Anvil cannot yet honor.
 *
 * The narrow happy path (#[instruction(discriminator = [N; 8])]) is
 * already surfaced as IR.discriminator and tested in
 * parser-anchor1-discriminator.test.ts. This file pins the OPPOSITE: every
 * unsupported override form (scalar / short array / byte-str / const /
 * const-fn for instructions; ANY form for #[account]/#[event]) must drop
 * a ParserWarning so users see the silent-misroute / silent-byte-mismatch
 * risk before deploy.
 *
 * Once the variable-length discriminator rework lands, these warnings
 * graduate to honored emit and this file's expectations move to
 * `discriminator` field assertions.
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
  test("scalar instruction discriminator fires warning", async () => {
    const r = await parseAnchor(SCALAR_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.instruction).toBe("one_byte");
    expect(w!.snippet).toBe("1");
    // IR.discriminator stays undefined — the supported-path bailed.
    const ix = r.ir.instructions.find((i) => i.name === "one_byte");
    expect(ix?.discriminator).toBeUndefined();
  });

  test("short-array instruction discriminator fires warning", async () => {
    const r = await parseAnchor(SHORT_ARRAY_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.instruction).toBe("four_byte");
    expect(w!.snippet).toBe("[1, 2, 3, 4]");
  });

  test("const-reference instruction discriminator fires warning", async () => {
    const r = await parseAnchor(CONST_INSTRUCTION);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "instruction_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.instruction).toBe("const_ref");
    expect(w!.snippet).toBe("MY_DISC");
  });

  test("#[account(discriminator = N)] fires warning", async () => {
    const r = await parseAnchor(ACCOUNT_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "account_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.snippet).toBe("1");
    expect(w!.message).toMatch(/MyAccount/);
  });

  test("#[event(discriminator = N)] fires warning", async () => {
    const r = await parseAnchor(EVENT_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.ir.warnings?.find(
      (w) => w.code === "event_discriminator_override_unsupported",
    );
    expect(w).toBeDefined();
    expect(w!.snippet).toBe("1");
    expect(w!.message).toMatch(/MyEvent/);
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
