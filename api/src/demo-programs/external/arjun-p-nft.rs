use anchor_lang::prelude::*;

declare_id!("ArjnNft1111111111111111111111111111111111111");

#[program]
pub mod anchor_p_nft {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
