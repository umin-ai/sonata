import {z} from 'zod';
import Decimal from 'decimal.js';

// Main-market mint allowlist, verified against the official Jupiter Borrow API on 2026-09-14.
export const STOCK_MINTS:Record<string,{symbol:string;name:string}>={
 Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh:{symbol:'NVDAx',name:'NVIDIA xStock'},
 XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W:{symbol:'SPYx',name:'SP500 xStock'},
 Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ:{symbol:'QQQx',name:'Nasdaq xStock'},
};
export const DEBT_MINTS:Record<string,string>={EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:'USDC',JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD:'JupUSD'};
const uint=z.string().regex(/^\d{1,40}$/);
const key=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const token=z.object({address:key,chainId:z.literal('solana'),decimals:z.number().int().min(0).max(18)});
const vaultSchema=z.object({id:z.number().int().positive(),address:key,type:z.literal(0),supplyToken:token,borrowToken:token,
 totalBorrow:uint,borrowable:uint,minimumBorrowing:uint,borrowRate:uint,supplyRate:uint,collateralFactor:uint,liquidationThreshold:uint,liquidationPenalty:uint,borrowFee:uint,
 totalPositions:z.number().int().nonnegative(),oracle:key,oracleTimestamp:z.number().int().positive(),oracleSources:z.array(z.object({suspended:z.boolean().optional()})).min(1)});
const units=(raw:string,decimals:number)=>new Decimal(raw).div(new Decimal(10).pow(decimals)).toNumber();
export type JupiterMarket={id:number;market:'main';address:string;collateralMint:string;collateralSymbol:string;collateralName:string;debtMint:string;debtSymbol:string;
 borrowApr:number;supplyApr:number;maxLtv:number;liquidationLtv:number;liquidationPenalty:number;borrowFee:number;borrowable:number;totalBorrow:number;minimumBorrow:number;totalPositions:number;oracle:string;oracleTimestamp:number;oracleSuspended:boolean};
export function normalizeVaults(data:unknown):JupiterMarket[]{
 if(!Array.isArray(data))throw new Error('Jupiter returned an invalid vault list.');
 const seen=new Set<number>();const rows:JupiterMarket[]=[];
 for(const item of data){
  const candidate=z.object({supplyToken:z.object({address:z.string()}),borrowToken:z.object({address:z.string()})}).safeParse(item);
  if(!candidate.success)throw new Error('Jupiter returned an invalid vault entry.');
  if(!STOCK_MINTS[candidate.data.supplyToken.address]||!DEBT_MINTS[candidate.data.borrowToken.address])continue;
  const v=vaultSchema.parse(item);
  if(v.supplyToken.decimals!==8||v.borrowToken.decimals!==6||seen.has(v.id))throw new Error('Jupiter vault identifiers or decimals changed.');
  seen.add(v.id);
  const maxLtv=Number(v.collateralFactor)/1000,liquidationLtv=Number(v.liquidationThreshold)/1000;
  const borrowApr=Number(v.borrowRate)/10000,supplyApr=Number(v.supplyRate)/10000;
  const borrowFee=Number(v.borrowFee)/10000,liquidationPenalty=Number(v.liquidationPenalty)/10000;
  if(!(maxLtv>0&&maxLtv<liquidationLtv&&liquidationLtv<1&&borrowApr<=10&&supplyApr<=10&&borrowFee<1&&liquidationPenalty<1))throw new Error('Jupiter returned unsupported lending terms.');
  const stock=STOCK_MINTS[v.supplyToken.address];
  rows.push({id:v.id,market:'main',address:v.address,collateralMint:v.supplyToken.address,collateralSymbol:stock.symbol,collateralName:stock.name,debtMint:v.borrowToken.address,debtSymbol:DEBT_MINTS[v.borrowToken.address],
   borrowApr,supplyApr,maxLtv,liquidationLtv,liquidationPenalty,borrowFee,borrowable:units(v.borrowable,6),totalBorrow:units(v.totalBorrow,6),minimumBorrow:units(v.minimumBorrowing,6),totalPositions:v.totalPositions,
   oracle:v.oracle,oracleTimestamp:v.oracleTimestamp,oracleSuspended:v.oracleSources.some(s=>s.suspended===true)});
 }
 return rows.sort((a,b)=>a.collateralSymbol.localeCompare(b.collateralSymbol)||a.debtSymbol.localeCompare(b.debtSymbol));
}
export type SpotPrice={usdPrice:number;change24h:number|null;blockId:number};
export function normalizePrices(data:unknown):Record<string,SpotPrice>{
 const values=z.record(z.unknown()).parse(data),result:Record<string,SpotPrice>={};
 for(const mint of Object.keys(STOCK_MINTS)){
  if(!(mint in values))continue;
  const p=z.object({usdPrice:z.number().positive().finite(),priceChange24h:z.number().finite().optional(),blockId:z.number().int().positive()}).safeParse(values[mint]);
  if(p.success)result[mint]={usdPrice:p.data.usdPrice,change24h:p.data.priceChange24h??null,blockId:p.data.blockId};
 }
 return result;
}
// Amount fields stay as exact strings until a populated position has been reconciled with the SDK.
// This release exposes position identity and liquidation status, not unverified financial balances.
export type JupiterPosition={id:number;vaultId:number;positionMint:string;owner:string;isLiquidated:boolean;isSupplyPosition:boolean;collateralSymbol:string;debtSymbol:string};
export function normalizePositions(data:unknown,wallet:string,markets:JupiterMarket[]):JupiterPosition[]{
 if(!Array.isArray(data))throw new Error('Jupiter returned an invalid position list.');
 const rows:JupiterPosition[]=[];const seen=new Set<string>();
 for(const item of data){
  const p=z.object({id:z.number().int().positive(),vaultId:z.number().int().positive(),address:key,ownerAddress:key,isLiquidated:z.boolean(),isSupplyPosition:z.boolean()}).parse(item);
  if(p.ownerAddress!==wallet)throw new Error('Jupiter returned a position for a different wallet.');
  const market=markets.find(v=>v.id===p.vaultId);if(!market)continue;
  const identity=p.vaultId+':'+p.id;if(seen.has(identity))throw new Error('Duplicate Jupiter position.');seen.add(identity);
  rows.push({id:p.id,vaultId:p.vaultId,positionMint:p.address,owner:wallet,isLiquidated:p.isLiquidated,isSupplyPosition:p.isSupplyPosition,collateralSymbol:market.collateralSymbol,debtSymbol:market.debtSymbol});
 }
 return rows;
}
export type JupiterMarketSnapshot={network:'solana-mainnet';market:'main';fetchedAt:string;expiresAt:number;markets:JupiterMarket[];prices:Record<string,SpotPrice>;priceError:string|null;source:string};
export type JupiterPositionSnapshot={network:'solana-mainnet';market:'main';owner:string;fetchedAt:string;positions:JupiterPosition[]};
