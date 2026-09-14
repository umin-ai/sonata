import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import Decimal from 'decimal.js';
import { Obligation } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Obligation';
import { Fraction,bfToDecimal } from '@kamino-finance/klend-sdk/dist/classes/fraction';
import type { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve';
import { MARKET } from '../finance';
import { KLEND,STOCK_RESERVE,CASH_RESERVE,rpc } from './chain';

export function obligationAddress(wallet:string){
  return PublicKey.findProgramAddressSync([Buffer.from([0]),Buffer.from([0]),new PublicKey(wallet).toBuffer(),new PublicKey(MARKET).toBuffer(),Buffer.alloc(32),Buffer.alloc(32)],new PublicKey(KLEND))[0].toBase58();
}
export function readObligation(account:any,wallet:string){
  if(!account)return null;
  if(account.owner!==KLEND)throw new Error('Unexpected position owner.');
  const state=Obligation.decode(Buffer.from(account.data[0],'base64'));
  if(state.owner!==wallet||state.lendingMarket!==MARKET||!state.tag.isZero())throw new Error('Unexpected lending position.');
  return state;
}
export function positionSummary(state:Obligation|null,stock:Reserve,debt:Reserve,multiplier:number){
  if(!state)return {exists:false,supported:true,collateralRaw:'0',collateralReceiptRaw:'0',stock:0,debt:0,debtRaw:'0',hasDebt:false};
  const deposits=state.deposits.filter(x=>!x.depositedAmount.isZero()),borrows=state.borrows.filter(x=>!x.borrowedAmountSf.isZero());
  const supported=state.elevationGroup===0&&deposits.every(x=>x.depositReserve===STOCK_RESERVE)&&borrows.every(x=>x.borrowReserve===CASH_RESERVE)&&state.ownershipTransferState===0;
  if(!supported)return {exists:true,supported:false,collateralRaw:'0',collateralReceiptRaw:'0',stock:0,debt:0,debtRaw:'0',hasDebt:state.hasDebt!==0};
  const total=new Decimal(stock.liquidity.totalAvailableAmount.toString()).add(new Fraction(stock.liquidity.borrowedAmountSf).toDecimal()).sub(new Fraction(stock.liquidity.accumulatedProtocolFeesSf).toDecimal()).sub(new Fraction(stock.liquidity.accumulatedReferrerFeesSf).toDecimal()).sub(new Fraction(stock.liquidity.pendingReferrerFeesSf).toDecimal());
  const receipts=new Decimal(deposits[0]?.depositedAmount.toString()||0);
  const collateralRaw=receipts.isZero()?new Decimal(0):receipts.mul(total).div(stock.collateral.mintTotalSupply.toString());
  const borrowed=borrows[0];
  const owed=borrowed?new Fraction(borrowed.borrowedAmountSf).toDecimal().mul(bfToDecimal(debt.liquidity.cumulativeBorrowRateBsf)).div(bfToDecimal(borrowed.cumulativeBorrowRateBsf)):new Decimal(0);
  return {exists:true,supported,collateralRaw:collateralRaw.floor().toFixed(0),collateralReceiptRaw:receipts.toFixed(0),stock:collateralRaw.div(1e8).mul(multiplier).toNumber(),debt:owed.div(1e6).toNumber(),debtRaw:owed.ceil().toFixed(0),hasDebt:!owed.isZero()};
}
export async function fetchPosition(wallet:string){const address=obligationAddress(wallet);const account=await rpc('getAccountInfo',[address,{encoding:'base64',commitment:'confirmed'}]);return {address,state:readObligation(account.value,wallet)}}
