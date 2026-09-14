import { TransactionInstruction } from '@solana/web3.js';
import { MARKET,NVDA,USDC } from '../finance';
import { KLEND,STOCK_RESERVE,CASH_RESERVE,TOKEN_PROGRAM,TOKEN_2022 } from './chain';
import { DISCRIMINATOR as deposit } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/depositReserveLiquidityAndObligationCollateralV2';
import { DISCRIMINATOR as borrow } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/borrowObligationLiquidityV2';
import { DISCRIMINATOR as repay } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/repayObligationLiquidityV2';
import { DISCRIMINATOR as withdraw } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/withdrawObligationCollateralAndRedeemReserveCollateralV2';
import { DISCRIMINATOR as refreshReserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/refreshReserve';
import { DISCRIMINATOR as refreshObligation } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/refreshObligation';
import { DISCRIMINATOR as initObligation } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initObligation';
import { DISCRIMINATOR as initUserMetadata } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initUserMetadata';
import { DISCRIMINATOR as initFarm } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initObligationFarmsForReserve';

export type ActionKind='sale'|'deposit'|'borrow'|'repay'|'withdraw';
export const JUPITER_PROGRAM='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const COMPUTE='ComputeBudget111111111111111111111111111111';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',LUT='AddressLookupTab1e1111111111111111111111111';
export type Intent={kind:ActionKind;wallet:string;obligation:string;stockAta:string;cashAta:string;rawAmount:string};
export function verifyInstructions(instructions:TransactionInstruction[],intent:Intent){
  let actions=0;
  function assertIntent(value:boolean){if(!value)throw new Error('Transaction differs from the requested action. Nothing was sent.');}
  for(const ix of instructions){
    const pid=ix.programId.toBase58(),keys=ix.keys.map(k=>k.pubkey.toBase58()),tag=ix.data.subarray(0,8);
    assertIntent(ix.keys.every(k=>!k.isSigner||k.pubkey.toBase58()===intent.wallet));
    if(pid===COMPUTE)continue;
    if(pid===ATA){assertIntent((ix.data.length===0||ix.data[0]===1)&&keys[0]===intent.wallet&&keys[2]===intent.wallet&&[NVDA,USDC].includes(keys[3])&&[TOKEN_PROGRAM,TOKEN_2022].includes(keys[5]));continue;}
    if(pid===LUT){assertIntent(intent.kind==='deposit'&&ix.data.readUInt32LE(0)===0&&keys[1]===intent.wallet&&keys[2]===intent.wallet);continue;}
    if(pid===JUPITER_PROGRAM){assertIntent(intent.kind==='sale'&&keys.includes(intent.wallet)&&keys.includes(intent.stockAta)&&keys.includes(intent.cashAta));actions++;continue;}
    assertIntent(pid===KLEND&&intent.kind!=='sale');
    const target={deposit,borrow,repay,withdraw}[intent.kind as Exclude<ActionKind,'sale'>];
    if(tag.equals(target)){
      assertIntent(ix.data.length===16&&ix.data.readBigUInt64LE(8)===BigInt(intent.rawAmount));
      assertIntent(keys[0]===intent.wallet&&keys[1]===intent.obligation&&keys[2]===MARKET);
      if(intent.kind==='repay')assertIntent(keys[3]===CASH_RESERVE&&keys[4]===USDC&&keys[6]===intent.cashAta);
      else assertIntent(keys[4]===(intent.kind==='borrow'?CASH_RESERVE:STOCK_RESERVE)&&keys[5]===(intent.kind==='borrow'?USDC:NVDA)&&keys[intent.kind==='borrow'?8:9]===(intent.kind==='borrow'?intent.cashAta:intent.stockAta));
      actions++;continue;
    }
    if(tag.equals(refreshReserve)){assertIntent([STOCK_RESERVE,CASH_RESERVE].includes(keys[0])&&keys[1]===MARKET);continue;}
    if(tag.equals(refreshObligation)){assertIntent(keys[0]===MARKET&&keys[1]===intent.obligation);continue;}
    if(tag.equals(initObligation)){assertIntent(intent.kind==='deposit'&&keys[0]===intent.wallet&&keys[1]===intent.wallet&&keys[2]===intent.obligation&&keys[3]===MARKET&&ix.data.length===10&&ix.data[8]===0&&ix.data[9]===0);continue;}
    if(tag.equals(initUserMetadata)){assertIntent(intent.kind==='deposit'&&keys[0]===intent.wallet&&keys[1]===intent.wallet);continue;}
    if(tag.equals(initFarm)){assertIntent(keys[0]===intent.wallet&&keys[1]===intent.wallet&&keys[2]===intent.obligation&&[STOCK_RESERVE,CASH_RESERVE].includes(keys[4])&&keys[7]===MARKET);continue;}
    throw new Error('This transaction uses an unsupported lending instruction. Nothing was sent.');
  }
  assertIntent(actions===1);
}

export function verifyBalanceChanges(kind:ActionKind,stockDelta:bigint,cashDelta:bigint,rawAmount:bigint,minCash:bigint,remainingDebt:boolean){
  if(kind==='sale'&&(stockDelta!==-rawAmount||cashDelta<minCash))throw new Error('Sale simulation did not deliver the reviewed amounts.');
  if(kind==='deposit'&&(stockDelta!==-rawAmount||cashDelta!==0n))throw new Error('Collateral simulation did not match the deposit.');
  if(kind==='borrow'&&(stockDelta!==0n||cashDelta<minCash))throw new Error('Borrow simulation did not deliver the requested USDC.');
  if(kind==='repay'&&(stockDelta!==0n||cashDelta>=0n||remainingDebt))throw new Error('Repayment simulation did not clear the debt.');
  if(kind==='withdraw'&&(stockDelta<=0n||cashDelta!==0n||remainingDebt))throw new Error('Withdrawal simulation did not release debt-free collateral.');
}
