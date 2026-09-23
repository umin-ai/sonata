"use client";
import {useEffect} from 'react';
import {RefreshCw,ShieldCheck} from 'lucide-react';
import {TokenName} from './token-identity';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {isDeployableQuote} from '@/lib/treasury/quote-assets';
import {OPEN_USD,GRADUATION_USD,usdToQuote,formatUsd,formatPriceTime,type StockPrice} from '@/lib/pricing/stock-price';
// A dollar target converted to quote units at the Solana market price. The converted
// initial/target are what the on-chain config uses; the snapshot records the
// price that produced them and does not move afterwards.
export type Pricing={source:'pyth'|'jupiter';openUsd:number;targetUsd:number;price:number;confidenceRatio:number;publishTimeMs:number;label:string;live:boolean;feed:string};
// floor: half of net fees becomes a Stock Floor that holders redeem by burning; fixed at creation.
export type LaunchSettings={quote:string;initial:number;target:number;fee:number;rewards:string;floor:boolean;pricing?:Pricing};
export type PythState=
 |{status:'loading'}
 |{status:'unconfigured'}
 |{status:'error';message:string}
 |{status:'unusable';message:string;data:StockPrice}
 |{status:'ok';data:StockPrice;label:string;live:boolean;confidenceRatio:number;guard?:{feed:string;price:number;divergence:number}};
