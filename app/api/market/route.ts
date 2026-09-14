import {marketSnapshot} from '@/lib/server/market';
import {failure} from '@/lib/server/chain';
export const dynamic='force-dynamic';
export async function GET(){try{
  const m=await marketSnapshot();
  return Response.json({terms:{price:m.stockPrice.value/m.multiplier,cashPrice:m.cashPrice.value,apy:m.apy,maxLtv:m.maxLtv,liquidationLtv:m.liquidationLtv,feeRate:m.feeRate,borrowFactor:m.borrowFactor},
    multiplier:m.multiplier,slot:m.slot,fetchedAt:m.fetchedAt,expiresAt:Math.min(Date.now()+30000,(m.stockPrice.timestamp+m.stockPrice.maxAge)*1000,(m.cashPrice.timestamp+m.cashPrice.maxAge)*1000),
    enabled:m.enabled,liquidity:m.liquidity,oracleTimestamp:m.stockPrice.timestamp,
    scope:'Read-only market snapshot. Reserve liquidity is not a personalized borrowing offer. Eligibility and execution limits must be checked in Kamino.'},
    {headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e)}}
