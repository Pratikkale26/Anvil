use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer, CloseAccount};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("MktP1ace11111111111111111111111111111111111");

#[program]
pub mod marketplace {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 10000, MarketplaceError::InvalidFeeBps);

        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.admin = ctx.accounts.admin.key();
        marketplace.fee_bps = fee_bps;
        marketplace.treasury = ctx.accounts.treasury.key();
        marketplace.bump = ctx.bumps.marketplace;
        marketplace.listing_count = 0;

        Ok(())
    }

    pub fn list(
        ctx: Context<List>,
        price: u64,
        seed: u64,
    ) -> Result<()> {
        require!(price > 0, MarketplaceError::InvalidPrice);

        let listing = &mut ctx.accounts.listing;
        listing.seller = ctx.accounts.seller.key();
        listing.mint = ctx.accounts.nft_mint.key();
        listing.price = price;
        listing.seed = seed;
        listing.bump = ctx.bumps.listing;
        listing.marketplace = ctx.accounts.marketplace.key();
        listing.vault = ctx.accounts.vault.key();
        listing.is_active = true;

        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.listing_count = marketplace.listing_count
            .checked_add(1)
            .ok_or(MarketplaceError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            1,
        )?;

        Ok(())
    }

    pub fn delist(ctx: Context<Delist>) -> Result<()> {
        let listing = &ctx.accounts.listing;

        require!(listing.is_active, MarketplaceError::ListingNotActive);
        require!(
            listing.seller == ctx.accounts.seller.key(),
            MarketplaceError::Unauthorized
        );

        let seeds = &[
            b"listing",
            listing.seller.as_ref(),
            &listing.seed.to_le_bytes(),
            &[listing.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_ata.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                signer_seeds,
            ),
            1,
        )?;

        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.vault.to_account_info(),
                    destination: ctx.accounts.seller.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.listing_count = marketplace.listing_count
            .checked_sub(1)
            .ok_or(MarketplaceError::Underflow)?;

        Ok(())
    }

    pub fn purchase(ctx: Context<Purchase>) -> Result<()> {
        let listing = &ctx.accounts.listing;

        require!(listing.is_active, MarketplaceError::ListingNotActive);

        let fee = listing.price
            .checked_mul(ctx.accounts.marketplace.fee_bps as u64)
            .ok_or(MarketplaceError::Overflow)?
            .checked_div(10000)
            .ok_or(MarketplaceError::Overflow)?;

        let seller_amount = listing.price
            .checked_sub(fee)
            .ok_or(MarketplaceError::Underflow)?;

        // Pay seller
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.seller.to_account_info(),
                },
            ),
            seller_amount,
        )?;

        // Pay treasury fee
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;

        let seeds = &[
            b"listing",
            listing.seller.as_ref(),
            &listing.seed.to_le_bytes(),
            &[listing.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer NFT to buyer
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                signer_seeds,
            ),
            1,
        )?;

        // Close vault
        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.vault.to_account_info(),
                    destination: ctx.accounts.seller.to_account_info(),
                    authority: ctx.accounts.listing.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.listing_count = marketplace.listing_count
            .checked_sub(1)
            .ok_or(MarketplaceError::Underflow)?;

        Ok(())
    }

    pub fn update_fee(ctx: Context<UpdateFee>, new_fee_bps: u16) -> Result<()> {
        require!(new_fee_bps <= 10000, MarketplaceError::InvalidFeeBps);
        require!(
            ctx.accounts.marketplace.admin == ctx.accounts.admin.key(),
            MarketplaceError::Unauthorized
        );

        ctx.accounts.marketplace.fee_bps = new_fee_bps;

        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Marketplace::LEN,
        seeds = [b"marketplace"],
        bump
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: treasury just receives fees
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(price: u64, seed: u64)]
pub struct List<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    pub nft_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
    )]
    pub seller_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = seller,
        space = 8 + Listing::LEN,
        seeds = [b"listing", seller.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        mut,
        seeds = [b"marketplace"],
        bump = marketplace.bump,
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(
        init,
        payer = seller,
        token::mint = nft_mint,
        token::authority = listing,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Delist<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    pub nft_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = seller,
    )]
    pub seller_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"listing", seller.key().as_ref(), &listing.seed.to_le_bytes()],
        bump = listing.bump,
        close = seller,
        has_one = marketplace @ MarketplaceError::Unauthorized,
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        mut,
        seeds = [b"marketplace"],
        bump = marketplace.bump,
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(
        mut,
        constraint = vault.key() == listing.vault @ MarketplaceError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Purchase<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: seller receives payment
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,

    pub nft_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = nft_mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"listing", seller.key().as_ref(), &listing.seed.to_le_bytes()],
        bump = listing.bump,
        close = seller,
        has_one = marketplace @ MarketplaceError::Unauthorized,
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        mut,
        seeds = [b"marketplace"],
        bump = marketplace.bump,
    )]
    pub marketplace: Account<'info, Marketplace>,

    /// CHECK: receives fees
    #[account(
        mut,
        constraint = treasury.key() == marketplace.treasury
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = vault.key() == listing.vault @ MarketplaceError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFee<'info> {
    #[account(
        mut,
        seeds = [b"marketplace"],
        bump = marketplace.bump,
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

// ── State ────────────────────────────────────────────────────────────────────

#[account]
pub struct Marketplace {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub treasury: Pubkey,
    pub bump: u8,
    pub listing_count: u64,
}

impl Marketplace {
    pub const LEN: usize = 32 + 2 + 32 + 1 + 8; // = 75
}

#[account]
pub struct Listing {
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub seed: u64,
    pub bump: u8,
    pub marketplace: Pubkey,
    pub vault: Pubkey,
    pub is_active: bool,
}

impl Listing {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1 + 32 + 32 + 1; // = 146
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum MarketplaceError {
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Fee must be between 0 and 10000 bps")]
    InvalidFeeBps,
    #[msg("Listing is not active")]
    ListingNotActive,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
    #[msg("Invalid vault account")]
    InvalidVault,
}