import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

/**
 * Regression coverage for the four impl-method inliners in
 * src/parser/instruction-parser.ts:
 *   - expandAccountsMethodCalls   (multi-stmt ctx.accounts.METHOD)
 *   - expandAccountsMethodWrapper (single ctx.accounts.METHOD)
 *   - expandTypeAssociatedCalls   (multi-stmt TypeName::method)
 *   - expandTypeAssociatedHandler (single TypeName::method)
 *
 * Each test parses a tiny Anchor source and asserts on the resulting IR
 * body shape — decoupled from emitter behavior so a parser-level
 * regression surfaces here first.
 */

const PROG_HEADER = `use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

`;

async function parseOk(src: string) {
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.ir;
}

describe("Impl-method inliner", () => {
  test("single-call ctx.accounts wrapper inlines into state_field_assign", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<Foo>, amount: u64) -> Result<()> {
        ctx.accounts.do_thing(amount)
    }
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)] pub counter: Account<'info, Ctr>,
}
impl<'info> Foo<'info> {
    pub fn do_thing(&mut self, amount: u64) -> Result<()> {
        self.counter.count = amount;
        Ok(())
    }
}
#[account] pub struct Ctr { pub count: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    expect(ix.body.length).toBeGreaterThan(0);
    expect(ix.body.some((s) => s.kind === "state_field_assign")).toBe(true);
    expect(ix.body.some((s) => s.kind === "pass_through" && /ctx\.accounts\.do_thing/.test(s.code))).toBe(false);
  });

  test("multi-stmt ctx.accounts wrapper inlines every call (anchor-escrow shape)", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<Make>, seed: u64, amount: u64) -> Result<()> {
        ctx.accounts.init_state(seed)?;
        ctx.accounts.set_amount(amount)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Make<'info> {
    #[account(mut)] pub state: Account<'info, S>,
    #[account(mut)] pub maker: Signer<'info>,
}
impl<'info> Make<'info> {
    pub fn init_state(&mut self, seed: u64) -> Result<()> {
        self.state.seed = seed;
        Ok(())
    }
    pub fn set_amount(&mut self, amount: u64) -> Result<()> {
        self.state.amount = amount;
        Ok(())
    }
}
#[account] pub struct S { pub seed: u64, pub amount: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    const fieldAssigns = ix.body.filter((s) => s.kind === "state_field_assign");
    expect(fieldAssigns.length).toBe(2);
    // Neither call should remain as a pass-through fallback
    const stringified = JSON.stringify(ix.body);
    expect(/ctx\.accounts\.init_state/.test(stringified)).toBe(false);
    expect(/ctx\.accounts\.set_amount/.test(stringified)).toBe(false);
  });

  test("single-call TypeName::method handler inlines impl body", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<Foo>, amount: u64) -> Result<()> {
        Foo::handler(ctx, amount)
    }
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)] pub counter: Account<'info, Ctr>,
}
impl<'info> Foo<'info> {
    pub fn handler(ctx: Context<Foo>, amount: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = amount;
        Ok(())
    }
}
#[account] pub struct Ctr { pub count: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    expect(ix.body.length).toBeGreaterThan(0);
    expect(ix.body.some((s) => s.kind === "state_read")).toBe(true);
    expect(ix.body.some((s) => s.kind === "state_field_assign")).toBe(true);
    expect(JSON.stringify(ix.body).includes("Foo::handler")).toBe(false);
  });

  test("multi-stmt TypeName::method inlines every call (dice shape)", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn resolve(ctx: Context<Resolve>, sig: u64) -> Result<()> {
        Resolve::verify(&ctx)?;
        Resolve::handler(ctx, sig)
    }
}
#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut)] pub state: Account<'info, S>,
}
impl<'info> Resolve<'info> {
    pub fn verify(ctx: &Context<Resolve>) -> Result<()> {
        msg!("verifying");
        Ok(())
    }
    pub fn handler(ctx: Context<Resolve>, sig: u64) -> Result<()> {
        let s = &mut ctx.accounts.state;
        s.value = sig;
        Ok(())
    }
}
#[account] pub struct S { pub value: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    // verify() inlined → msg! present
    expect(ix.body.some((s) => s.kind === "msg")).toBe(true);
    // handler() inlined → state_read + state_field_assign present
    expect(ix.body.some((s) => s.kind === "state_read")).toBe(true);
    expect(ix.body.some((s) => s.kind === "state_field_assign")).toBe(true);
    // Neither call should remain unresolved
    const stringified = JSON.stringify(ix.body);
    expect(/Resolve::verify/.test(stringified)).toBe(false);
    expect(/Resolve::handler/.test(stringified)).toBe(false);
  });

  test("self.X is rewritten to ctx.accounts.X — no self. references survive", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> {
        ctx.accounts.go()
    }
}
#[derive(Accounts)]
pub struct Run<'info> {
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub authority: Signer<'info>,
}
impl<'info> Run<'info> {
    pub fn go(&self) -> Result<()> {
        let prog = self.token_program.to_account_info();
        let auth = self.authority.to_account_info();
        Ok(())
    }
}
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    expect(ix.body.length).toBeGreaterThan(0);
    // No self. references should remain anywhere in the IR for this instruction.
    const stringified = JSON.stringify(ix);
    expect(/\bself\./.test(stringified)).toBe(false);
    // And the rewrite should land — at least one body reference to ctx.accounts.token_program.
    expect(/ctx\.accounts\.token_program/.test(stringified)).toBe(true);
  });

  test("trailing Ok(()) in impl body does not duplicate in the inlined output", async () => {
    // Wrapper has its own Ok(()), impl method body also ends with Ok(()).
    // After inlining, only the wrapper's Ok(()) should survive — exactly one.
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn foo(ctx: Context<Foo>, amount: u64) -> Result<()> {
        ctx.accounts.do_thing(amount)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Foo<'info> {
    #[account(mut)] pub counter: Account<'info, Ctr>,
}
impl<'info> Foo<'info> {
    pub fn do_thing(&mut self, amount: u64) -> Result<()> {
        self.counter.count = amount;
        Ok(())
    }
}
#[account] pub struct Ctr { pub count: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    const okCount = (ix.rawBody.match(/Ok\s*\(\s*\(\s*\)\s*\)/g) ?? []).length;
    expect(okCount).toBe(1);
  });

  test("From<&mut Accounts> for CpiContext is inlined at ctx.accounts.into() call site", async () => {
    const src = PROG_HEADER + `
use anchor_spl::token::{self, SetAuthority};
#[program]
pub mod p {
    use super::*;
    pub fn freeze(ctx: Context<Freeze>) -> Result<()> {
        token::set_authority(
            ctx.accounts.into(),
            anchor_spl::token::spl_token::instruction::AuthorityType::AccountOwner,
            Some(Pubkey::new_unique()),
        )?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Freeze<'info> {
    #[account(mut)] pub account: Account<'info, S>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
}
impl<'info> From<&mut Freeze<'info>> for CpiContext<'_, '_, '_, 'info, SetAuthority<'info>> {
    fn from(accounts: &mut Freeze<'info>) -> Self {
        let cpi_accounts = SetAuthority {
            account_or_mint: accounts.account.to_account_info(),
            current_authority: accounts.authority.to_account_info(),
        };
        let cpi_program_id = accounts.token_program.to_account_info();
        CpiContext::new(cpi_program_id, cpi_accounts)
    }
}
#[account] pub struct S { pub x: u64 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    // The classifier should recognize the inlined CpiContext::new(...) and
    // emit a cpi_spl_set_authority statement. Without From-trait inlining,
    // this would have stayed as ctx.accounts.into() and classified as pass_through.
    const setAuth = ix.body.find((s) => s.kind === "cpi_spl_set_authority");
    expect(setAuth).toBeDefined();
    expect(ix.rawBody).toContain("CpiContext::new");
    expect(ix.rawBody).toContain("ctx.accounts.account.to_account_info()");
    expect(ix.rawBody).not.toContain("ctx.accounts.into()");
  });

  test("&ctx.bumps argument is substituted into impl body bumps refs", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn make(ctx: Context<Make>, seed: u64) -> Result<()> {
        ctx.accounts.init(seed, &ctx.bumps)
    }
}
#[derive(Accounts)]
pub struct Make<'info> {
    #[account(mut)] pub state: Account<'info, S>,
}
impl<'info> Make<'info> {
    pub fn init(&mut self, seed: u64, bumps: &MakeBumps) -> Result<()> {
        self.state.seed = seed;
        self.state.bump = bumps.state;
        Ok(())
    }
}
#[account] pub struct S { pub seed: u64, pub bump: u8 }
`;
    const ir = await parseOk(src);
    const ix = ir.instructions[0]!;
    // The `bumps` param should have been substituted with the wrapper's
    // call-site arg `&ctx.bumps`, producing either `(&ctx.bumps).state` or
    // `ctx.bumps.state` somewhere in the IR. The original `bumps.state`
    // form must NOT survive (would mean the substitution missed).
    const stringified = JSON.stringify(ix.body);
    const hasSubstituted = /\(&ctx\.bumps\)\.\w+/.test(stringified) || /ctx\.bumps\.\w+/.test(stringified);
    expect(hasSubstituted).toBe(true);
    // Verify the unresolved form is gone.
    expect(/(?<!\.)\bbumps\.\w+/.test(stringified)).toBe(false);
  });

  test("constraint = <expr_with_LE_or_GE> splits into separate IR constraints", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Run<'info> {
    #[account(
        mut,
        constraint = state.amount <= other.amount,
        constraint = state.threshold >= 1,
        close = recipient
    )]
    pub state: Account<'info, S>,
    pub other: Account<'info, S>,
    /// CHECK:
    pub recipient: AccountInfo<'info>,
}
#[account] pub struct S { pub amount: u64, pub threshold: u64 }
`;
    const ir = await parseOk(src);
    const stateAcc = ir.instructions[0]!.accounts.find((a) => a.name === "state")!;
    const constraintEntries = stateAcc.constraints.filter((c) => c.kind === "constraint");
    // The `<=` and `>=` inside constraint values previously leaked into a
    // single concatenated value because angle-depth tracking didn't
    // distinguish operator `<` from generic open. Each constraint must
    // now stand on its own.
    expect(constraintEntries.length).toBe(2);
    expect(constraintEntries[0]!.value).toContain("<=");
    expect(constraintEntries[1]!.value).toContain(">=");
    // close= constraint preserved alongside.
    const closeEntry = stateAcc.constraints.find((c) => c.kind === "close");
    expect(closeEntry?.value).toBe("recipient");
  });

  test("body emitter strips *X.key deref when comparison sibling is &<expr>", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn check(ctx: Context<Check>) -> Result<()> {
        let acc_pubkey = Pubkey::new_unique();
        if &acc_pubkey == ctx.accounts.signer.key {
            return Ok(());
        }
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Check<'info> {
    pub signer: Signer<'info>,
}
`;
    const ir = await parseOk(src);
    const out = emitNativeFull(ir);
    const ix = out.files.find((f) => /instructions\/check\.rs$/.test(f.path));
    expect(ix).toBeDefined();
    if (!ix) return;
    // Either side stays `&Pubkey` — neither side should be a by-value deref.
    expect(ix.content).toContain("&acc_pubkey == signer.key");
    expect(ix.content).not.toMatch(/&acc_pubkey\s*==\s*\*signer\.key/);
  });

  test("body emitter strips *X.key inside iter-chain closure param comparison", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn check(ctx: Context<Check>) -> Result<()> {
        let owners: Vec<Pubkey> = vec![];
        let _idx = owners.iter().position(|a| a == ctx.accounts.signer.key);
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Check<'info> {
    pub signer: Signer<'info>,
}
`;
    const ir = await parseOk(src);
    const out = emitNativeFull(ir);
    const ix = out.files.find((f) => /instructions\/check\.rs$/.test(f.path));
    expect(ix).toBeDefined();
    if (!ix) return;
    // Closure param `a` is `&Pubkey`; comparison sibling must also be `&Pubkey`.
    expect(ix.content).toContain("|a| a == signer.key");
    expect(ix.content).not.toMatch(/\|a\|\s*a\s*==\s*\*signer\.key/);
  });

  test("T22 extension types auto-imported on native when body references them", async () => {
    const src = PROG_HEADER + `
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions,
        },
        state::Mint as MintState,
    },
    token_interface::{Mint, Token2022, TokenAccount},
};
#[program]
pub mod p {
    use super::*;
    pub fn check(ctx: Context<Check>) -> Result<()> {
        let mint_data = ctx.accounts.mint.to_account_info().data.borrow();
        let _state = StateWithExtensions::<MintState>::unpack(&mint_data)?;
        let _config = _state.get_extension::<TransferFeeConfig>()?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Check<'info> {
    pub mint: Account<'info, S>,
}
#[account] pub struct S { pub x: u64 }
`;
    const ir = await parseOk(src);
    const out = emitNativeFull(ir);
    const lib = out.files.find((f) => f.path === "lib.rs");
    expect(lib).toBeDefined();
    if (!lib) return;
    // Auto-imports added — `anchor_spl::*` was filtered, but the body
    // still references TransferFeeConfig / StateWithExtensions / MintState.
    expect(lib.content).toContain("use spl_token_2022::extension::transfer_fee::TransferFeeConfig;");
    expect(lib.content).toContain("use spl_token_2022::extension::StateWithExtensions;");
    expect(lib.content).toContain("use spl_token_2022::state::Mint as MintState;");
  });

  test("user-defined From impl between user types is preserved on native", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Run<'info> { pub state: Account<'info, S> }
#[account] pub struct S { pub x: u64 }

#[derive(Clone)]
pub struct MyKey { pub bytes: [u8; 32] }

impl From<MyKey> for [u8; 32] {
    fn from(k: MyKey) -> Self { k.bytes }
}
`;
    const ir = await parseOk(src);
    expect(ir.userTraitImpls.length).toBeGreaterThan(0);
    const out = emitNativeFull(ir);
    const lib = out.files.find((f) => f.path === "lib.rs");
    expect(lib).toBeDefined();
    expect(lib!.content).toContain("impl From<MyKey> for [u8; 32]");
    // Pinocchio emit drops user trait impls — secondary Into::into
    // chains are unreachable there since the post-process commentout
    // strips their consumers.
    const pin = emitPinocchioFull(ir);
    const pinLib = pin.files.find((f) => f.path === "lib.rs");
    expect(pinLib).toBeDefined();
    expect(pinLib!.content).not.toContain("impl From<MyKey> for [u8; 32]");
  });

  test("Anchor-flavored trait impl with <'info> is filtered out", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Run<'info> { pub state: Account<'info, S> }
