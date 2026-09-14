// SPDX-License-Identifier: GPL-3.0-or-later
use anchor_lang::prelude::*;
use anchor_spl::{
    token::{
        self, Mint as CashMint, Token, TokenAccount as CashAccount, TransferChecked as CashTransfer,
    },
    token_2022::spl_token_2022::{
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::Mint as ExtensionMint,
    },
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use credit_math as math;
use demo_oracle::DemoPrice;
declare_id!("4sS8MrfTUjavLyMs5GtircsjMab5vfVZdLE7YPcZo9BH");
const DEPOSIT_CAP: u64 = 1_000_000_000_000_000;

#[program]
pub mod stockroom_credit {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        apr_bps: u16,
        opening_ltv_bps: u16,
        liquidation_ltv_bps: u16,
        bonus_bps: u16,
        max_price_age: u32,
    ) -> Result<()> {
        require!(
            apr_bps <= 2000
                && opening_ltv_bps > 0
                && opening_ltv_bps < liquidation_ltv_bps
                && liquidation_ltv_bps < 9000
                && bonus_bps <= 1000,
            CreditError::InvalidConfig
        );
        require!(
            u64::from(liquidation_ltv_bps) * (10_000 + u64::from(bonus_bps)) < 100_000_000
                && (10..=3600).contains(&max_price_age),
            CreditError::InvalidConfig
        );
        require!(
            ctx.accounts.debt_mint.decimals == 6 && ctx.accounts.collateral_mint.decimals == 8,
            CreditError::UnsupportedMint
        );
        validate_stock(&ctx.accounts.collateral_mint)?;
        let feed = &ctx.accounts.oracle;
        require_keys_eq!(
            feed.collateral_mint,
            ctx.accounts.collateral_mint.key(),
            CreditError::OracleMismatch
        );
        require_keys_eq!(
            feed.debt_mint,
            ctx.accounts.debt_mint.key(),
            CreditError::OracleMismatch
        );
        *ctx.accounts.market = Market {
            admin: ctx.accounts.admin.key(),
            collateral_mint: ctx.accounts.collateral_mint.key(),
            debt_mint: ctx.accounts.debt_mint.key(),
            cash_vault: ctx.accounts.cash_vault.key(),
            collateral_vault: ctx.accounts.collateral_vault.key(),
            oracle: ctx.accounts.oracle.key(),
            cash: 0,
            debt_assets: 0,
            supply_shares: 0,
            debt_shares: 0,
            interest_remainder: 0,
            last_accrual: Clock::get()?.unix_timestamp,
            apr_bps,
            opening_ltv_bps,
            liquidation_ltv_bps,
            bonus_bps,
            max_price_age,
            paused: false,
            bump: ctx.bumps.market,
        };
        Ok(())
    }
    pub fn initialize_position(ctx: Context<InitializePosition>) -> Result<()> {
        *ctx.accounts.position = Position {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            supply_shares: 0,
            debt_shares: 0,
            collateral: 0,
        };
        Ok(())
    }
    pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
        ctx.accounts.market.paused = paused;
        Ok(())
    }

    pub fn supply(ctx: Context<CashOps>, assets: u64, min_shares: u128) -> Result<()> {
        require!(assets > 0, CreditError::ZeroAmount);
        let m = &mut ctx.accounts.market;
        m.accrue()?;
        let nav = m.nav()?;
        require!(
            nav.checked_add(assets).ok_or(CreditError::Math)? <= DEPOSIT_CAP,
            CreditError::DepositCap
        );
        let shares = calc(math::shares_for_assets(
            assets.into(),
            nav.into(),
            m.supply_shares,
            false,
        ))?;
        require!(shares > 0 && shares >= min_shares, CreditError::Slippage);
        m.cash = m.cash.checked_add(assets).ok_or(CreditError::Math)?;
        m.supply_shares = calc(math::add(m.supply_shares, shares))?;
        ctx.accounts.position.supply_shares =
            calc(math::add(ctx.accounts.position.supply_shares, shares))?;
        ctx.accounts.move_cash(assets, false)?;
        emit!(CreditAction {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            action: 0,
            assets,
            shares,
            collateral: 0,
            bad_debt: 0
        });
        Ok(())
    }
    pub fn redeem(ctx: Context<CashOps>, shares: u128, min_assets: u64) -> Result<()> {
        let shares = if shares == u128::MAX {
            ctx.accounts.position.supply_shares
        } else {
            shares
        };
        require!(
            shares > 0 && shares <= ctx.accounts.position.supply_shares,
            CreditError::InsufficientShares
        );
        let m = &mut ctx.accounts.market;
        m.accrue()?;
        let assets = calc(math::as_u64(calc(math::assets_for_shares(
            shares,
            m.nav()?.into(),
            m.supply_shares,
            false,
        ))?))?;
        require!(assets > 0 && assets >= min_assets, CreditError::Slippage);
        require!(assets <= m.cash, CreditError::InsufficientLiquidity);
        m.cash -= assets;
        m.supply_shares = m
            .supply_shares
            .checked_sub(shares)
            .ok_or(CreditError::Math)?;
        ctx.accounts.position.supply_shares -= shares;
        ctx.accounts.move_cash(assets, true)?;
        emit!(CreditAction {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            action: 1,
            assets,
            shares,
            collateral: 0,
            bad_debt: 0
        });
        Ok(())
    }
    pub fn deposit_collateral(ctx: Context<CollateralOps>, amount: u64) -> Result<()> {
        require!(amount > 0, CreditError::ZeroAmount);
        validate_stock(&ctx.accounts.collateral_mint)?;
        ctx.accounts.position.collateral = ctx
            .accounts
            .position
            .collateral
            .checked_add(amount)
            .ok_or(CreditError::Math)?;
        ctx.accounts.move_collateral(amount, false)?;
        emit!(CreditAction {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            action: 2,
            assets: 0,
            shares: 0,
            collateral: amount,
            bad_debt: 0
        });
        Ok(())
    }
    pub fn borrow(ctx: Context<Borrow>, assets: u64, max_debt_shares: u128) -> Result<()> {
        require!(assets > 0, CreditError::ZeroAmount);
        let m = &mut ctx.accounts.cash.market;
        m.accrue()?;
        require!(!m.paused, CreditError::Paused);
        let price = m.price(&ctx.accounts.oracle, true)?;
        require!(assets <= m.cash, CreditError::InsufficientLiquidity);
        let shares = calc(math::shares_for_assets(
            assets.into(),
            m.debt_assets.into(),
            m.debt_shares,
            true,
        ))?;
        require!(
            shares > 0 && shares <= max_debt_shares,
            CreditError::Slippage
        );
        m.cash -= assets;
        m.debt_assets = m.debt_assets.checked_add(assets).ok_or(CreditError::Math)?;
        m.debt_shares = calc(math::add(m.debt_shares, shares))?;
        let p = &mut ctx.accounts.cash.position;
        p.debt_shares = calc(math::add(p.debt_shares, shares))?;
        require!(
            calc(math::healthy(
                m.position_debt(p.debt_shares)?,
                p.collateral,
                price,
                m.opening_ltv_bps
            ))?,
            CreditError::Unhealthy
        );
        ctx.accounts.cash.move_cash(assets, true)?;
        emit!(CreditAction {
            market: ctx.accounts.cash.market.key(),
            owner: ctx.accounts.cash.owner.key(),
            action: 3,
            assets,
            shares,
            collateral: 0,
            bad_debt: 0
        });
        Ok(())
    }
    pub fn repay(ctx: Context<CashOps>, shares: u128, max_assets: u64) -> Result<()> {
        let shares = if shares == u128::MAX {
            ctx.accounts.position.debt_shares
        } else {
            shares
        };
        require!(
            shares > 0 && shares <= ctx.accounts.position.debt_shares,
            CreditError::InsufficientShares
        );
        let m = &mut ctx.accounts.market;
        m.accrue()?;
        let assets = m.position_debt(shares)?;
        require!(assets > 0 && assets <= max_assets, CreditError::Slippage);
        m.reduce_debt(shares, assets)?;
        m.cash = m.cash.checked_add(assets).ok_or(CreditError::Math)?;
        ctx.accounts.position.debt_shares -= shares;
        ctx.accounts.move_cash(assets, false)?;
        emit!(CreditAction {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.owner.key(),
            action: 4,
            assets,
            shares,
            collateral: 0,
            bad_debt: 0
        });
        Ok(())
    }
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        let p = &mut ctx.accounts.collateral.position;
        require!(
            amount > 0 && amount <= p.collateral,
            CreditError::InsufficientCollateral
        );
        let m = &mut ctx.accounts.collateral.market;
        m.accrue()?;
        p.collateral -= amount;
        if p.debt_shares > 0 {
            require!(!m.paused, CreditError::Paused);
            let price = m.price(&ctx.accounts.oracle, true)?;
            require!(
                calc(math::healthy(
                    m.position_debt(p.debt_shares)?,
                    p.collateral,
                    price,
                    m.opening_ltv_bps
                ))?,
                CreditError::Unhealthy
            );
        }
        ctx.accounts.collateral.move_collateral(amount, true)?;
        emit!(CreditAction {
            market: ctx.accounts.collateral.market.key(),
            owner: ctx.accounts.collateral.owner.key(),
            action: 5,
            assets: 0,
            shares: 0,
            collateral: amount,
            bad_debt: 0
        });
        Ok(())
    }
    pub fn liquidate(ctx: Context<Liquidate>, seized: u64, max_repay: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.accrue()?;
        let price = m.price(&ctx.accounts.oracle, false)?;
        let p = &mut ctx.accounts.position;
        require!(
            p.debt_shares > 0
                && !calc(math::healthy(
                    m.position_debt(p.debt_shares)?,
                    p.collateral,
                    price,
                    m.liquidation_ltv_bps
                ))?,
            CreditError::HealthyPosition
        );
        require!(
            seized > 0 && seized <= p.collateral,
            CreditError::InsufficientCollateral
        );
        let (shares, assets) = calc(math::liquidation_repayment(
            seized,
            price,
            m.bonus_bps,
            m.debt_assets,
            m.debt_shares,
        ))?;
        require!(
            shares > 0 && shares <= p.debt_shares,
            CreditError::ExcessLiquidation
        );
        require!(assets > 0 && assets <= max_repay, CreditError::Slippage);
        p.debt_shares -= shares;
        p.collateral -= seized;
        m.reduce_debt(shares, assets)?;
        m.cash = m.cash.checked_add(assets).ok_or(CreditError::Math)?;
        let bad_debt = if p.collateral == 0 && p.debt_shares > 0 {
            let loss = m.position_debt(p.debt_shares)?.min(m.debt_assets);
            m.reduce_debt(p.debt_shares, loss)?;
            p.debt_shares = 0;
            loss
        } else {
            0
        };
        let market_admin = m.admin;
        let stock = m.collateral_mint;
        let cash = m.debt_mint;
        let bump = [m.bump];
        let seeds: &[&[u8]] = &[
            b"market",
            market_admin.as_ref(),
            stock.as_ref(),
            cash.as_ref(),
            &bump,
        ];
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                CashTransfer {
                    from: ctx.accounts.liquidator_cash.to_account_info(),
                    mint: ctx.accounts.debt_mint.to_account_info(),
                    to: ctx.accounts.cash_vault.to_account_info(),
                    authority: ctx.accounts.liquidator.to_account_info(),
                },
            ),
            assets,
            6,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.collateral_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.liquidator_stock.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            seized,
            8,
        )?;
        emit!(CreditAction {
            market: ctx.accounts.market.key(),
            owner: ctx.accounts.position.owner,
            action: 6,
            assets,
            shares,
            collateral: seized,
            bad_debt
        });
        Ok(())
    }
}

