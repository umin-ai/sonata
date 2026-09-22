import { marketAssets } from '@/lib/vaults/market-assets';
import { USDC } from '@/lib/finance';
const cache=new Map<string,{until:number;data:unknown}>();
const requests=new Map<string,Promise<unknown>>();
export async function GET(request:Request) {
  const id=new URL(request.url).searchParams.get('asset')??'';
  const asset=Object.hasOwn(marketAssets,id)?marketAssets[id]:undefined;
  if(!asset) return Response.json({error:'No verified market source configured for this asset.'},{status:404});
  try {
    const cached=cache.get(id);
    if(cached && cached.until>Date.now()) return Response.json(cached.data);
    let pending=requests.get(id);
    if(!pending){ pending = (async()=>{
      const response=await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${asset.mint}`,{signal:AbortSignal.timeout(12000)});
      if(!response.ok) throw Error('Market data provider unavailable');
      const rows=await response.json();
      if(!Array.isArray(rows)) throw Error('Invalid market response');
      const pairs=rows.filter(p=>p.chainId==='solana' && p.baseToken?.address===asset.mint && p.quoteToken?.address===USDC && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.pairAddress) && Number(p.priceUsd)>0 && Number.isFinite(Number(p.priceUsd))).sort((a,b)=>(b.liquidity?.usd??0)-(a.liquidity?.usd??0));
      const p=pairs[0]; if(!p) throw Error('No verified stock/USDC source pool available');
      const number=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
      const data={mint:asset.mint,pair:p.pairAddress,dex:p.dexId,price:Number(p.priceUsd),change:typeof p.priceChange?.h24==='number'&&Number.isFinite(p.priceChange.h24)?p.priceChange.h24:null,volume:number(p.volume?.h24),liquidity:number(p.liquidity?.usd),marketCap:number(p.marketCap),fetchedAt:new Date().toISOString()};
      cache.set(id,{until:Date.now()+60000,data});return data;
    })().finally(()=>{requests.delete(id)});requests.set(id,pending);}
    return Response.json(await pending);
  } catch { return Response.json({error:'Market data is temporarily unavailable. Please retry.'},{status:502}); }
}
