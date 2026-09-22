'use client';
import {valueTone} from '@/lib/value-tone';
import { marketAssets } from '@/lib/vaults/market-assets';
import {TokenName} from './token-identity';
import {useEffect,useState} from 'react';
import {Card} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
type Market={mint:string;pair:string;dex:string;price:number;change:number|null;volume:number|null;liquidity:number|null;marketCap:number|null;fetchedAt:string};
const dollars=(n:number|null|undefined)=>n==null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2,notation:n>=1000000?'compact':'standard'}).format(n);
export function TokenMarketPanel({id}:{id:string}) {
 const asset=Object.hasOwn(marketAssets,id)?marketAssets[id]:undefined;
 const [data,setData]=useState<Market|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 useEffect(()=>{if(!asset)return;let active=true;const abort=new AbortController();setLoading(true);setError('');setData(null);fetch(`/api/token-market?asset=${id}`,{signal:abort.signal}).then(async r=>{const body=await r.json() as Market & {error?:string};if(!r.ok)throw Error(body.error);return body as Market}).then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false;abort.abort()}},[id,revision]);
 if(!asset)return null;
 const url=data?`https://dexscreener.com/solana/${data.pair}`:'';
 return <Card className="sr-panel" style={{marginBottom:24}}>
  <div className="sr-section-top"><div><Badge variant="outline">Solana mainnet · market reference</Badge><h2 style={{marginTop:12}}><TokenName symbol={asset.symbol} /> market</h2><p>Live market context. This pool is not connected to the simulated vault below.</p></div><Button variant="outline" disabled={loading} onClick={()=>setRevision(x=>x+1)}>{loading?'Loading…':'Refresh market'}</Button></div>
  {error&&<p role="alert">{error} {data?'Previously fetched figures remain below.':''}</p>}
  <div className="sr-market-data-grid">{[
   ['Token price',dollars(data?.price),data?.change!=null?`${data.change>0?'+':''}${data.change.toFixed(2)}% over 24h`:'24h change unavailable'],
   ['24h trading volume',dollars(data?.volume),'Selected source pool only'],
   ['Pool liquidity / TVL',dollars(data?.liquidity),'External pool · not Sonata TVL'],
   ['Token market cap',dollars(data?.marketCap),'Provider estimate · token supply value, not underlying company or fund value']
  ].map(([label,value,hint])=><div key={label}><span>{label}</span><strong>{loading&&!data?'—':value}</strong><small className={label==='Token price'?valueTone(data?.change):undefined}>{hint}</small></div>)}</div>
  {!data&&!loading&&<p>Price history unavailable until a verified source pool can be loaded.</p>}
  {data&&<><div className="sr-section-top" style={{marginTop:20}}><div><h3>Price & trading history</h3><p>{data.dex} · {asset.symbol} / USDC · fetched {new Date(data.fetchedAt).toLocaleString()}</p></div><a href={url} target="_blank" rel="noreferrer">Open full chart ↗</a></div><p style={{fontSize:13}}>Chart supplied by DEX Screener. If your browser blocks the embed, use “Open full chart” above.</p><iframe key={data.pair} title={`${asset.symbol} USDC price and volume chart from DEX Screener`} src={`${url}?embed=1&loadChartSettings=0&trades=0&info=0`} loading="eager" style={{width:'100%',height:440,border:0,borderRadius:16}}/><p style={{fontSize:13,overflowWrap:'anywhere'}}>Source: DEX Screener · deepest indexed {asset.symbol}/USDC pool at fetch time. Pool: <a href={url} target="_blank" rel="noreferrer">{data.pair}</a>. Missing provider values are shown as unavailable. If the embedded chart cannot load, open the full chart.</p></>}
 </Card>
}
