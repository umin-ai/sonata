import { validPositive,rawFromDisplay,displayFromRaw,NVDA } from '@/lib/finance';
import { marketSnapshot } from '@/lib/server/market';
import { quoteForCash } from '@/lib/server/quotes';
import { failure } from '@/lib/server/chain';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const search=new URL(request.url).searchParams,cash=Number(search.get('cash')),holding=Number(search.get('holding'));
  if(!validPositive(cash,100000)||cash<.01||!Number.isFinite(holding)||holding<0||holding>10000)return failure(new Error('Enter $0.01–$100,000 and a stock balance from 0 to 10,000.'),400);
  try{
    const [m,{q,raw,rawMarketPrice}]=await Promise.all([marketSnapshot(),quoteForCash(cash)]);
    return Response.json({cash,holding,quotedAt:m.fetchedAt,expiresAt:Date.now()+20000,mint:NVDA,decimals:8,multiplier:m.multiplier,
      sale:{rawAmount:String(raw),displayAmount:displayFromRaw(raw,8,m.multiplier),received:Number(q.outAmount)/1e6,feeBps:q.feeBps,feeMint:q.feeMint,router:q.router,routes:[...new Set(q.routePlan.map(r=>r.swapInfo.label))],withinHolding:raw<=rawFromDisplay(holding,8,m.multiplier),rawMarketPrice,networkFeeKnown:false},
      borrowing:{apy:m.apy,maxLtv:m.maxLtv,collateralValue:holding/m.multiplier*m.stockPrice.value,rawReferencePrice:m.stockPrice.value,liquidationLtv:m.liquidationLtv,feeRate:m.feeRate,borrowFactor:m.borrowFactor,cashPrice:m.cashPrice.value,liquidity:m.liquidity,enabled:m.enabled,oracleAge:m.stockPrice.age,oracleMaxAge:m.stockPrice.maxAge,oracleTimestamp:m.stockPrice.timestamp,slot:m.slot,feesVerified:true,indicative:true},
      scope:'Live quotes and decoded onchain reserve/oracle inputs. Borrowing outcomes remain scenarios until a wallet-specific transaction is simulated.'
    },{headers:{'Cache-Control':'no-store'}});
  }catch(error){return failure(error)}
}
