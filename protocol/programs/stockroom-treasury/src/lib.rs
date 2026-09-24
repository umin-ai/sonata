// SPDX-License-Identifier: GPL-3.0-or-later
// Independent Stockroom devnet deployment. Historical provenance is preserved in the workspace archive.
// DBC ownership, creator authorization and immutable payout destination are enforced here.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("GPANv5zMEmvkVKQxJgLds2B4bEbnub6HhS2WQq71fjNj");

pub const VAULT_SEED: &[u8] = b"stockroom";
pub const TREASURY_SEED: &[u8] = b"treasury";
/// Meteora DAMM v2, where graduated Sonata pools live (same address on every cluster).
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// DAMM v2 `Pool` account: discriminator, and the offsets of its token A and B mints.
const DAMM_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const DAMM_POOL_TOKEN_A_MINT: usize = 168;
const DAMM_POOL_TOKEN_B_MINT: usize = 200;
/// DAMM v2 `claim_position_fee` instruction discriminator.
const DAMM_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

/// How claimed fees are split, fixed at treasury creation.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 100% paid out now, nothing retained (StonkFun-style).
    Refrain,
    /// 50% paid out, 50% retained.
    Duet,
    /// 0% of principal paid out; only yield on the retained position is ever distributed.
    Sustain,
    /// Stock Floor: 50% paid out, 50% retained as a floor that holders redeem by
    /// burning the community token. The creator can never withdraw it.
    Floor,
    // Variants are appended only, so every existing Treasury account decodes unchanged.
    /// Sonata platform share: 50% to the creator, 50% to Sonata. Split by
    /// `distribute_split`, not `distribute`.
    Standard,
    /// Sonata platform share with a Stock Floor: 25% to the creator, 25% retained
    /// as a floor that holders redeem (the creator can never withdraw it), 50% to
    /// Sonata. Split by `distribute_split`, not `distribute`.
    StandardFloor,
}

impl Mode {
    /// Share of each distribution paid to the payout owner, in basis points.
    pub fn payout_bps(&self) -> u64 {
        match self {
            Mode::Refrain => 10_000,
            Mode::Duet => 5_000,
            Mode::Sustain => 0,
            Mode::Floor => 5_000,
            Mode::Standard => 5_000,
            Mode::StandardFloor => 2_500,
        }
    }

    /// (creator_bps, floor_bps) for the modes split by `distribute_split`; the
    /// platform takes the rest, including rounding. None for the modes split by
    /// `distribute`.
    pub fn split_bps(&self) -> Option<(u64, u64)> {
        match self {
            Mode::Standard => Some((5_000, 0)),
            Mode::StandardFloor => Some((2_500, 2_500)),
            Mode::Refrain | Mode::Duet | Mode::Sustain | Mode::Floor => None,
        }
    }

    /// Whether distributions pay a share to the Sonata platform (Vault admin).
    pub fn has_platform_share(&self) -> bool {
        self.split_bps().is_some()
    }

    /// Whether the retained balance is a Stock Floor redeemable by holders.
    pub fn has_floor(&self) -> bool {
        matches!(self, Mode::Floor | Mode::StandardFloor)
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
    /// Raw quote units that left the retained balance, lifetime: to the creator, or in
    /// Floor mode to holders who redeemed. Not a credit or yield position. In Standard
    /// and StandardFloor modes the platform share is counted as retained and withdrawn
    /// in the same instruction, so retained - withdrawn stays the floor.
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

    /// Name the launchpad behind every pool whose config uses this Vault as fee
    /// claimer, through Meteora's partner metadata (name, website, logo). The Vault
    /// PDA signs as fee claimer; only the Vault admin can call it. DBC creates the
    /// metadata account once per fee claimer and has no update instruction, so this
    /// can succeed only once.
    pub fn create_partner_metadata(
        ctx: Context<CreatePartnerMetadata>,
        name: String,
        website: String,
        logo: String,
    ) -> Result<()> {
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.accounts.vault.bump]];
        let signer = &[seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::CreatePartnerMetadataCtx {
                partner_metadata: ctx.accounts.partner_metadata.to_account_info(),
                payer: ctx.accounts.admin.to_account_info(),
                fee_claimer: ctx.accounts.vault.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.dbc_event_authority.to_account_info(),
                program: ctx.accounts.dbc_program.to_account_info(),
            },
            signer,
        );
        dynamic_bonding_curve::cpi::create_partner_metadata(
            cpi,
            dynamic_bonding_curve::CreatePartnerMetadataParameters {
                padding: [0; 96],
                name,
                website,
                logo,
            },
        )
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

