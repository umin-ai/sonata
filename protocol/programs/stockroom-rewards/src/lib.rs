// SPDX-License-Identifier: GPL-3.0-or-later
// Devnet-only fixed-recipient grants funded from an authenticated Stockroom reserve.
use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};
use stockroom_treasury::Treasury;
declare_id!("6u1nXj1iXNxCGThKetW45MSpXeEdn5GFw6NaZa4Mpn1L");
pub const MAX_MEMBERS: usize = 8;
pub const MOCK_MINT: Pubkey = pubkey!("6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg");
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Allocation {
    pub recipient: Pubkey,
    pub amount: u64,
}
#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub creator: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub nonce: u64,
    pub funded: u64,
    pub claimed: u64,
    pub claimed_mask: u16,
    pub bump: u8,
    #[max_len(8)]
    pub allocations: Vec<Allocation>,
}
#[program]
pub mod stockroom_rewards {
    use super::*;
    pub fn create_policy(ctx: Context<CreatePolicy>, share_bps: u16, interval_seconds: i64) -> Result<()> {
        require!(share_bps > 0 && share_bps <= 10000 && interval_seconds >= 60, RewardError::InvalidPolicy);
        let p = &mut ctx.accounts.policy;
        p.creator = ctx.accounts.creator.key();
        p.treasury = ctx.accounts.treasury.key();
        p.share_bps = share_bps;
        p.interval_seconds = interval_seconds;
        p.checkpoint = ctx.accounts.treasury.total_retained;
        p.last_round_at = 0;
        p.rounds = 0;
        p.bump = ctx.bumps.policy;
        Ok(())
    }
    pub fn update_policy(ctx: Context<UpdatePolicy>, share_bps: u16, interval_seconds: i64) -> Result<()> {
        require!(share_bps <= 10000 && interval_seconds >= 60, RewardError::InvalidPolicy);
        // Policy changes apply only to future retained fees, never to already funded rounds.
        let p = &mut ctx.accounts.policy;
        p.share_bps = share_bps;
        p.interval_seconds = interval_seconds;
        p.checkpoint = ctx.accounts.treasury.total_retained;
        Ok(())
    }
    pub fn record_round(ctx: Context<RecordRound>, snapshot_slot: u64, snapshot_hash: [u8;32]) -> Result<()> {
        let ix_info = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&ix_info)?;
        require!(current > 0, RewardError::InvalidAllocation);
        let previous = load_instruction_at_checked((current - 1) as usize, &ix_info)?;
        require!(previous.program_id == crate::ID && previous.data.starts_with(crate::instruction::Fund::DISCRIMINATOR)
            && previous.accounts.iter().any(|a| a.pubkey == ctx.accounts.campaign.key()), RewardError::InvalidAllocation);
        let now = Clock::get()?;
        let p = &mut ctx.accounts.policy;
        require!(p.share_bps > 0 && now.unix_timestamp >= p.last_round_at.checked_add(p.interval_seconds).ok_or(RewardError::Math)?, RewardError::NotDue);
        require!(snapshot_slot <= now.slot && now.slot - snapshot_slot <= 300, RewardError::StaleSnapshot);
        let fresh = ctx.accounts.treasury.total_retained.checked_sub(p.checkpoint).ok_or(RewardError::Math)?;
        let budget = ((fresh as u128) * (p.share_bps as u128) / 10000) as u64;
        require!(budget > 0 && ctx.accounts.campaign.funded == budget && ctx.accounts.campaign.claimed == 0, RewardError::InvalidAllocation);
        let r = &mut ctx.accounts.round;
        r.campaign = ctx.accounts.campaign.key();
        r.policy = p.key();
        r.snapshot_slot = snapshot_slot;
        r.snapshot_hash = snapshot_hash;
        r.created_at = now.unix_timestamp;
        r.number = p.rounds.checked_add(1).ok_or(RewardError::Math)?;
        p.rounds = r.number;
        p.checkpoint = ctx.accounts.treasury.total_retained;
        p.last_round_at = now.unix_timestamp;
        Ok(())
    }
    // Any payer may deliver an immutable allocation; the recipient need not connect or sign.
    pub fn deliver(ctx: Context<Deliver>, index: u8) -> Result<()> {
        let c = &ctx.accounts.campaign;
        let i = index as usize;
        require!(i < c.allocations.len(), RewardError::InvalidAllocation);
        require_keys_eq!(c.allocations[i].recipient, ctx.accounts.recipient.key(), RewardError::WrongRecipient);
        let mask = 1u16 << i;
        require!(c.claimed_mask & mask == 0, RewardError::AlreadyClaimed);
        let amount = c.allocations[i].amount;
        let nonce = c.nonce.to_le_bytes();
        let bump = [c.bump];
        let seeds: &[&[u8]] = &[b"rewards", c.creator.as_ref(), &nonce, &bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.escrow.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.destination.to_account_info(), authority: c.to_account_info(),
        }, &[seeds]), amount, ctx.accounts.mint.decimals)?;
        let c = &mut ctx.accounts.campaign;
        c.claimed = c.claimed.checked_add(amount).ok_or(RewardError::Math)?;
        require!(c.claimed <= c.funded, RewardError::Math);
        c.claimed_mask |= mask;
        emit!(Claimed { campaign: c.key(), recipient: ctx.accounts.recipient.key(), amount, index });
        Ok(())
    }
    pub fn fund(ctx: Context<Fund>, nonce: u64, allocations: Vec<Allocation>) -> Result<()> {
        require!(
            !allocations.is_empty() && allocations.len() <= MAX_MEMBERS,
            RewardError::InvalidAllocation
        );
        let mut total = 0u64;
        for (i, a) in allocations.iter().enumerate() {
            require!(
                a.amount > 0 && a.recipient.is_on_curve(),
                RewardError::InvalidAllocation
            );
            require!(
                !allocations[..i].iter().any(|x| x.recipient == a.recipient),
                RewardError::DuplicateRecipient
            );
            total = total.checked_add(a.amount).ok_or(RewardError::Math)?;
        }
        require!(
            ctx.accounts.mint.decimals == 8 && ctx.accounts.mint.freeze_authority.is_none(),
            RewardError::InvalidMint
        );
        // This CPI is the funding source: arbitrary wallet balances cannot masquerade as reserve revenue.
        stockroom_treasury::cpi::withdraw_retained(
            CpiContext::new(
                ctx.accounts.treasury_program.key(),
                stockroom_treasury::cpi::accounts::WithdrawRetained {
                    treasury: ctx.accounts.treasury.to_account_info(),
                    creator: ctx.accounts.creator.to_account_info(),
                    treasury_quote: ctx.accounts.treasury_quote.to_account_info(),
                    creator_quote: ctx.accounts.creator_quote.to_account_info(),
                    quote_mint: ctx.accounts.mint.to_account_info(),
                    token_quote_program: ctx.accounts.token_program.to_account_info(),
                },
            ),
            total,
        )?;
        let before = ctx.accounts.escrow.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.creator_quote.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            total,
            8,
        )?;
        ctx.accounts.escrow.reload()?;
        require!(
            ctx.accounts.escrow.amount.checked_sub(before) == Some(total),
            RewardError::FundingMismatch
        );
        let c = &mut ctx.accounts.campaign;
        c.creator = ctx.accounts.creator.key();
        c.treasury = ctx.accounts.treasury.key();
        c.mint = ctx.accounts.mint.key();
        c.nonce = nonce;
        c.funded = total;
        c.claimed = 0;
        c.claimed_mask = 0;
        c.bump = ctx.bumps.campaign;
        c.allocations = allocations;
        emit!(Funded {
            campaign: c.key(),
            treasury: c.treasury,
            amount: total
        });
        Ok(())
    }
    pub fn claim(ctx: Context<Claim>, index: u8) -> Result<()> {
        let c = &ctx.accounts.campaign;
        let i = index as usize;
        require!(i < c.allocations.len(), RewardError::InvalidAllocation);
        let a = &c.allocations[i];
        require_keys_eq!(
            a.recipient,
            ctx.accounts.recipient.key(),
            RewardError::WrongRecipient
        );
        let mask = 1u16 << i;
        require!(c.claimed_mask & mask == 0, RewardError::AlreadyClaimed);
        let amount = a.amount;
        let nonce = c.nonce.to_le_bytes();
        let bump = [c.bump];
        let seeds: &[&[u8]] = &[b"rewards", c.creator.as_ref(), &nonce, &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: c.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        let c = &mut ctx.accounts.campaign;
        c.claimed = c.claimed.checked_add(amount).ok_or(RewardError::Math)?;
        require!(c.claimed <= c.funded, RewardError::Math);
        c.claimed_mask |= mask;
        emit!(Claimed {
            campaign: c.key(),
            recipient: ctx.accounts.recipient.key(),
            amount,
            index
        });
        Ok(())
    }
}
#[derive(Accounts)]
#[instruction(nonce:u64)]
pub struct Fund<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut,has_one=creator,constraint=treasury.quote_mint==mint.key() @ RewardError::InvalidMint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut,token::mint=mint,token::authority=treasury,token::token_program=token_program)]
    pub treasury_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,token::mint=mint,token::authority=creator,token::token_program=token_program)]
    pub creator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address=MOCK_MINT)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init,payer=creator,space=8+Campaign::INIT_SPACE,seeds=[b"rewards",creator.key().as_ref(),&nonce.to_le_bytes()],bump)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(init,payer=creator,associated_token::mint=mint,associated_token::authority=campaign,associated_token::token_program=token_program)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub treasury_program: Program<'info, stockroom_treasury::program::StockroomTreasury>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut,seeds=[b"rewards",campaign.creator.as_ref(),&campaign.nonce.to_le_bytes()],bump=campaign.bump,has_one=mint)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=campaign,associated_token::token_program=token_program)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub recipient: Signer<'info>,
    #[account(mut,token::mint=mint,token::authority=recipient,token::token_program=token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
}
#[event]
pub struct Funded {
    pub campaign: Pubkey,
    pub treasury: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Claimed {
    pub campaign: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub index: u8,
}
#[error_code]
pub enum RewardError {
    #[msg("Invalid reward share or interval")] InvalidPolicy,
    #[msg("Distribution is paused or not yet due")] NotDue,
    #[msg("Holder snapshot expired; refresh it")] StaleSnapshot,
    #[msg("Use 1–8 positive allocations to signing wallets")]
    InvalidAllocation,
    #[msg("Each recipient can appear only once")]
    DuplicateRecipient,
    #[msg("Arithmetic overflow")]
    Math,
    #[msg("Unsupported mock stock mint")]
    InvalidMint,
    #[msg("Escrow did not receive the full promised funding")]
    FundingMismatch,
    #[msg("Only the allocated recipient can claim")]
    WrongRecipient,
    #[msg("This allocation has already been claimed")]
    AlreadyClaimed,
}

#[account]
#[derive(InitSpace)]
pub struct HolderPolicy {
    pub creator: Pubkey, pub treasury: Pubkey, pub share_bps: u16,
    pub interval_seconds: i64, pub checkpoint: u64, pub last_round_at: i64,
    pub rounds: u64, pub bump: u8,
}
#[account]
#[derive(InitSpace)]
pub struct HolderRound {
    pub campaign: Pubkey, pub policy: Pubkey, pub snapshot_slot: u64,
    pub snapshot_hash: [u8;32], pub created_at: i64, pub number: u64,
}
#[derive(Accounts)]
pub struct CreatePolicy<'info> {
    #[account(mut)] pub creator: Signer<'info>,
    #[account(has_one=creator)] pub treasury: Account<'info, Treasury>,
    #[account(init,payer=creator,space=8+HolderPolicy::INIT_SPACE,seeds=[b"holder-policy",treasury.key().as_ref()],bump)]
    pub policy: Account<'info, HolderPolicy>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub creator: Signer<'info>,
    #[account(has_one=creator)] pub treasury: Account<'info, Treasury>,
    #[account(mut,seeds=[b"holder-policy",treasury.key().as_ref()],bump=policy.bump,has_one=creator,has_one=treasury)]
    pub policy: Account<'info, HolderPolicy>,
}
#[derive(Accounts)]
pub struct RecordRound<'info> {
    /// CHECK: canonical instructions sysvar verifies funding occurred immediately before this instruction.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    #[account(mut)] pub creator: Signer<'info>,
    #[account(has_one=creator)] pub treasury: Account<'info, Treasury>,
    #[account(mut,seeds=[b"holder-policy",treasury.key().as_ref()],bump=policy.bump,has_one=creator,has_one=treasury)]
    pub policy: Account<'info, HolderPolicy>,
    #[account(has_one=creator,has_one=treasury)] pub campaign: Account<'info, Campaign>,
    #[account(init,payer=creator,space=8+HolderRound::INIT_SPACE,seeds=[b"holder-round",campaign.key().as_ref()],bump)]
    pub round: Account<'info, HolderRound>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut,seeds=[b"rewards",campaign.creator.as_ref(),&campaign.nonce.to_le_bytes()],bump=campaign.bump,has_one=mint)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=campaign,associated_token::token_program=token_program)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: matched to immutable allocation before transfer, never signs.
    pub recipient: UncheckedAccount<'info>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=recipient,associated_token::token_program=token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
}
