import { NVDA, USDC, MARKET, validPositive, effectiveMultiplier, rawFromDisplay, displayFromRaw } from '@/lib/finance';
import { z } from 'zod';
export const dynamic='force-dynamic';
const MintSchema=z.object({result:z.object({value:z.object({owner:z.literal('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),data:z.object({parsed:z.object({info:z.object({decimals:z.literal(8),extensions:z.array(z.object({extension:z.string(),state:z.record(z.unknown())}))})})})})})});
const MultiplierSchema=z.object({multiplier:z.string(),newMultiplier:z.string().optional(),newMultiplierEffectiveTimestamp:z.number().optional()});
const ReserveSchema=z.object({liquidityTokenMint:z.string(),totalSupplyUsd:z.string(),totalSupply:z.string(),maxLtv:z.string(),borrowApy:z.string()});
const QuoteSchema=z.object({inputMint:z.literal(NVDA),outputMint:z.literal(USDC),inAmount:z.string().regex(/^\d+$/),outAmount:z.string().regex(/^\d+$/),transaction:z.null(),feeBps:z.number().min(0).max(10000),feeMint:z.string(),router:z.string(),routePlan:z.array(z.object({swapInfo:z.object({label:z.string()})})).default([])});
async function getJSON(url:string,init:RequestInit={}){
 const res=await fetch(url,{...init,headers:{'User-Agent':'Stockroom/0.1 (read-only market preview)',...init.headers},signal:AbortSignal.timeout(12000),cache:'no-store'});
 if(res.status===429)throw new Error('Market provider is rate-limiting requests. Wait a minute, then refresh.');
 if(!res.ok)throw new Error(`${new URL(url).hostname} returned ${res.status}`);
 const json=await res.json();if(json&&typeof json==='object'&&'error' in json&&json.error)throw new Error('Provider could not return market data');return json;
}
export async function GET(request:Request){
 const search=new URL(request.url).searchParams;
 const cash=Number(search.get('cash')),holding=Number(search.get('holding'));
 if(!validPositive(cash,100000)||cash<.01||!validPositive(holding,10000))return Response.json({error:'Enter a cash amount from 0.01 to 100,000 and a holding greater than zero, up to 10,000.'},{status:400});
 try{
  const [mint,market]=await Promise.all([
   getJSON('https://solana-rpc.publicnode.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[NVDA,{encoding:'jsonParsed'}]})}),
   getJSON(`https://api.kamino.finance/kamino-market/${MARKET}/reserves/metrics`)
  ]);
  const info=MintSchema.parse(mint).result.value.data.parsed.info;
  if(!info||info.decimals!==8)throw new Error('Stock mint metadata could not be verified');
  if(info.extensions?.some((e)=>e.extension==='pausableConfig'&&e.state.paused))throw new Error('Issuer has paused this token');
  const config=info.extensions?.find((e:{extension:string})=>e.extension==='scaledUiAmountConfig')?.state;
  if(!config)throw new Error('Stock multiplier unavailable');
  const multiplier=effectiveMultiplier(MultiplierSchema.parse(config),Date.now()/1000);
  if(!Array.isArray(market))throw new Error('Lending market data unavailable');
  const reserves=z.array(ReserveSchema).parse(market);
  const stock=reserves.find((r:{liquidityTokenMint:string})=>r.liquidityTokenMint===NVDA);
  const debt=reserves.find((r:{liquidityTokenMint:string})=>r.liquidityTokenMint===USDC);
  if(!stock||!debt)throw new Error('Stock collateral or USDC reserve is unavailable');
  // API reserve quantities are treated as unscaled token quantities for this estimate.
  // The loan preview is indicative, not a protocol-computed wallet obligation.
  const rawReferencePrice=Number(stock.totalSupplyUsd)/Number(stock.totalSupply);
  const maxLtv=Number(stock.maxLtv),borrowApy=Number(debt.borrowApy);
  if(!validPositive(rawReferencePrice,1e7)||!validPositive(maxLtv,1)||!Number.isFinite(borrowApy)||borrowApy<0||borrowApy>10)throw new Error('Unexpected lending data');
  const quote=async(raw:number)=>{
   const q=QuoteSchema.parse(await getJSON('https://api.jup.ag/swap/v2/order?'+new URLSearchParams({inputMint:NVDA,outputMint:USDC,amount:String(raw)})));
   if(q.inputMint!==NVDA||q.outputMint!==USDC||q.inAmount!==String(raw)||!/^\d+$/.test(q.outAmount)||Number(q.outAmount)<=0||q.transaction)throw new Error('Unexpected quote response');
   return q;
  };
  const unit=await quote(100000000);
  const rawMarketPrice=Number(unit.outAmount)/1e6;
  let raw=Math.ceil(cash/rawMarketPrice*1e8*1.0002), q=await quote(raw);
  for(let i=0;i<2&&Number(q.outAmount)/1e6<cash;i++){
   raw=Math.ceil(raw*cash/(Number(q.outAmount)/1e6)*1.0002);q=await quote(raw);
  }
  if(Number(q.outAmount)/1e6<cash)throw new Error('Could not find a quote meeting the requested amount');
  const at=new Date().toISOString();
  return Response.json({cash,holding,quotedAt:at,expiresAt:Date.now()+20000,mint:NVDA,decimals:info.decimals,multiplier,
   sale:{rawAmount:String(raw),displayAmount:displayFromRaw(raw,info.decimals,multiplier),received:Number(q.outAmount)/1e6,feeBps:Number(q.feeBps??0),feeMint:q.feeMint,router:q.router,routes:[...new Set((q.routePlan??[]).map((r:{swapInfo:{label:string}})=>r.swapInfo.label))],withinHolding:raw<=rawFromDisplay(holding,info.decimals,multiplier),rawMarketPrice,networkFeeKnown:false},
   borrowing:{apy:borrowApy,maxLtv,collateralValue:holding/multiplier*rawReferencePrice,rawReferencePrice,liquidationLtv:.65,liquidationSource:'Kamino reserve UI, observed 14 September 2026; not refreshed by this API',feesVerified:false,indicative:true},
   scope:'Quote only. Sample holdings. No wallet, loan eligibility or executable transaction verified.'
  },{headers:{'Cache-Control':'no-store'}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'Market check unavailable',scope:'No cached quote has been substituted.'},{status:502,headers:{'Cache-Control':'no-store'}});}
}