export const initialSettings:LaunchSettings={quote:'mSPY',initial:2,target:12,fee:100,rewards:'treasury',floor:true};
// Every curve and fee combination now deploys as its own DBC config. What still
// gates a launch is a quote mint that exists onchain and a reward policy the
// protocol actually enforces; holder and liquidity policies remain proposals.
export function canDeploy(s:LaunchSettings){return isDeployableQuote(s.quote)&&s.rewards==='treasury'&&Number.isFinite(s.initial)&&Number.isFinite(s.target)&&s.target>s.initial&&[25,50,100,200,300].includes(s.fee);}
export function priceLaunch(value:LaunchSettings,targetUsd:number,pyth:Extract<PythState,{status:'ok'}>):LaunchSettings{
 const {data}=pyth;
 return {...value,initial:usdToQuote(OPEN_USD,data.price),target:usdToQuote(targetUsd,data.price),pricing:{source:data.source,openUsd:OPEN_USD,targetUsd,price:data.price,confidenceRatio:pyth.confidenceRatio,publishTimeMs:data.publishTimeMs,label:pyth.label,live:pyth.live,feed:data.feed}};
}
const GRADUATION_LABELS=['Quick','Standard','Deep'];
export function LaunchSettingsStep({step,value,onChange,price,pyth,onRefreshPrice}:{step:number;value:LaunchSettings;onChange:(s:LaunchSettings)=>void;price:number|null;pyth:PythState;onRefreshPrice:()=>void}){
 const usd=(amount:number)=>price===null?'USD unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(amount*price);
 const update=(v:Partial<LaunchSettings>)=>onChange({...value,...v});
 // Price the curve from each newly fetched Pyth price: the default target on
 // first arrival, then the creator's chosen target when they refresh.
 const fetched=pyth.status==='ok'?pyth.data.fetchedAt:null;
 useEffect(()=>{
  if(step!==2||pyth.status!=='ok')return;
  if(value.pricing&&value.pricing.publishTimeMs===pyth.data.publishTimeMs&&value.pricing.price===pyth.data.price)return;
  onChange(priceLaunch(value,value.pricing?.targetUsd??GRADUATION_USD[0],pyth));
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[step,fetched]);
 if(step===1)return <><p className="sr-note">Choose the stock token your community token trades against. Trading fees are collected in this asset.</p><div className="launch-options">{[['mSPY','S&P 500'],['mNVDA','NVIDIA'],['mQQQ','Nasdaq 100'],['mTSLA','Tesla']].map(([symbol,name])=><button type="button" key={symbol} aria-pressed={value.quote===symbol} onClick={()=>update({quote:symbol,...(symbol!==value.quote?{initial:2,target:12,pricing:undefined}:{})})}><TokenName symbol={symbol} size={32}/><span>{name}</span><small>{isDeployableQuote(symbol)?'Devnet launch available':'No Devnet mint yet'}</small></button>)}</div></>;
 const feeChoices=<fieldset><legend>Trading fee</legend><div className="curve-presets">{[[100,'Lower fee'],[200,'2× fee'],[300,'3× fee']].map(([fee,label])=><button type="button" key={fee} aria-pressed={value.fee===fee} onClick={()=>update({fee:Number(fee)})}><strong>{Number(fee)/100}%</strong><span>{label}</span><span className="preset-check" aria-hidden="true">{value.fee===fee?'✓':'○'}</span></button>)}</div></fieldset>;
 const route=<div className="curve-route"><span>Bonding curve</span><span aria-hidden="true">→</span><strong>DAMM v2</strong><span>Locked LP</span></div>;
 if(step===2&&(pyth.status==='ok'||value.pricing)){
  const p=value.pricing;
  const livePrice=pyth.status==='ok'?pyth:null;
  return <div className="curve-choices">
   <div className="pyth-price" data-live={p?.live?'true':'false'}>
    <div><span>{value.quote.slice(1)} price</span><strong>{p?formatUsd(p.price):'—'}</strong><small>{p?`${p.source==='pyth'?'Pyth':'Jupiter'} · ${p.label} · ${formatPriceTime(p.publishTimeMs)} · ±${(p.confidenceRatio*100).toFixed(2)}%`:'Loading price…'}</small></div>
    <button type="button" className="pyth-refresh" onClick={onRefreshPrice} aria-label="Refresh price"><RefreshCw size={15}/>Refresh</button>
   </div>
   {!livePrice&&pyth.status!=='loading'&&<p className="sr-note" role="status">Could not refresh the price{pyth.status==='error'||pyth.status==='unusable'?`: ${pyth.message}`:''}. The targets below stay at the price shown.</p>}
   {p&&p.source==='pyth'&&!p.live&&<p className="sr-note" role="status">The US market is closed, so this is the last traded price, not a live one.</p>}{p&&p.source==='jupiter'&&<p className="sr-note">Priced from {value.quote.slice(1)}x, the real tokenized stock, across Solana markets via Jupiter. It trades around the clock, so outside US market hours this reflects Solana trading rather than the stock exchange.</p>}{livePrice?.guard&&<p className="sr-note">Checked against Pyth ({livePrice.guard.feed}): {formatUsd(livePrice.guard.price)}, {(livePrice.guard.divergence*100).toFixed(2)}% apart. Pyth guards the price but does not set it; a gap above 1% would block the launch.</p>}
   <p className="sr-note">Opens at <strong>{formatUsd(OPEN_USD)}</strong> market cap. Choose where it graduates and the trading fee.</p>
   <fieldset><legend>Graduation market cap</legend><div className="curve-presets">{GRADUATION_USD.map((target,i)=><button type="button" key={target} disabled={!livePrice} aria-pressed={p?.targetUsd===target} onClick={()=>livePrice&&onChange(priceLaunch(value,target,livePrice))}><strong>{formatUsd(target)}</strong><small>{p?`≈ ${usdToQuote(target,p.price).toLocaleString(undefined,{maximumFractionDigits:2})} ${value.quote}`:value.quote}</small><span>{GRADUATION_LABELS[i]}</span><span className="preset-check" aria-hidden="true">{p?.targetUsd===target?'✓':'○'}</span></button>)}</div></fieldset>
   {feeChoices}{route}
   <p className="sr-note">Targets are set in US dollars and converted to {value.quote} at the price above when you choose them. The converted amounts are what the on-chain curve uses; they do not change with the price afterwards. Mock tokens have no monetary value.</p>
   <details className="launch-disclosure"><summary>Liquidity settings</summary><p className="sr-note">Opening market cap fixed at {formatUsd(OPEN_USD)}{p?` (${value.initial} ${value.quote} at the converted price)`:''}. 100% of partner LP is permanently locked after migration.</p></details>
  </div>;
 }
 if(step===2){
  const why=pyth.status==='unconfigured'?'Dollar targets are unavailable, so these targets are set in mSPY.':pyth.status==='loading'?'Loading the stock price…':pyth.status==='error'||pyth.status==='unusable'?`Dollar targets are unavailable: ${pyth.message} These targets are set in mSPY.`:'';
  return <div className="curve-choices">{why&&<p className="sr-note" role="status">{why}</p>}<p className="sr-note">Opens at <strong>{usd(2)}</strong> estimated market cap. Choose the graduation target and trading fee.</p><fieldset><legend>Graduation market cap</legend><div className="curve-presets">{[[8,'Lower target'],[12,'Default'],[18,'Higher target']].map(([target,label])=><button type="button" key={target} aria-pressed={value.target===target} onClick={()=>update({initial:2,target:Number(target),pricing:undefined})}><strong>{usd(Number(target))}</strong><small>{target} {value.quote} · market cap</small><span>{label}</span><span className="preset-check" aria-hidden="true">{value.target===target?'✓':'○'}</span></button>)}</div></fieldset>{feeChoices}{route}<p className="sr-note">USD estimates use the corresponding mainnet stock-token price. Mock tokens have no monetary value. The quote-token target stays fixed; its USD estimate moves with price.</p><details className="launch-disclosure"><summary>Liquidity settings</summary><p className="sr-note">Fixed starting market cap of 2 quote tokens. 100% of partner LP is permanently locked after migration. These presets do not change the fee schedule or LP allocation.</p></details></div>;
 }
 return <><div className="floor-switch"><div><Label htmlFor="stock-floor"><ShieldCheck size={16}/> Stock Floor</Label><p className="sr-note">Half of net trading fees builds a floor. Any holder can burn their tokens for a share of it, paid in {value.quote}. You can never withdraw it. Only set at creation.</p></div><Switch id="stock-floor" checked={value.floor&&value.rewards==='treasury'} disabled={value.rewards!=='treasury'} onCheckedChange={(floor:boolean)=>update({floor})} aria-label="Stock Floor"/></div><p className="sr-note">Choose how the collected creator revenue should be used. This does not change the protocol’s own fee deductions.</p><div className="launch-options rewards-options">{[['treasury','Fee split',value.floor?'50% to the fixed recipient; 50% builds the Stock Floor for holders.':'50% to the fixed recipient; 50% retained in the creator treasury, which you can withdraw.','Available now'],['holders','Holder rewards',`Distribute a share of ${value.quote} fees to eligible token holders.`,'Not at launch · enable from Rewards afterwards'],['liquidity','Liquidity','Allocate collected fees to a liquidity position.','Preview · launch integration pending']].map(([id,title,copy,status])=><button type="button" key={id} aria-pressed={value.rewards===id} onClick={()=>update({rewards:id})}><strong>{title}</strong><span>{copy}</span><small>{status}</small></button>)}</div></>;
}
