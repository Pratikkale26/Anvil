use anchor_lang::prelude::*;

declare_id!("ZcpFoo1xperiment11111111111111111111111111K");

#[program]
pub mod zero_copy_foo {
    use super::*;

    pub fn create_foo(ctx: Context<CreateFoo>) -> Result<()> {
        let mut foo = ctx.accounts.foo.load_init()?;
        foo.authority = *ctx.accounts.authority.key;
        foo.data = 0;
        Ok(())
    }

    pub fn update_foo(ctx: Context<UpdateFoo>, data: u64) -> Result<()> {
        let mut foo = ctx.accounts.foo.load_mut()?;
        foo.data = data;
        Ok(())
    }

    pub fn read_foo(ctx: Context<ReadFoo>) -> Result<()> {
        // Exercises the immutable load() variant — produces the
        // `zero_copy_load` IR kind for the differential-coverage matrix.
        // Don't dereference packed fields directly via msg! / println! —
        // zero_copy(unsafe) emits repr(packed) which makes `foo.data`
        // references undefined behavior (E0793).
        let _foo = ctx.accounts.foo.load()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateFoo<'info> {
    #[account(zero)]
    pub foo: AccountLoader<'info, Foo>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateFoo<'info> {
    #[account(mut, has_one = authority)]
    pub foo: AccountLoader<'info, Foo>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReadFoo<'info> {
    #[account(has_one = authority)]
    pub foo: AccountLoader<'info, Foo>,
    pub authority: Signer<'info>,
}

#[account(zero_copy(unsafe))]
#[derive(Default)]
pub struct Foo {
    pub authority: Pubkey,
    pub data: u64,
}
