import { Buffer } from 'buffer';
import Decimal from 'decimal.js';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve';
import { OraclePrices } from '@kamino-finance/scope-sdk/dist/@codegen/scope/accounts/OraclePrices';
import { Fraction } from '@kamino-finance/klend-sdk/dist/classes/fraction';
import { effectiveMultiplier, MARKET, NVDA, USDC } from '../finance';
import { rpc,getJSON,STOCK_RESERVE,CASH_RESERVE,KLEND,TOKEN_2022,SCOPE,SCOPE_PROGRAM } from './chain';

async function readMarketSnapshot(){
  const [accounts,mint,metrics]=await Promise.all([
    rpc('getMultipleAccounts',[[STOCK_RESERVE,CASH_RESERVE,SCOPE],{encoding:'base64',commitment:'confirmed'}]),
    rpc('getAccountInfo',[NVDA,{encoding:'jsonParsed',commitment:'confirmed'}]),
    getJSON(`https://api.kamino.finance/kamino-market/${MARKET}/reserves/metrics`)
  ]);
  const info=mint.value?.data?.parsed?.info;
  if(mint.value?.owner!==TOKEN_2022||info?.decimals!==8)throw new Error('Stock mint metadata could not be verified.');
  if(info.extensions.some((e:{extension:string;state:{paused?:boolean}})=>e.extension==='pausableConfig'&&e.state.paused))throw new Error('The issuer has paused this stock token.');
  const config=info.extensions.find((e:{extension:string})=>e.extension==='scaledUiAmountConfig')?.state;
  if(!config)throw new Error('Stock balance multiplier is unavailable.');
  const multiplier=effectiveMultiplier(config,Date.now()/1000);
  const [stockAccount,cashAccount,oracleAccount]=accounts.value;
  if(stockAccount?.owner!==KLEND||cashAccount?.owner!==KLEND||oracleAccount?.owner!==SCOPE_PROGRAM)throw new Error('Unexpected reserve or oracle owner.');
  const stock=Reserve.decode(Buffer.from(stockAccount.data[0],'base64')),debt=Reserve.decode(Buffer.from(cashAccount.data[0],'base64'));
  if(stock.lendingMarket!==MARKET||debt.lendingMarket!==MARKET||stock.liquidity.mintPubkey!==NVDA||debt.liquidity.mintPubkey!==USDC)throw new Error('Unexpected lending market.');
  if(stock.liquidity.mintDecimals.toNumber()!==8||debt.liquidity.mintDecimals.toNumber()!==6)throw new Error('Unexpected reserve decimals.');
  const oracle=OraclePrices.decode(Buffer.from(oracleAccount.data[0],'base64'));
  const now=Date.now()/1000;
  function price(reserve:Reserve){
    const token=reserve.config.tokenInfo;
    if(token.scopeConfiguration.priceFeed!==SCOPE)throw new Error('Oracle configuration changed; review is required.');
    function chain(indices:number[]){
      let value=new Decimal(1),timestamp=Infinity,count=0;
      for(const index of indices){if(index===65535)break;const entry=oracle.prices[index];if(!entry)throw new Error('Oracle component unavailable');
        const exp=entry.price.exp.toNumber();if(exp>30)throw new Error('Unsupported oracle exponent');
        value=value.mul(new Decimal(entry.price.value.toString()).div(new Decimal(10).pow(exp)));timestamp=Math.min(timestamp,entry.unixTimestamp.toNumber());count++;
      }
      if(!count||!value.isFinite()||value.lte(0))throw new Error('Oracle price unavailable.');
      return {value,timestamp};
    }
    const spot=chain(token.scopeConfiguration.priceChain),twap=chain(token.scopeConfiguration.twapChain);
    const maxAge=token.maxAgePriceSeconds.toNumber(),maxTwapAge=token.maxAgeTwapSeconds.toNumber();
    const divergence=spot.value.sub(twap.value).abs().div(twap.value).mul(10000).toNumber();
    const valid=now-spot.timestamp<=maxAge&&now-spot.timestamp>=-30&&now-twap.timestamp<=maxTwapAge&&now-twap.timestamp>=-30&&divergence<=token.maxTwapDivergenceBps.toNumber()&&token.blockPriceUsage===0;
    return {value:spot.value.toNumber(),timestamp:spot.timestamp,age:Math.max(0,now-spot.timestamp),maxAge,valid};
  }
  const stockPrice=price(stock),cashPrice=price(debt);
  const row=Array.isArray(metrics)?metrics.find((r:{reserve:string})=>r.reserve===CASH_RESERVE):null;
  const apy=Number(row?.borrowApy);
  if(!Number.isFinite(apy)||apy<0||apy>10)throw new Error('Borrowing rate unavailable.');
  const borrowed=new Fraction(debt.liquidity.borrowedAmountSf).toDecimal();
  const available=new Decimal(debt.liquidity.totalAvailableAmount.toString()).sub(new Fraction(debt.liquidity.accumulatedProtocolFeesSf).toDecimal()).sub(new Fraction(debt.liquidity.accumulatedReferrerFeesSf).toDecimal());
  const cap=debt.config.debtWithdrawalCap;
  const capRemaining=cap.configCapacity.isZero()?new Decimal(Infinity):new Decimal(cap.configCapacity.toString()).sub(now>=cap.lastIntervalStartTimestamp.toNumber()+cap.configIntervalLengthSeconds.toNumber()?0:cap.currentTotal.toString());
  const liquidity=Decimal.max(0,Decimal.min(available,new Decimal(debt.config.borrowLimit.toString()).sub(borrowed),capRemaining)).div(1e6).toNumber();
  const feeRate=new Fraction(debt.config.fees.originationFeeSf).toDecimal().toNumber();
  const borrowFactor=debt.config.borrowFactorPct.toNumber()/100;
  const enabled=stock.config.status===0&&debt.config.status===0&&stock.config.emergencyMode===0&&debt.config.emergencyMode===0&&stock.config.disableUsageAsCollOutsideEmode===0&&stock.config.permissionedOps.isZero()&&debt.config.permissionedOps.isZero()&&stockPrice.valid&&cashPrice.valid;
  return {multiplier,decimals:8,slot:accounts.context.slot,fetchedAt:new Date().toISOString(),stockPrice,cashPrice,apy,feeRate,borrowFactor,liquidity,maxLtv:stock.config.loanToValuePct/100,liquidationLtv:stock.config.liquidationThresholdPct/100,enabled,stock,debt};
}

// Collapse concurrent reads from market and position requests; never cache errors.
let snapshot: Awaited<ReturnType<typeof readMarketSnapshot>> | null = null;
let pending: ReturnType<typeof readMarketSnapshot> | null = null;
let validUntil = 0;
export async function marketSnapshot(){
  if(snapshot && Date.now()<validUntil)return snapshot;
  if(pending)return pending;
  pending=readMarketSnapshot().then(value=>{
    snapshot=value;
    validUntil=Math.min(Date.now()+8000,(value.stockPrice.timestamp+value.stockPrice.maxAge)*1000,(value.cashPrice.timestamp+value.cashPrice.maxAge)*1000);
    return value;
  }).finally(()=>{pending=null});
  return pending;
}