    /// After graduation: pull the trading fees earned by the Vault's permanently locked
    /// position in the market's DAMM v2 pool into the treasury, signed by the Vault PDA.
    /// They are then paid out by the treasury's mode like any other claim. Anyone may
    /// call it; fees only ever move into the treasury. The pool must hold this market's
    /// token and stock, so another market's fees can never be credited here; DAMM v2
    /// checks that the position is in that pool and that the Vault holds its NFT.
    pub fn claim_graduated(ctx: Context<ClaimGraduated>) -> Result<()> {
        {
            let pool = &ctx.accounts.damm_pool;
            require_keys_eq!(*pool.owner, DAMM_V2_PROGRAM_ID, TreasuryError::InvalidPool);
            let data = pool.try_borrow_data()?;
            require!(
                data.len() >= DAMM_POOL_TOKEN_B_MINT + 32 && data[..8] == DAMM_POOL_DISCRIMINATOR,
                TreasuryError::InvalidPool
            );
            let mint_at = |at: usize| Pubkey::try_from(&data[at..at + 32]).map_err(|_| TreasuryError::InvalidPool);
            require_keys_eq!(mint_at(DAMM_POOL_TOKEN_A_MINT)?, ctx.accounts.base_mint.key(), TreasuryError::InvalidPool);
            require_keys_eq!(mint_at(DAMM_POOL_TOKEN_B_MINT)?, ctx.accounts.quote_mint.key(), TreasuryError::InvalidPool);
        }
        let before = ctx.accounts.treasury_quote.amount;
        let a = &ctx.accounts;
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: DAMM_V2_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(a.damm_pool_authority.key(), false),
                AccountMeta::new_readonly(a.damm_pool.key(), false),
                AccountMeta::new(a.position.key(), false),
                AccountMeta::new(a.treasury_base.key(), false),
                AccountMeta::new(a.treasury_quote.key(), false),
                AccountMeta::new(a.token_a_vault.key(), false),
                AccountMeta::new(a.token_b_vault.key(), false),
                AccountMeta::new_readonly(a.base_mint.key(), false),
                AccountMeta::new_readonly(a.quote_mint.key(), false),
                AccountMeta::new_readonly(a.position_nft_account.key(), false),
                AccountMeta::new_readonly(a.vault.key(), true),
                AccountMeta::new_readonly(a.token_base_program.key(), false),
                AccountMeta::new_readonly(a.token_quote_program.key(), false),
                AccountMeta::new_readonly(a.damm_event_authority.key(), false),
                AccountMeta::new_readonly(a.damm_program.key(), false),
            ],
            data: DAMM_CLAIM_POSITION_FEE.to_vec(),
        };
        let seeds: &[&[u8]] = &[VAULT_SEED, &[a.vault.bump]];
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                a.damm_pool_authority.to_account_info(),
                a.damm_pool.to_account_info(),
                a.position.to_account_info(),
                a.treasury_base.to_account_info(),
                a.treasury_quote.to_account_info(),
                a.token_a_vault.to_account_info(),
                a.token_b_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.quote_mint.to_account_info(),
                a.position_nft_account.to_account_info(),
                a.vault.to_account_info(),
                a.token_base_program.to_account_info(),
                a.token_quote_program.to_account_info(),
                a.damm_event_authority.to_account_info(),
                a.damm_program.to_account_info(),
            ],
            &[seeds],
        )?;
        ctx.accounts.treasury_quote.reload()?;
        let got = ctx
            .accounts
            .treasury_quote
            .amount
            .checked_sub(before)
            .ok_or(TreasuryError::Math)?;
        let t = &mut ctx.accounts.treasury;
        t.total_claimed = t.total_claimed.checked_add(got).ok_or(TreasuryError::Math)?;
        t.last_claim_ts = Clock::get()?.unix_timestamp;
        emit!(Claimed { pool: t.pool, amount: got });
        Ok(())
    }

    /// Split what has been claimed but not yet allocated: payout share out, remainder retained.
    pub fn distribute(ctx: Context<Distribute>) -> Result<()> {
        require!(
            !ctx.accounts.treasury.mode.has_platform_share(),
            TreasuryError::UseDistributeSplit
        );
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

    /// Standard and StandardFloor: split what has been claimed but not yet allocated
    /// three ways. The creator share (rounded down) goes to the payout owner, the floor
    /// share (rounded down) stays in custody as the Stock Floor, and the platform takes
    /// the rest, paid to a token account of the Vault admin. Permissionless: every
    /// destination is pinned. The platform share is booked as retained and withdrawn
    /// at once, so retained - withdrawn remains the floor and custody still covers
    /// unallocated + (retained - withdrawn).
    pub fn distribute_split(ctx: Context<DistributeSplit>) -> Result<()> {
        let (pool, bump, unallocated, (creator_bps, floor_bps)) = {
            let t = &ctx.accounts.treasury;
            let split = t.mode.split_bps().ok_or(TreasuryError::UseDistribute)?;
            let unallocated = t
                .total_claimed
                .saturating_sub(t.total_distributed)
                .saturating_sub(t.total_retained);
            (t.pool, t.bump, unallocated, split)
        };
        require!(unallocated > 0, TreasuryError::NothingToDistribute);
        let share = |bps: u64| -> Result<u64> {
            u64::try_from((unallocated as u128) * (bps as u128) / 10_000)
                .map_err(|_| error!(TreasuryError::Math))
        };
        let creator = share(creator_bps)?;
        let floor = share(floor_bps)?;
        let platform = unallocated
            .checked_sub(creator)
            .and_then(|v| v.checked_sub(floor))
            .ok_or(TreasuryError::Math)?;
        let seeds: &[&[u8]] = &[TREASURY_SEED, pool.as_ref(), &[bump]];
        for (amount, to) in [
            (creator, ctx.accounts.payout_quote.to_account_info()),
            (platform, ctx.accounts.platform_quote.to_account_info()),
        ] {
            if amount > 0 {
                anchor_spl::token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_quote_program.key(),
                        anchor_spl::token_interface::TransferChecked {
                            from: ctx.accounts.treasury_quote.to_account_info(),
                            mint: ctx.accounts.quote_mint.to_account_info(),
                            to,
                            authority: ctx.accounts.treasury.to_account_info(),
                        },
                        &[seeds],
                    ),
                    amount,
                    ctx.accounts.quote_mint.decimals,
                )?;
            }
        }
        let t = &mut ctx.accounts.treasury;
        t.total_distributed = t
            .total_distributed
            .checked_add(creator)
            .ok_or(TreasuryError::Math)?;
        t.total_retained = t
            .total_retained
            .checked_add(floor)
            .and_then(|v| v.checked_add(platform))
            .ok_or(TreasuryError::Math)?;
        t.total_withdrawn = t
            .total_withdrawn
            .checked_add(platform)
            .ok_or(TreasuryError::Math)?;
        emit!(SplitDistributed {
            pool,
            creator,
            floor,
            platform
        });
        Ok(())
    }

    /// Return only retained stock to its creator. This is not a yield or collateral position.
    pub fn withdraw_retained(ctx: Context<WithdrawRetained>, amount: u64) -> Result<()> {
        let t = &ctx.accounts.treasury;
        require!(!t.mode.has_floor(), TreasuryError::FloorLocked);
        // Standard: the retained balance is only the platform share, already paid out.
        require!(
            !t.mode.has_platform_share(),
            TreasuryError::NoCreatorReserve
        );
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

    /// Stock Floor: burn community tokens for their share of the floor, paid in the
    /// quote stock. Share = floor * amount / base supply, rounded down. Supply counts
    /// tokens still in the curve or a graduated pool, so the per-token floor is
    /// conservative. Rounding down means a redemption never lowers the floor per
    /// remaining token.
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        let t = &ctx.accounts.treasury;
        require!(t.mode.has_floor(), TreasuryError::NotFloor);
        let floor = t
            .total_retained
            .checked_sub(t.total_withdrawn)
            .ok_or(TreasuryError::Math)?;
        let supply = ctx.accounts.base_mint.supply;
        require!(
            amount > 0 && amount <= supply,
            TreasuryError::NothingToRedeem
        );
        let payout = u64::try_from(
            (floor as u128)
                .checked_mul(amount as u128)
                .ok_or(TreasuryError::Math)?
                / (supply as u128),
        )
        .map_err(|_| TreasuryError::Math)?;
        require!(payout > 0, TreasuryError::NothingToRedeem);
        let pool = t.pool;
        let bump = t.bump;
        anchor_spl::token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_base_program.key(),
                anchor_spl::token_interface::Burn {
                    mint: ctx.accounts.base_mint.to_account_info(),
                    from: ctx.accounts.holder_base.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            amount,
        )?;
        let seeds: &[&[u8]] = &[TREASURY_SEED, pool.as_ref(), &[bump]];
        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_quote_program.key(),
                anchor_spl::token_interface::TransferChecked {
                    from: ctx.accounts.treasury_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.holder_quote.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
                &[seeds],
            ),
            payout,
            ctx.accounts.quote_mint.decimals,
        )?;
        let t = &mut ctx.accounts.treasury;
        t.total_withdrawn = t
            .total_withdrawn
            .checked_add(payout)
            .ok_or(TreasuryError::Math)?;
        emit!(Redeemed {
            pool,
            holder: ctx.accounts.holder.key(),
            burned: amount,
            payout
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.pool.as_ref()], bump = treasury.bump, has_one = quote_mint, has_one = base_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub holder: Signer<'info>,
    #[account(mut, token::mint = base_mint, token::authority = holder, token::token_program = token_base_program)]
    pub holder_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = holder, token::token_program = token_quote_program)]
    pub holder_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = treasury, token::token_program = token_quote_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, mint::token_program = token_base_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = token_quote_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
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
pub struct CreatePartnerMetadata<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump, has_one = admin @ TreasuryError::Unauthorized)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: DBC partner metadata PDA (seeds ["partner_metadata", vault]); DBC derives,
    /// creates and validates it.
    #[account(mut)]
    pub partner_metadata: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: DBC event authority PDA (seeds ["__event_authority"]); validated by the DBC program.
    pub dbc_event_authority: UncheckedAccount<'info>,
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
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
pub struct ClaimGraduated<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.pool.as_ref()], bump = treasury.bump, has_one = quote_mint, has_one = base_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    /// CHECK: DAMM v2 constant pool authority; checked by DAMM v2.
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: the market's graduated DAMM v2 pool; owner, discriminator and both mints are checked in the handler.
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: the Vault's position in that pool; DAMM v2 checks it belongs to the pool and its NFT.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    #[account(mut, token::mint = base_mint, token::authority = treasury)]
    pub treasury_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = treasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DAMM v2 token A vault; checked by DAMM v2 against the pool.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 token B vault; checked by DAMM v2 against the pool.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the Vault's token account holding the position NFT; DAMM v2 checks the holder signs.
    pub position_nft_account: UncheckedAccount<'info>,
    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
    /// CHECK: DAMM v2 event authority PDA; checked by DAMM v2.
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: must be Meteora DAMM v2.
    #[account(address = DAMM_V2_PROGRAM_ID)]
    pub damm_program: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct DistributeSplit<'info> {
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.pool.as_ref()], bump = treasury.bump, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, token::mint = quote_mint, token::authority = treasury)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, constraint = payout_quote.owner == treasury.payout_owner @ TreasuryError::InvalidRecipient)]
    pub payout_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// `dup`: when the payout owner is the Vault admin this is the same account as
    /// `payout_quote`. Token accounts are never serialized by this program, so the
    /// alias is harmless, and the owner check keeps it distinct from `treasury_quote`.
    #[account(mut, dup, token::mint = quote_mint, constraint = platform_quote.owner == vault.admin @ TreasuryError::InvalidPlatformRecipient)]
    pub platform_quote: Box<InterfaceAccount<'info, TokenAccount>>,
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
pub struct SplitDistributed {
    pub pool: Pubkey,
    pub creator: u64,
    pub floor: u64,
    pub platform: u64,
}

#[event]
pub struct RetainedWithdrawn {
    pub pool: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Redeemed {
    pub pool: Pubkey,
    pub holder: Pubkey,
    pub burned: u64,
    pub payout: u64,
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
    #[msg("Only Stock Floor treasuries can be redeemed")]
    NotFloor,
    #[msg("The Stock Floor belongs to holders; the creator cannot withdraw it")]
    FloorLocked,
    #[msg("Amount too small to redeem any stock")]
    NothingToRedeem,
    // Appended so existing error codes are unchanged.
    #[msg("This mode shares fees with Sonata; use distribute_split")]
    UseDistributeSplit,
    #[msg("This mode has no platform share; use distribute")]
    UseDistribute,
    #[msg("The platform share goes only to the Vault admin")]
    InvalidPlatformRecipient,
    #[msg("This mode keeps no creator-withdrawable reserve")]
    NoCreatorReserve,
}
