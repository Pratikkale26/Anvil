/**
 * Anchor 1.0 literal discriminator override — task #77.
 *
 * Anchor 1.0 added `#[instruction(discriminator = [N, N, N, N, N, N, N, N])]`
 * on handler fns to override the auto-computed
 * sha256("global:<name>")[..8] discriminator. Pre-#77 Anvil's parser
 * ignored the bytes and the router emit used the computed disc, which
 * silently misrouted calls from clients that built data with the
 * literal override.
 *
 * This test exercises end-to-end: parser extracts → IR carries hex →
 * emitter router uses the override bytes in the match arm.
 */
import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const SOURCE_WITH_OVERRIDE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    #[instruction(discriminator = [11, 22, 33, 44, 55, 66, 77, 88])]
    pub fn custom_dispatched(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;

const SOURCE_WITHOUT_OVERRIDE = `
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod test_program {
    use super::*;
    pub fn default_dispatched(ctx: Context<Empty>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Empty<'info> {
    pub signer: Signer<'info>,
}
`;

describe("Anchor 1.0 literal discriminator override", () => {
  test("parser extracts the 8 bytes onto instr.discriminator (hex)", async () => {
    const r = await parseAnchor(SOURCE_WITH_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "custom_dispatched");
    expect(ix).toBeDefined();
    expect(ix!.discriminator).toBe("0b16212c37424d58"); // 11,22,33,44,55,66,77,88 in hex
  });

  test("parser leaves discriminator undefined when no override is declared", async () => {
    const r = await parseAnchor(SOURCE_WITHOUT_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ix = r.ir.instructions.find((i) => i.name === "default_dispatched");
    expect(ix).toBeDefined();
    expect(ix!.discriminator).toBeUndefined();
  });

  test("Pinocchio router uses override bytes in the match arm", async () => {
    const r = await parseAnchor(SOURCE_WITH_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitPinocchioFull(r.ir).singleFile;
    expect(emit).toMatch(/\[11, 22, 33, 44, 55, 66, 77, 88\]\s*=>\s*custom_dispatched/);
  });

  test("Native router uses override bytes in the match arm", async () => {
    const r = await parseAnchor(SOURCE_WITH_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitNativeFull(r.ir).singleFile;
    expect(emit).toMatch(/\[11, 22, 33, 44, 55, 66, 77, 88\]\s*=>\s*custom_dispatched/);
  });

  test("Pinocchio router uses computed sha256 disc when no override (backward compat)", async () => {
    const r = await parseAnchor(SOURCE_WITHOUT_OVERRIDE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitPinocchioFull(r.ir).singleFile;
    // sha256("global:default_dispatched")[..8] — exact bytes depend on
    // crypto but the match arm should NOT be all-zeros and SHOULD route
    // to default_dispatched.
    expect(emit).toMatch(/\[\d+, \d+, \d+, \d+, \d+, \d+, \d+, \d+\]\s*=>\s*default_dispatched/);
    // The override-specific bytes from the other source must not appear.
    expect(emit).not.toMatch(/\[11, 22, 33, 44, 55, 66, 77, 88\]/);
  });
});

// #60 — Account/event discriminator override emit honor tests.
const ACCOUNT_OVERRIDE_INT = `
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

#[account(discriminator = 7)]
pub struct OneByteAcc {
    pub field: u8,
}
`;

const ACCOUNT_OVERRIDE_ARRAY = `
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

#[account(discriminator = [9, 8, 7, 6])]
pub struct FourByteAcc {
    pub field: u8,
}
`;

const EVENT_OVERRIDE_BYTE_STR = `
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

#[event(discriminator = b"hi")]
pub struct ByteStrEvent {
    pub field: u8,
}
`;

describe("#60 — account/event discriminator override flows through emit", () => {
  test("Native: account with `discriminator = 7` emits [u8; 1] = [7]", async () => {
    const r = await parseAnchor(ACCOUNT_OVERRIDE_INT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitNativeFull(r.ir).singleFile;
    expect(emit).toMatch(/pub const DISCRIMINATOR: \[u8; 1\] = \[7\];/);
    // Read/write paths slice with the overridden length, not [..8].
    expect(emit).toMatch(/data\[\.\.1\] != Self::DISCRIMINATOR/);
    expect(emit).toMatch(/data\[\.\.1\]\.copy_from_slice\(&Self::DISCRIMINATOR\)/);
    // Default sha256-byte literal must NOT appear in this struct's block.
    expect(emit).not.toMatch(/pub const DISCRIMINATOR: \[u8; 8\] = \[[\d, ]+\];[^]*OneByteAcc/);
  });

  test("Pinocchio: account with `discriminator = 7` emits [u8; 1] = [7]", async () => {
    const r = await parseAnchor(ACCOUNT_OVERRIDE_INT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitPinocchioFull(r.ir).singleFile;
    expect(emit).toMatch(/pub const DISCRIMINATOR: \[u8; 1\] = \[7\];/);
    expect(emit).toMatch(/data\[\.\.1\] != Self::DISCRIMINATOR/);
  });

  test("Native: account with `discriminator = [9, 8, 7, 6]` emits [u8; 4] = [9, 8, 7, 6]", async () => {
    const r = await parseAnchor(ACCOUNT_OVERRIDE_ARRAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitNativeFull(r.ir).singleFile;
    expect(emit).toMatch(/pub const DISCRIMINATOR: \[u8; 4\] = \[9, 8, 7, 6\];/);
    expect(emit).toMatch(/data\[\.\.4\] != Self::DISCRIMINATOR/);
    // TOTAL_LEN now adds 4 (not 8) for the disc.
    expect(emit).toMatch(/pub const TOTAL_LEN: usize = 4 \+ Self::LEN;/);
  });

  test("event with `discriminator = b\"hi\"` emits the 2 ASCII bytes", async () => {
    const r = await parseAnchor(EVENT_OVERRIDE_BYTE_STR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // b"hi" → [104, 105] (UTF-8 codepoints).
    const emit = emitNativeFull(r.ir).singleFile;
    expect(emit).toMatch(/pub const DISCRIMINATOR: \[u8; 2\] = \[104, 105\];/);
  });

  test("Pinocchio: default 8-byte sha256 path stays text-identical (no override)", async () => {
    const r = await parseAnchor(`
use anchor_lang::prelude::*;
declare_id!("Counter111111111111111111111111111111111111");
#[program]
pub mod p { use super::*; pub fn noop(_ctx: Context<E>) -> Result<()> { Ok(()) } }
#[derive(Accounts)] pub struct E<'info> { pub signer: Signer<'info> }
#[account] pub struct Plain { pub field: u8 }
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emit = emitPinocchioFull(r.ir).singleFile;
    // Default path still emits `[u8; 8]` const and `[..8]` slices — the
    // existing snapshot corpus depends on this text being unchanged.
    expect(emit).toMatch(/pub const DISCRIMINATOR: \[u8; 8\] = \[\d+, \d+/);
    expect(emit).toMatch(/data\[\.\.8\] != Self::DISCRIMINATOR/);
    expect(emit).toMatch(/let mut offset = 8usize;/);
  });
});
