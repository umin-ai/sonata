// SPDX-License-Identifier: GPL-3.0-or-later
// Independent Stockroom devnet deployment. Historical provenance is preserved in the workspace archive.
// DBC ownership, creator authorization and immutable payout destination are enforced here.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj");

pub const VAULT_SEED: &[u8] = b"stockroom";
pub const TREASURY_SEED: &[u8] = b"treasury";

/// Payout share in basis points, fixed at treasury creation.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 100% paid out now, nothing retained (StonkFun-style).
    Refrain,
    /// 50% paid out, 50% retained.
    Duet,
    /// 0% of principal paid out; only yield on the retained position is ever distributed.
    Sustain,
}

impl Mode {
    pub fn payout_bps(&self) -> u64 {
        match self {
            Mode::Refrain => 10_000,
            Mode::Duet => 5_000,
            Mode::Sustain => 0,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub admin: Pubkey,
    pub bump: u8,
    pub treasuries: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub quote_mint: Pubkey,
    pub base_mint: Pubkey,
    pub creator: Pubkey,
    pub payout_owner: Pubkey,
    pub mode: Mode,
    pub bump: u8,
    /// Raw quote units (the stock) claimed from DBC, lifetime.
    pub total_claimed: u64,
    /// Raw quote units sent to the payout account, lifetime.
    pub total_distributed: u64,
    /// Raw quote units retained in the treasury token account, lifetime.
    pub total_retained: u64,
    /// Raw quote units withdrawn to the creator, lifetime; not a credit or yield position.
    pub total_withdrawn: u64,
    pub last_claim_ts: i64,
}

#[program]
pub mod stockroom_treasury {
    use super::*;

    pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.admin = ctx.accounts.admin.key();
        v.bump = ctx.bumps.vault;
        v.treasuries = 0;
        Ok(())
    }

    /// Register a treasury for a DBC pool whose config names the Vault as fee_claimer.
    pub fn init_treasury(
        ctx: Context<InitTreasury>,
        mode: Mode,
        payout_owner: Pubkey,
    ) -> Result<()> {
        let pool = ctx.accounts.pool.load()?;
        let config = ctx.accounts.config.load()?;
        require_keys_eq!(
            pool.creator,
            ctx.accounts.creator.key(),
            TreasuryError::Unauthorized
        );
        require_keys_eq!(
            pool.config,
            ctx.accounts.config.key(),
            TreasuryError::InvalidPool
        );
        require_keys_eq!(
            pool.base_mint,
            ctx.accounts.base_mint.key(),
            TreasuryError::InvalidPool
        );
        require_keys_eq!(
            config.quote_mint,
            ctx.accounts.quote_mint.key(),
            TreasuryError::InvalidPool
        );
        require_keys_eq!(
            config.fee_claimer,
            ctx.accounts.vault.key(),
            TreasuryError::InvalidPool
        );
        require!(
            payout_owner != Pubkey::default(),
            TreasuryError::InvalidRecipient
        );
        let t = &mut ctx.accounts.treasury;
        t.pool = ctx.accounts.pool.key();
        t.config = ctx.accounts.config.key();
        t.quote_mint = ctx.accounts.quote_mint.key();
        t.base_mint = ctx.accounts.base_mint.key();
        t.creator = ctx.accounts.creator.key();
        t.payout_owner = payout_owner;
        t.mode = mode;
        t.bump = ctx.bumps.treasury;
        ctx.accounts.vault.treasuries = ctx
            .accounts
            .vault
            .treasuries
            .checked_add(1)
            .ok_or(TreasuryError::Math)?;
        Ok(())
    }

    /// Pull accrued partner fees from the DBC pool into the treasury, signed by the Vault PDA.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let before = ctx.accounts.treasury_quote.amount;
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.accounts.vault.bump]];
        let signer = &[seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::ClaimTradingFeesCtx {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                pool: ctx.accounts.pool.to_account_info(),
                token_a_account: ctx.accounts.treasury_base.to_account_info(),
                token_b_account: ctx.accounts.treasury_quote.to_account_info(),
                base_vault: ctx.accounts.base_vault.to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                base_mint: ctx.accounts.base_mint.to_account_info(),
                quote_mint: ctx.accounts.quote_mint.to_account_info(),
                fee_claimer: ctx.accounts.vault.to_account_info(),
                token_base_program: ctx.accounts.token_base_program.to_account_info(),
                token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
                event_authority: ctx.accounts.dbc_event_authority.to_account_info(),
                program: ctx.accounts.dbc_program.to_account_info(),
            },
            signer,
        );
        dynamic_bonding_curve::cpi::claim_trading_fee(cpi, u64::MAX, u64::MAX)?;
        ctx.accounts.treasury_quote.reload()?;
        let got = ctx
            .accounts
            .treasury_quote
            .amount
            .checked_sub(before)
            .ok_or(TreasuryError::Math)?;
        let t = &mut ctx.accounts.treasury;
        t.total_claimed = t
            .total_claimed
            .checked_add(got)
            .ok_or(TreasuryError::Math)?;
        t.last_claim_ts = Clock::get()?.unix_timestamp;
        emit!(Claimed {
            pool: t.pool,
            amount: got
        });
        Ok(())
    }

    /// Split what has been claimed but not yet allocated: payout share out, remainder retained.
    pub fn distribute(ctx: Context<Distribute>) -> Result<()> {
        let (pool, bump, unallocated, payout_bps) = {
            let t = &ctx.accounts.treasury;
            let unallocated = t
                .total_claimed
                .saturating_sub(t.total_distributed)
                .saturating_sub(t.total_retained);
            (t.pool, t.bump, unallocated, t.mode.payout_bps())
        };
        require!(unallocated > 0, TreasuryError::NothingToDistribute);
        let payout = unallocated
            .checked_mul(payout_bps)
            .ok_or(TreasuryError::Math)?
            / 10_000;
        let retain = unallocated - payout;
        if payout > 0 {
            let seeds: &[&[u8]] = &[TREASURY_SEED, pool.as_ref(), &[bump]];
            anchor_spl::token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_quote_program.key(),
                    anchor_spl::token_interface::TransferChecked {
                        from: ctx.accounts.treasury_quote.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.payout_quote.to_account_info(),
                        authority: ctx.accounts.treasury.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
                ctx.accounts.quote_mint.decimals,
            )?;
        }
        let t = &mut ctx.accounts.treasury;
        t.total_distributed = t
            .total_distributed
            .checked_add(payout)
            .ok_or(TreasuryError::Math)?;
        t.total_retained = t
            .total_retained
            .checked_add(retain)
            .ok_or(TreasuryError::Math)?;
        emit!(Distributed {
            pool: t.pool,
            payout,
            retained: retain
        });
        Ok(())
    }

    /// Return only retained stock to its creator. This is not a yield or collateral position.
    pub fn withdraw_retained(ctx: Context<WithdrawRetained>, amount: u64) -> Result<()> {
        let t = &ctx.accounts.treasury;
        require!(
            amount > 0
                && amount
                    <= t.total_retained
                        .checked_sub(t.total_withdrawn)
                        .ok_or(TreasuryError::Math)?,
            TreasuryError::NothingToRoute
        );
        let pool = t.pool;
        let bump = t.bump;
        let seeds: &[&[u8]] = &[TREASURY_SEED, pool.as_ref(), &[bump]];
        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_quote_program.key(),
                anchor_spl::token_interface::TransferChecked {
                    from: ctx.accounts.treasury_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.creator_quote.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;
        let t = &mut ctx.accounts.treasury;
        t.total_withdrawn = t
            .total_withdrawn
            .checked_add(amount)
            .ok_or(TreasuryError::Math)?;
        emit!(RetainedWithdrawn { pool, amount });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct WithdrawRetained<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.pool.as_ref()], bump = treasury.bump, has_one = quote_mint, has_one = creator)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub creator: Signer<'info>,
    #[account(mut, token::mint = quote_mint, token::authority = treasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = creator)]
    pub creator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_quote_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(init, payer = admin, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, space = 8 + Treasury::INIT_SPACE, seeds = [TREASURY_SEED, pool.key().as_ref()], bump)]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: DBC virtual pool; validated by the DBC program on claim.
    pub pool: AccountLoader<'info, dynamic_bonding_curve::state::VirtualPool>,
    /// CHECK: DBC pool config; must name `vault` as fee_claimer (checked on claim by DBC).
    pub config: AccountLoader<'info, dynamic_bonding_curve::state::PoolConfig>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: recorded for attribution only.
    pub creator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [TREASURY_SEED, pool.key().as_ref()], bump = treasury.bump, has_one = pool, has_one = config, has_one = quote_mint, has_one = base_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    /// CHECK: DBC constant pool authority PDA.
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC config.
    pub config: UncheckedAccount<'info>,
    /// CHECK: DBC pool.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    #[account(mut, token::mint = base_mint, token::authority = treasury)]
    pub treasury_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = treasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DBC base vault.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC quote vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
    /// CHECK: DBC event authority PDA (seeds ["__event_authority"]); validated by the DBC program.
    pub dbc_event_authority: UncheckedAccount<'info>,
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.pool.as_ref()], bump = treasury.bump, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, token::mint = quote_mint, token::authority = treasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, constraint = payout_quote.owner == treasury.payout_owner @ TreasuryError::InvalidRecipient)]
    pub payout_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_quote_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct Claimed {
    pub pool: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Distributed {
    pub pool: Pubkey,
    pub payout: u64,
    pub retained: u64,
}

#[event]
pub struct RetainedWithdrawn {
    pub pool: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum TreasuryError {
    #[msg("Creator signature required")]
    Unauthorized,
    #[msg("Pool configuration mismatch")]
    InvalidPool,
    #[msg("Payout recipient is fixed at creation")]
    InvalidRecipient,
    #[msg("Nothing claimed since the last distribution")]
    NothingToDistribute,
    #[msg("Arithmetic overflow")]
    Math,
    #[msg("Amount exceeds retained stock not yet routed")]
    NothingToRoute,
}