#[account] pub struct S { pub x: u64 }

pub struct OrderbookClient<'info> { pub _marker: std::marker::PhantomData<&'info ()> }

impl<'info> From<&Run<'info>> for OrderbookClient<'info> {
    fn from(_: &Run<'info>) -> Self { OrderbookClient { _marker: std::marker::PhantomData } }
}
`;
    const ir = await parseOk(src);
    // The lifetime-parameterized impl was filtered — would have caused
    // E0412 "OrderbookClient cannot be found" in the emitted file otherwise.
    expect(ir.userTraitImpls.length).toBe(0);
  });

  test("(&*ctx.accounts.state).into() collapses to (&state).into() on native", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>, _x: u64) -> Result<()> {
        let _y = (&*ctx.accounts.state).into();
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Run<'info> { pub state: Account<'info, S> }
#[account] pub struct S { pub x: u64 }
`;
    const ir = await parseOk(src);
    const out = emitNativeFull(ir);
    const ix = out.files.find((f) => /instructions\/run\.rs$/.test(f.path));
    expect(ix).toBeDefined();
    if (!ix) return;
    // The emitted code must not contain `&*` followed by a state-local
    // identifier — that produces E0614 "type cannot be dereferenced"
    // since the state-read pass already deref'd into a value local.
    expect(ix.content).not.toMatch(/&\s*\*\s*state\b/);
  });

  test("unsalvageable-helper commentout preserves preceding block-closer `};`", async () => {
    // Reproduces coral-swap: an unsalvageable helper (signature uses
    // anchor wrapper types) is invoked immediately after a `let X = { … };`
    // block. The walk-back to the previous `;` lands on `};` — the
    // previous version of this pass swept that line into the comment range,
    // leaving `let X = { … }` open without a closer (E0RUST_PARSE
    // unclosed-delimiter). The block-closer-aware fix advances past
    // `};` to keep delimiters balanced.
    const src = PROG_HEADER + `
use anchor_spl::token::{self, TokenAccount};
fn unsalvageable_helper(x: &Account<'_, S>) -> Result<()> { Ok(()) }
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> {
        let scoped_value = {
            let inner = 1;
            inner + 1
        };
        unsalvageable_helper(&ctx.accounts.state)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Run<'info> {
    pub state: Account<'info, S>,
}
#[account] pub struct S { pub x: u64 }
`;
    const ir = await parseOk(src);
    const out = emitNativeFull(ir);
    const ix = out.files.find((f) => /instructions\/run\.rs$/.test(f.path));
    expect(ix).toBeDefined();
    if (!ix) return;
    // The `};` block-closer of `let scoped_value = { … };` must NOT be
    // commented. The helper call MUST be commented.
    const lines = ix.content.split("\n");
    const closerActive = lines.some((l) =>
      /^\s*\};/.test(l) && !l.trimStart().startsWith("//"),
    );
    const helperCommented = lines.some(
      (l) => /^\s*\/\/.*unsalvageable_helper/.test(l),
    );
    expect(closerActive).toBe(true);
    expect(helperCommented).toBe(true);
  });

  test("solana_program::program::invoke_signed direct call is commented out on pinocchio", async () => {
    const src = PROG_HEADER + `
#[program]
pub mod p {
    use super::*;
    pub fn run(ctx: Context<Run>) -> Result<()> {
        let mut ix: Instruction = Instruction { program_id: Pubkey::default(), accounts: vec![], data: vec![] };
        ix.accounts = vec![];
        let signer = &[&[][..]];
        let accounts = ctx.remaining_accounts;
        solana_program::program::invoke_signed(&ix, &accounts, signer)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Run<'info> {
    pub authority: Signer<'info>,
}
`;
    const ir = await parseOk(src);
    const out = emitPinocchioFull(ir);
    const ix = out.files.find((f) => /instructions\/run\.rs$/.test(f.path));
    expect(ix).toBeDefined();
    if (!ix) return;
    expect(ix.content).toContain("Anvil TODO: solana_program direct call");
    // Both the typed-Instruction decl and the invoke_signed call must be
    // commented (line starts with `//`, possibly preceded by whitespace).
    const lines = ix.content.split("\n");
    const declCommented = lines.some((l) => /^\s*\/\/.*let\s+mut\s+ix\s*:\s*Instruction/.test(l));
    const callCommented = lines.some((l) => /^\s*\/\/.*solana_program::program::invoke_signed/.test(l));
    expect(declCommented).toBe(true);
    expect(callCommented).toBe(true);
    // No active (non-`//`) line containing the invoke.
    const activeLines = lines.filter((l) => !l.trimStart().startsWith("//"));
    expect(activeLines.some((l) => l.includes("solana_program::program::invoke_signed"))).toBe(false);
  });
});
