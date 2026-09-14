// SPDX-License-Identifier: GPL-3.0-or-later
// Share offsets/rounding and third-order compounding adapted from Morpho Labs'
// GPL-2.0-or-later SharesMathLib.sol and MathLib.sol. See THIRD_PARTY_NOTICES.md.
#![no_std]
use uint::construct_uint;
construct_uint! { pub struct U256(4); }

pub const BPS: u128 = 10_000;
pub const YEAR: u128 = 31_536_000;
pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const VIRTUAL_SHARES: u128 = 1_000_000;
pub const COLLATERAL_SCALE: u128 = 100_000_000;
pub type MathResult<T> = Result<T, MathError>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    DivisionByZero,
    InvalidInput,
}

pub fn add(a: u128, b: u128) -> MathResult<u128> {
    a.checked_add(b).ok_or(MathError::Overflow)
}
pub fn as_u64(n: u128) -> MathResult<u64> {
    n.try_into().map_err(|_| MathError::Overflow)
}
pub fn mul_div(a: u128, b: u128, d: u128, round_up: bool) -> MathResult<u128> {
    if d == 0 {
        return Err(MathError::DivisionByZero);
    }
    let product = U256::from(a) * U256::from(b);
    let denominator = U256::from(d);
    let mut value = product / denominator;
    if round_up && product % denominator != U256::zero() {
        value += U256::one();
    }
    if value > U256::from(u128::MAX) {
        return Err(MathError::Overflow);
    }
    Ok(value.as_u128())
}
pub fn shares_for_assets(
    assets: u128,
    total_assets: u128,
    total_shares: u128,
    up: bool,
) -> MathResult<u128> {
    mul_div(
        assets,
        add(total_shares, VIRTUAL_SHARES)?,
        add(total_assets, 1)?,
        up,
    )
}
pub fn assets_for_shares(
    shares: u128,
    total_assets: u128,
    total_shares: u128,
    up: bool,
) -> MathResult<u128> {
    mul_div(
        shares,
        add(total_assets, 1)?,
        add(total_shares, VIRTUAL_SHARES)?,
        up,
    )
}
/// Continuous-rate third-order approximation, matching the Morpho reference.
/// `remainder` carries fractional token atoms so frequent calls cannot discard interest.
pub fn interest(debt: u64, apr_bps: u16, elapsed: u64, remainder: u128) -> MathResult<(u64, u128)> {
    if remainder >= WAD || apr_bps > 2_000 {
        return Err(MathError::InvalidInput);
    }
    if debt == 0 {
        return Ok((0, 0));
    }
    let rate = mul_div(apr_bps.into(), WAD, BPS * YEAR, false)?;
    let first = rate
        .checked_mul(elapsed.into())
        .ok_or(MathError::Overflow)?;
    let second = mul_div(first, first, 2 * WAD, false)?;
    let third = mul_div(second, first, 3 * WAD, false)?;
    let factor = add(add(first, second)?, third)?;
    let numerator = U256::from(debt) * U256::from(factor) + U256::from(remainder);
    let whole = numerator / U256::from(WAD);
    if whole > U256::from(u64::MAX) {
        return Err(MathError::Overflow);
    }
    Ok((whole.as_u64(), (numerator % U256::from(WAD)).as_u128()))
}
pub fn collateral_value(raw: u64, price_quote_atoms: u64) -> MathResult<u64> {
    as_u64(mul_div(
        raw.into(),
        price_quote_atoms.into(),
        COLLATERAL_SCALE,
        false,
    )?)
}
pub fn healthy(debt: u64, collateral: u64, price: u64, ltv_bps: u16) -> MathResult<bool> {
    let limit = mul_div(
        collateral_value(collateral, price)?.into(),
        ltv_bps.into(),
        BPS,
        false,
    )?;
    Ok(u128::from(debt) <= limit)
}
pub fn liquidation_repayment(
    seized: u64,
    price: u64,
    bonus_bps: u16,
    debt_assets: u64,
    debt_shares: u128,
) -> MathResult<(u128, u64)> {
    let quoted = mul_div(seized.into(), price.into(), COLLATERAL_SCALE, true)?;
    let required = mul_div(quoted, BPS, BPS + u128::from(bonus_bps), true)?;
    let shares = shares_for_assets(required, debt_assets.into(), debt_shares, true)?;
    let assets = as_u64(assets_for_shares(
        shares,
        debt_assets.into(),
        debt_shares,
        true,
    )?)?;
    Ok((shares, assets))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rounding_cannot_create_a_profitable_round_trip() {
        for assets in [1, 2, 999, 1_000_000, 1_000_000_000] {
            for total in [0, 1, 10_000, 1_234_567_890] {
                let shares = total * VIRTUAL_SHARES + 99;
                let deposit = shares_for_assets(assets, total, shares, false).unwrap();
                assert!(assets_for_shares(deposit, total, shares, false).unwrap() <= assets);
                let borrow = shares_for_assets(assets, total, shares, true).unwrap();
                assert!(assets_for_shares(borrow, total, shares, true).unwrap() >= assets);
            }
        }
    }
    #[test]
    fn virtual_shares_bound_first_depositor_manipulation() {
        let first = shares_for_assets(1, 0, 0, false).unwrap();
        assert_eq!(first, 1_000_000);
        // Even if a vault used donated balances, virtual shares absorb much of the donation.
        let recoverable = assets_for_shares(first, 1_000_001, first, false).unwrap();
        assert!(recoverable < 1_000_001);
    }
    #[test]
    fn full_width_products_and_overflow_are_explicit() {
        assert_eq!(
            mul_div(u128::MAX, u128::MAX, u128::MAX, false).unwrap(),
            u128::MAX
        );
        assert_eq!(mul_div(u128::MAX, 2, 1, false), Err(MathError::Overflow));
        assert_eq!(mul_div(1, 1, 0, false), Err(MathError::DivisionByZero));
        assert_eq!(mul_div(10, 10, 3, true).unwrap(), 34);
    }
    #[test]
    fn debt_compounds_at_apr_and_fractional_interest_is_retained() {
        let (annual, _) = interest(1_000_000_000, 500, YEAR as u64, 0).unwrap();
        assert!((51_270_000..51_271_000).contains(&annual));
        let mut remainder = 0;
        let mut accrued = 0;
        for _ in 0..10_000 {
            let (n, r) = interest(1_000_000, 500, 1, remainder).unwrap();
            accrued += n;
            remainder = r;
        }
        assert!(accrued >= 15);
        assert_eq!(interest(0, 500, 100, remainder).unwrap(), (0, 0));
    }
    #[test]
    fn debt_and_collateral_boundaries_remain_separate() {
        let price = 200_000_000;
        assert!(healthy(1_100_000_000, 10 * 100_000_000, price, 5500).unwrap());
        assert!(!healthy(1_100_000_001, 10 * 100_000_000, price, 5500).unwrap());
        assert!(healthy(1_100_000_001, 10 * 100_000_000, price, 6500).unwrap());
        assert!(!healthy(1_100_000_001, 10 * 100_000_000, 100_000_000, 6500).unwrap());
    }
    #[test]
    fn seized_collateral_never_exceeds_the_paid_bonus() {
        for seized in [1, 9, 100_000_000, 900_000_001] {
            let (_, repaid) = liquidation_repayment(
                seized,
                100_000_000,
                500,
                1_000_000_000,
                1_000_000_000_000_000,
            )
            .unwrap();
            assert!(
                u128::from(repaid) * 10_500
                    >= mul_div(seized.into(), 100_000_000, COLLATERAL_SCALE, true).unwrap() * BPS
            );
        }
    }
}
