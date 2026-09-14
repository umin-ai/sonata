// SPDX-License-Identifier: GPL-3.0-or-later
use anchor_lang::prelude::*;
declare_id!("E45Bq8CUh12Fncuyd5GMHKgkmjpVp8n2C7521ExryDwg");

/// A clearly separate, signer-controlled DEMO price source. No production oracle claim.
#[program]
pub mod demo_oracle {
    use super::*;
    pub fn initialize(
        ctx: Context<Initialize>,
        collateral_mint: Pubkey,
        debt_mint: Pubkey,
        price: u64,
    ) -> Result<()> {
        require!(
            price > 0 && collateral_mint != debt_mint,
            OracleError::InvalidPrice
        );
        *ctx.accounts.price = DemoPrice {
            authority: ctx.accounts.authority.key(),
            collateral_mint,
            debt_mint,
            price,
            confidence: 0,
            published_at: Clock::get()?.unix_timestamp,
            trading: true,
        };
        Ok(())
    }
    pub fn publish(
        ctx: Context<Publish>,
        price: u64,
        confidence: u64,
        trading: bool,
    ) -> Result<()> {
        require!(price > 0 && confidence < price, OracleError::InvalidPrice);
        let feed = &mut ctx.accounts.price;
        feed.price = price;
        feed.confidence = confidence;
        feed.trading = trading;
        feed.published_at = Clock::get()?.unix_timestamp;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init,payer=authority,space=8+DemoPrice::INIT_SPACE)]
    pub price: Account<'info, DemoPrice>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Publish<'info> {
    pub authority: Signer<'info>,
    #[account(mut,has_one=authority)]
    pub price: Account<'info, DemoPrice>,
}
#[account]
#[derive(InitSpace)]
pub struct DemoPrice {
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub debt_mint: Pubkey,
    /// Quote-token atoms per 10^8 raw collateral atoms. No UI multiplier applied here.
    pub price: u64,
    pub confidence: u64,
    pub published_at: i64,
    pub trading: bool,
}
#[error_code]
pub enum OracleError {
    #[msg("Invalid demo price")]
    InvalidPrice,
}
