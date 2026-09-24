import {isDeployableQuote} from '@/lib/treasury/quote-assets';
import {OPEN_USD,usdToQuote,type StockPrice} from '@/lib/pricing/stock-price';
import type {CurveOptions} from '@/lib/treasury/dbc-preview';
// A dollar target converted to quote units at the Solana market price. The converted
// initial/target are what the on-chain config uses; the snapshot records the
// price that produced them and does not move afterwards.
export type Pricing={source:'pyth'|'jupiter';openUsd:number;targetUsd:number;price:number;confidenceRatio:number;publishTimeMs:number;label:string;live:boolean;feed:string};
// floor: half of net fees becomes a Stock Floor that holders redeem by burning; fixed at creation.
// devBuy: optional first buy in quote tokens, made in the same transaction that creates the pool.
// reward: the creator's share goes to holders instead (paid out by Sonata's payout bot).
// shape, volatility, airdrop: the curve options (see CurveOptions in lib/treasury/dbc-preview.ts).
export type LaunchSettings={quote:string;initial:number;target:number;fee:number;rewards:string;floor:boolean;reward?:boolean;devBuy?:number;pricing?:Pricing}&CurveOptions;
export type PythState=
 |{status:'loading'}
 |{status:'unconfigured'}
 |{status:'error';message:string}
 |{status:'unusable';message:string;data:StockPrice}
 |{status:'ok';data:StockPrice;label:string;live:boolean;confidenceRatio:number;guard?:{feed:string;price:number;divergence:number}};
export const initialSettings:LaunchSettings={quote:'mSPY',initial:2,target:12,fee:125,rewards:'treasury',floor:false};
// Every curve and fee combination now deploys as its own DBC config. What still
// gates a launch is a quote mint that exists onchain and a reward policy the
// protocol actually enforces; holder and liquidity policies remain proposals.
export function canDeploy(s:LaunchSettings){return isDeployableQuote(s.quote)&&s.rewards==='treasury'&&Number.isFinite(s.initial)&&Number.isFinite(s.target)&&s.target>s.initial&&[25,50,100,125,200,300].includes(s.fee);}
export function priceLaunch(value:LaunchSettings,targetUsd:number,pyth:Extract<PythState,{status:'ok'}>):LaunchSettings{
 const {data}=pyth;
 return {...value,initial:usdToQuote(OPEN_USD,data.price),target:usdToQuote(targetUsd,data.price),pricing:{source:data.source,openUsd:OPEN_USD,targetUsd,price:data.price,confidenceRatio:pyth.confidenceRatio,publishTimeMs:data.publishTimeMs,label:pyth.label,live:pyth.live,feed:data.feed}};
}
