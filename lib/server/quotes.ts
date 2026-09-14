import { z } from 'zod';
import { NVDA,USDC } from '../finance';
import { getJSON } from './chain';
const QuoteSchema=z.object({inputMint:z.literal(NVDA),outputMint:z.literal(USDC),inAmount:z.string().regex(/^\d+$/),outAmount:z.string().regex(/^\d+$/),transaction:z.null(),feeBps:z.number().min(0).max(10000),feeMint:z.string(),router:z.string(),routePlan:z.array(z.object({swapInfo:z.object({label:z.string()})})).default([])});
const headers=():Record<string,string>=>process.env.JUPITER_API_KEY?{'x-api-key':process.env.JUPITER_API_KEY}:{};
export async function quoteRaw(raw:number){
  if(!Number.isSafeInteger(raw)||raw<=0)throw new Error('Invalid stock amount.');
  const q=QuoteSchema.parse(await getJSON('https://api.jup.ag/swap/v2/order?'+new URLSearchParams({inputMint:NVDA,outputMint:USDC,amount:String(raw)}),{headers:headers()}));
  if(q.inAmount!==String(raw)||Number(q.outAmount)<=0)throw new Error('Unexpected quote amount.');
  return q;
}
export async function quoteForCash(cash:number){
  const unit=await quoteRaw(1e8),rawMarketPrice=Number(unit.outAmount)/1e6;
  let raw=Math.ceil(cash/rawMarketPrice*1e8*1.0002),q=await quoteRaw(raw);
  for(let i=0;i<2&&Number(q.outAmount)/1e6<cash;i++){raw=Math.ceil(raw*cash/(Number(q.outAmount)/1e6)*1.0002);q=await quoteRaw(raw)}
  if(Number(q.outAmount)/1e6<cash)throw new Error('No quote met the cash target.');
  return {q,raw,rawMarketPrice};
}
export const jupiterHeaders=headers;
