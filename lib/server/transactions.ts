import { Buffer } from 'buffer';
import Decimal from 'decimal.js';
import { PublicKey,VersionedTransaction,TransactionMessage,TransactionInstruction,AddressLookupTableAccount,ComputeBudgetProgram } from '@solana/web3.js';
import { z } from 'zod';
import { NVDA,USDC,MARKET,loanScenario } from '../finance';
import { balances,rpc,getJSON,walletAddress,STOCK_RESERVE,CASH_RESERVE,TOKEN_2022,TOKEN_PROGRAM } from './chain';
import { marketSnapshot } from './market';
import { fetchPosition,positionSummary,readObligation } from './position';
import { quoteForCash,jupiterHeaders } from './quotes';
import { verifyInstructions,verifyBalanceChanges,COMPUTE,type ActionKind } from './transaction-policy';

export const ActionSchema=z.object({kind:z.enum(['sale','deposit','borrow','repay','withdraw']),wallet:z.string().min(32).max(44),cash:z.number().finite().min(.01).max(100000),stock:z.number().finite().min(0).max(10000)}).strict();
const U64_MAX='18446744073709551615';
type ApiIx={programId:string;accounts:{pubkey:string;isSigner:boolean;isWritable:boolean}[];data:string};
function instruction(ix:ApiIx){return new TransactionInstruction({programId:new PublicKey(ix.programId),keys:ix.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})),data:Buffer.from(ix.data,'base64')})}
export async function lookupTables(transaction:VersionedTransaction){
  const keys=transaction.message.addressTableLookups.map(t=>t.accountKey.toBase58());if(!keys.length)return [];
  const r=await rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'confirmed'}]);
  return r.value.map((a:any,i:number)=>{if(!a||a.owner!=='AddressLookupTab1e1111111111111111111111111')throw new Error('Lookup table could not be verified.');return new AddressLookupTableAccount({key:new PublicKey(keys[i]),state:AddressLookupTableAccount.deserialize(Buffer.from(a.data[0],'base64'))})});
}
function tokenAmount(account:any,wallet:string,mint:string,program:string){
  if(!account)return 0n;
  const b=Buffer.from(account.data[0],'base64');
  if(account.owner!==program||b.length<165||new PublicKey(b.subarray(0,32)).toBase58()!==mint||new PublicKey(b.subarray(32,64)).toBase58()!==wallet)throw new Error('Simulated token ownership changed.');
  if(b[108]!==1||b.readUInt32LE(72)!==0||b.readUInt32LE(129)!==0)throw new Error('Unsupported token account authority or state.');
  return b.readBigUInt64LE(64);
}
export async function prepareAction(input:z.infer<typeof ActionSchema>){
  const wallet=walletAddress(input.wallet),kind:ActionKind=input.kind;
  const [w,m,p]=await Promise.all([balances(wallet),marketSnapshot(),fetchPosition(wallet)]);
  const position=positionSummary(p.state,m.stock,m.debt,m.multiplier);
  if(kind!=='sale'&&!position.supported)throw new Error('This position contains other assets or settings. Manage it in Kamino.');
  if(w.sol<=0)throw new Error('This wallet needs SOL for network fees and account setup.');
  if(['deposit','borrow'].includes(kind)&&!m.enabled)throw new Error('Lending is unavailable or the oracle checks did not pass. Refresh later.');
  let rawAmount='',minimumCash=0n,quotedCash=0,instructions:TransactionInstruction[]=[],tables:AddressLookupTableAccount[]=[];
  if(kind==='sale'){
    const {raw}=await quoteForCash(input.cash);
    // Re-price using Metis so the wallet can submit the transaction itself.
    // A 0.5% slippage margin is included in the input sizing; the verified minimum must meet the cash target.
    let sized=Math.ceil(raw/0.995*1.001),build:any;
    for(let attempt=0;attempt<3;attempt++){
      if(BigInt(sized)>BigInt(w.stockAtaRaw))throw new Error('Not enough spendable NVDAx in this wallet’s associated token account.');
      build=await getJSON('https://api.jup.ag/swap/v2/build?'+new URLSearchParams({inputMint:NVDA,outputMint:USDC,amount:String(sized),taker:wallet,slippageBps:'50',maxAccounts:'48',destinationTokenAccount:w.cashAta}),{headers:jupiterHeaders()});
      if(build.inputMint!==NVDA||build.outputMint!==USDC||build.inAmount!==String(sized)||build.swapMode!=='ExactIn'||build.slippageBps!==50||!/^\d+$/.test(build.otherAmountThreshold))throw new Error('Unexpected executable swap quote.');
      if(BigInt(build.otherAmountThreshold)>=BigInt(Math.ceil(input.cash*1e6)))break;
      sized=Math.ceil(sized*input.cash/(Number(build.otherAmountThreshold)/1e6)*1.001);
    }
    rawAmount=build.inAmount;minimumCash=BigInt(build.otherAmountThreshold);quotedCash=Number(build.outAmount)/1e6;
    if(minimumCash<BigInt(Math.ceil(input.cash*1e6)))throw new Error('No executable route met your cash target.');
    instructions=[...build.setupInstructions,build.swapInstruction,...(build.cleanupInstruction?[build.cleanupInstruction]:[]),...(build.otherInstructions??[])].map(instruction);
    const keys=Object.keys(build.addressesByLookupTableAddress??{});
    if(keys.length){const r=await rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'confirmed'}]);tables=r.value.map((a:any,i:number)=>{if(a?.owner!=='AddressLookupTab1e1111111111111111111111111')throw new Error('Invalid swap lookup table');return new AddressLookupTableAccount({key:new PublicKey(keys[i]),state:AddressLookupTableAccount.deserialize(Buffer.from(a.data[0],'base64'))})})}
  }else{
    if(kind==='deposit'){
      rawAmount=new Decimal(input.stock).div(m.multiplier).mul(1e8).floor().toFixed(0);
      if(BigInt(rawAmount)<=0n||BigInt(rawAmount)>BigInt(w.stockAtaRaw))throw new Error('Choose an available amount of NVDAx to deposit.');
      const model=loanScenario(input.cash,(position.stock+input.stock)/m.multiplier*m.stockPrice.value,m.apy,0,m.maxLtv,m.liquidationLtv,0,{feeRate:m.feeRate,borrowFactor:m.borrowFactor,cashPrice:m.cashPrice.value});
      if(!model.allowed||position.hasDebt||input.cash>m.liquidity)throw new Error('This deposit does not support the proposed loan, or this position already has debt.');
    }else if(kind==='borrow'){
      if(!position.exists||position.stock<=0)throw new Error('Deposit collateral first, then refresh the position.');
      if(position.hasDebt)throw new Error('This release supports one outstanding loan. Repay it before borrowing again.');
      const model=loanScenario(input.cash,position.stock/m.multiplier*m.stockPrice.value,m.apy,0,m.maxLtv,m.liquidationLtv,0,{feeRate:m.feeRate,borrowFactor:m.borrowFactor,cashPrice:m.cashPrice.value});
      if(!model.allowed||input.cash>m.liquidity)throw new Error('The requested loan exceeds current collateral or liquidity limits.');
      if(m.feeRate!==0)throw new Error('The market introduced an origination fee. This execution integration must be reverified.');
      rawAmount=new Decimal(input.cash).mul(1e6).ceil().toFixed(0);minimumCash=BigInt(rawAmount);quotedCash=input.cash;
    }else{
      if(!position.exists)throw new Error('No lending position exists for this wallet.');
      if(kind==='repay'&&!position.hasDebt)throw new Error('There is no debt to repay.');
      if(kind==='withdraw'&&(position.hasDebt||position.stock<=0))throw new Error('Repay all debt before releasing collateral.');
      if(kind==='repay'&&BigInt(w.cashAtaRaw)<BigInt(position.debtRaw))throw new Error('This wallet needs enough USDC to repay the debt plus accrued interest.');
      rawAmount=U64_MAX;
    }
    const reserve=['borrow','repay'].includes(kind)?CASH_RESERVE:STOCK_RESERVE;
    const amount=new Decimal(rawAmount).div(['borrow','repay'].includes(kind)?1e6:1e8).toFixed();
    const built=await getJSON(`https://api.kamino.finance/ktx/klend/${kind}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet,market:MARKET,reserve,amount})});
    if(typeof built.transaction!=='string'||built.transaction.length>20000)throw new Error('Lending transaction unavailable.');
    const tx=VersionedTransaction.deserialize(Buffer.from(built.transaction,'base64'));
    if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==wallet)throw new Error('Unexpected transaction signer.');
    tables=await lookupTables(tx);
    instructions=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables}).instructions.filter(ix=>ix.programId.toBase58()!==COMPUTE);
  }
  const intent={kind,wallet,obligation:p.address,stockAta:w.stockAta,cashAta:w.cashAta,rawAmount};
  verifyInstructions(instructions,intent);
  const block=await rpc('getLatestBlockhash',[{commitment:'confirmed'}]);
  const compile=(units:number)=>new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(wallet),recentBlockhash:block.value.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...instructions]}).compileToV0Message(tables));
  const addresses=[wallet,w.stockAta,w.cashAta,p.address];
  async function simulate(tx:VersionedTransaction){
    const result=await rpc('simulateTransaction',[Buffer.from(tx.serialize()).toString('base64'),{encoding:'base64',sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses}}]);
    if(result.value.err)throw new Error(`Simulation rejected this action: ${JSON.stringify(result.value.err)}. Nothing was sent.`);
    if(!result.value.accounts)throw new Error('Simulation returned no account changes.');
    return result;
  }
  const first=await simulate(compile(1400000));
  const units=Math.min(1400000,Math.max(200000,Math.ceil(first.value.unitsConsumed*1.2)));
  const tx=compile(units),sim=await simulate(tx);
  const [afterWallet,afterStock,afterCash,afterPosition]=sim.value.accounts;
  const stockAfter=tokenAmount(afterStock,wallet,NVDA,TOKEN_2022),cashAfter=tokenAmount(afterCash,wallet,USDC,TOKEN_PROGRAM);
  const stockDelta=stockAfter-BigInt(w.stockAtaRaw),cashDelta=cashAfter-BigInt(w.cashAtaRaw);
  const post=readObligation(afterPosition,wallet);
  const postSummary=positionSummary(post,m.stock,m.debt,m.multiplier);
  if(kind==='sale'&&p.state&&post?.toJSON().borrowedAssetsMarketValueSf!==p.state.toJSON().borrowedAssetsMarketValueSf)throw new Error('Sale unexpectedly changed a lending position.');
  if(kind==='deposit'&&(!postSummary.exists||!postSummary.supported||BigInt(postSummary.collateralReceiptRaw)<=BigInt(position.collateralReceiptRaw)))throw new Error('Deposit did not increase collateral.');
  if(kind==='borrow'&&(!postSummary.supported||!postSummary.hasDebt))throw new Error('Borrowing did not create the expected position.');
  verifyBalanceChanges(kind,stockDelta,cashDelta,BigInt(rawAmount),minimumCash,postSummary.hasDebt);
  if(!afterWallet||afterWallet.owner!=='11111111111111111111111111111111')throw new Error('Unexpected wallet account change.');
  const feeResult=await rpc('getFeeForMessage',[Buffer.from(tx.message.serialize()).toString('base64'),{commitment:'confirmed'}]);
  if(feeResult.value===null)throw new Error('Network fee could not be determined.');
  const solCost=w.sol-afterWallet.lamports/1e9;
  if(solCost<0||solCost>.1)throw new Error('Unexpected SOL cost. This action needs manual investigation.');
  return {kind,wallet,transaction:Buffer.from(tx.serialize()).toString('base64'),messageHash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(tx.message.serialize())))).map(n=>n.toString(16).padStart(2,'0')).join(''),expiresAt:Date.now()+20000,lastValidBlockHeight:block.value.lastValidBlockHeight,preparedAt:new Date().toISOString(),simulationSlot:sim.context.slot,network:'solana:mainnet',stockDelta:Number(stockDelta)/1e8*m.multiplier,cashDelta:Number(cashDelta)/1e6,stockAfter:Number(stockAfter)/1e8*m.multiplier,cashAfter:Number(cashAfter)/1e6,minimumCash:Number(minimumCash)/1e6,quotedCash,networkFee:feeResult.value/1e9,solCost,position:postSummary,slippageBps:kind==='sale'?50:0,scope:'Unsigned transaction. Simulation passed; nothing has been signed or submitted.'};
}