fn calc<T>(r: math::MathResult<T>) -> Result<T> {
    r.map_err(|_| error!(CreditError::Math))
}
fn validate_stock(mint: &InterfaceAccount<Mint>) -> Result<()> {
    require_keys_eq!(
        *mint.to_account_info().owner,
        anchor_spl::token_2022::ID,
        CreditError::UnsupportedMint
    );
    require!(
        mint.freeze_authority.is_none(),
        CreditError::UnsupportedMint
    );
    let info = mint.to_account_info();
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<ExtensionMint>::unpack(&data)?;
    for extension in state.get_extension_types()? {
        require!(
            matches!(
                extension,
                ExtensionType::ScaledUiAmount
                    | ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
            ),
            CreditError::UnsupportedMint
        );
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,
    pub debt_mint: Pubkey,
    pub cash_vault: Pubkey,
    pub collateral_vault: Pubkey,
    pub oracle: Pubkey,
    /// Accounted cash excludes unsolicited token donations.
    pub cash: u64,
    pub debt_assets: u64,
    pub supply_shares: u128,
    pub debt_shares: u128,
    pub interest_remainder: u128,
    pub last_accrual: i64,
    pub apr_bps: u16,
    pub opening_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub bonus_bps: u16,
    pub max_price_age: u32,
    pub paused: bool,
    pub bump: u8,
}
impl Market {
    fn nav(&self) -> Result<u64> {
        self.cash
            .checked_add(self.debt_assets)
            .ok_or_else(|| error!(CreditError::Math))
    }
    fn accrue(&mut self) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let elapsed: u64 = now
            .checked_sub(self.last_accrual)
            .ok_or(CreditError::Math)?
            .try_into()
            .map_err(|_| error!(CreditError::Math))?;
        let (interest, remainder) = calc(math::interest(
            self.debt_assets,
            self.apr_bps,
            elapsed,
            self.interest_remainder,
        ))?;
        self.debt_assets = self
            .debt_assets
            .checked_add(interest)
            .ok_or(CreditError::Math)?;
        self.interest_remainder = remainder;
        self.last_accrual = now;
        Ok(())
    }
    fn position_debt(&self, shares: u128) -> Result<u64> {
        calc(math::as_u64(calc(math::assets_for_shares(
            shares,
            self.debt_assets.into(),
            self.debt_shares,
            true,
        ))?))
    }
    fn reduce_debt(&mut self, shares: u128, assets: u64) -> Result<()> {
        self.debt_shares = self
            .debt_shares
            .checked_sub(shares)
            .ok_or(CreditError::Math)?;
        self.debt_assets = self.debt_assets.saturating_sub(assets);
        if self.debt_shares == 0 {
            self.debt_assets = 0;
            self.interest_remainder = 0;
        }
        Ok(())
    }
    fn price(&self, feed: &DemoPrice, requires_trading: bool) -> Result<u64> {
        require_keys_eq!(
            feed.collateral_mint,
            self.collateral_mint,
            CreditError::OracleMismatch
        );
        require_keys_eq!(feed.debt_mint, self.debt_mint, CreditError::OracleMismatch);
        let age = Clock::get()?
            .unix_timestamp
            .checked_sub(feed.published_at)
            .ok_or(CreditError::StalePrice)?;
        require!(
            age >= 0 && age <= i64::from(self.max_price_age),
            CreditError::StalePrice
        );
        require!(
            feed.price > 0 && u128::from(feed.confidence) * 10_000 <= u128::from(feed.price) * 100,
            CreditError::UncertainPrice
        );
        require!(!requires_trading || feed.trading, CreditError::MarketClosed);
        feed.price
            .checked_sub(feed.confidence)
            .filter(|p| *p > 0)
            .ok_or_else(|| error!(CreditError::UncertainPrice))
    }
}
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub supply_shares: u128,
    pub debt_shares: u128,
    pub collateral: u64,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    pub debt_mint: Account<'info, CashMint>,
    #[account(init,payer=admin,space=8+Market::INIT_SPACE,seeds=[b"market",admin.key().as_ref(),collateral_mint.key().as_ref(),debt_mint.key().as_ref()],bump)]
    pub market: Account<'info, Market>,
    #[account(init,payer=admin,seeds=[b"cash",market.key().as_ref()],bump,token::mint=debt_mint,token::authority=market)]
    pub cash_vault: Account<'info, CashAccount>,
    #[account(init,payer=admin,seeds=[b"collateral",market.key().as_ref()],bump,token::mint=collateral_mint,token::authority=market,token::token_program=collateral_token_program)]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,
    pub oracle: Account<'info, DemoPrice>,
    pub token_program: Program<'info, Token>,
    pub collateral_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct InitializePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(init,payer=owner,space=8+Position::INIT_SPACE,seeds=[b"position",market.key().as_ref(),owner.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut,has_one=admin)]
    pub market: Account<'info, Market>,
}
#[derive(Accounts)]
pub struct CashOps<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut,has_one=owner,has_one=market,seeds=[b"position",market.key().as_ref(),owner.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    #[account(address=market.debt_mint)]
    pub debt_mint: Account<'info, CashMint>,
    #[account(mut,address=market.cash_vault,token::mint=debt_mint,token::authority=market)]
    pub cash_vault: Account<'info, CashAccount>,
    #[account(mut,token::mint=debt_mint,token::authority=owner)]
    pub user_cash: Account<'info, CashAccount>,
    pub token_program: Program<'info, Token>,
}
impl<'info> CashOps<'info> {
    fn move_cash(&self, amount: u64, out: bool) -> Result<()> {
        let (from, to, authority) = if out {
            (
                self.cash_vault.to_account_info(),
                self.user_cash.to_account_info(),
                self.market.to_account_info(),
            )
        } else {
            (
                self.user_cash.to_account_info(),
                self.cash_vault.to_account_info(),
                self.owner.to_account_info(),
            )
        };
        let transfer = CashTransfer {
            from,
            to,
            authority,
            mint: self.debt_mint.to_account_info(),
        };
        let bump = [self.market.bump];
        let seeds: &[&[u8]] = &[
            b"market",
            self.market.admin.as_ref(),
            self.market.collateral_mint.as_ref(),
            self.market.debt_mint.as_ref(),
            &bump,
        ];
        if out {
            token::transfer_checked(
                CpiContext::new(self.token_program.key(), transfer).with_signer(&[seeds]),
                amount,
                6,
            )
        } else {
            token::transfer_checked(
                CpiContext::new(self.token_program.key(), transfer),
                amount,
                6,
            )
        }
    }
}
#[derive(Accounts)]
pub struct Borrow<'info> {
    pub cash: CashOps<'info>,
    #[account(address=cash.market.oracle)]
    pub oracle: Account<'info, DemoPrice>,
}
#[derive(Accounts)]
pub struct CollateralOps<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut,has_one=owner,has_one=market,seeds=[b"position",market.key().as_ref(),owner.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    #[account(address=market.collateral_mint)]
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    #[account(mut,address=market.collateral_vault,token::mint=collateral_mint,token::authority=market,token::token_program=collateral_token_program)]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut,token::mint=collateral_mint,token::authority=owner,token::token_program=collateral_token_program)]
    pub user_stock: InterfaceAccount<'info, TokenAccount>,
    pub collateral_token_program: Interface<'info, TokenInterface>,
}
impl<'info> CollateralOps<'info> {
    fn move_collateral(&self, amount: u64, out: bool) -> Result<()> {
        let (from, to, authority) = if out {
            (
                self.collateral_vault.to_account_info(),
                self.user_stock.to_account_info(),
                self.market.to_account_info(),
            )
        } else {
            (
                self.user_stock.to_account_info(),
                self.collateral_vault.to_account_info(),
                self.owner.to_account_info(),
            )
        };
        let transfer = TransferChecked {
            from,
            to,
            authority,
            mint: self.collateral_mint.to_account_info(),
        };
        let bump = [self.market.bump];
        let seeds: &[&[u8]] = &[
            b"market",
            self.market.admin.as_ref(),
            self.market.collateral_mint.as_ref(),
            self.market.debt_mint.as_ref(),
            &bump,
        ];
        if out {
            token_interface::transfer_checked(
                CpiContext::new(self.collateral_token_program.key(), transfer)
                    .with_signer(&[seeds]),
                amount,
                8,
            )
        } else {
            token_interface::transfer_checked(
                CpiContext::new(self.collateral_token_program.key(), transfer),
                amount,
                8,
            )
        }
    }
}
#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub collateral: CollateralOps<'info>,
    #[account(address=collateral.market.oracle)]
    pub oracle: Account<'info, DemoPrice>,
}
#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut,has_one=market,seeds=[b"position",market.key().as_ref(),position.owner.as_ref()],bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(address=market.oracle)]
    pub oracle: Box<Account<'info, DemoPrice>>,
    #[account(address=market.debt_mint)]
    pub debt_mint: Box<Account<'info, CashMint>>,
    #[account(address=market.collateral_mint)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut,address=market.cash_vault,token::mint=debt_mint,token::authority=market)]
    pub cash_vault: Box<Account<'info, CashAccount>>,
    #[account(mut,address=market.collateral_vault,token::mint=collateral_mint,token::authority=market,token::token_program=collateral_token_program)]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,token::mint=debt_mint,token::authority=liquidator)]
    pub liquidator_cash: Box<Account<'info, CashAccount>>,
    #[account(mut,token::mint=collateral_mint,token::authority=liquidator,token::token_program=collateral_token_program)]
    pub liquidator_stock: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub collateral_token_program: Interface<'info, TokenInterface>,
}
#[event]
pub struct CreditAction {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub action: u8,
    pub assets: u64,
    pub shares: u128,
    pub collateral: u64,
    pub bad_debt: u64,
}
#[error_code]
pub enum CreditError {
    #[msg("Invalid immutable market terms")]
    InvalidConfig,
    #[msg("This mint or token extension is unsupported")]
    UnsupportedMint,
    #[msg("Wrong bound oracle or asset pair")]
    OracleMismatch,
    #[msg("Checked arithmetic failed")]
    Math,
    #[msg("Amount must be positive")]
    ZeroAmount,
    #[msg("Minimum output or maximum input exceeded")]
    Slippage,
    #[msg("Insufficient position shares")]
    InsufficientShares,
    #[msg("Cash is lent out or unavailable")]
    InsufficientLiquidity,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Borrowing is paused")]
    Paused,
    #[msg("Resulting position exceeds opening LTV")]
    Unhealthy,
    #[msg("Oracle quote is stale or from the future")]
    StalePrice,
    #[msg("Oracle confidence exceeds one percent")]
    UncertainPrice,
    #[msg("New risk is blocked while the market is closed")]
    MarketClosed,
    #[msg("Healthy positions cannot be liquidated")]
    HealthyPosition,
    #[msg("Liquidation would repay more than this position owes")]
    ExcessLiquidation,
    #[msg("Prototype market deposit cap exceeded")]
    DepositCap,
}
