import {normalizeVaults,normalizePrices,normalizePositions,STOCK_MINTS} from '../jupiter-data';
import type {JupiterMarketSnapshot,JupiterPositionSnapshot} from '../jupiter-data';
import {walletAddress} from './chain';
const API='https://api.jup.ag';
async function read(path:string):Promise<unknown>{
 const response=await fetch(API+path,{headers:process.env.JUPITER_API_KEY?{'x-api-key':process.env.JUPITER_API_KEY}:{},signal:AbortSignal.timeout(15000),cache:'no-store'});
 if(response.status===401||response.status===403)throw new Error('Jupiter data access is unavailable. A server API key may be required.');
 if(response.status===429)throw new Error('Jupiter rate limit reached. Please refresh later.');
 if(!response.ok)throw new Error('Jupiter could not complete this read ('+response.status+').');
 return response.json();
}
let cached:JupiterMarketSnapshot|null=null,pending:Promise<JupiterMarketSnapshot>|null=null;
export async function jupiterMarkets():Promise<JupiterMarketSnapshot>{
 if(cached&&Date.now()<Date.parse(cached.fetchedAt)+15000)return cached;
 if(pending)return pending;
 pending=(async()=>{
  const fetchedAt=new Date().toISOString();
  const [vaults,prices]=await Promise.allSettled([read('/lend/v1/borrow/vaults?market=main'),read('/price/v3?ids='+Object.keys(STOCK_MINTS).join(','))]);
  if(vaults.status==='rejected')throw vaults.reason;
  let normalizedPrices={};let priceError:string|null=null;
  if(prices.status==='fulfilled'){try{normalizedPrices=normalizePrices(prices.value)}catch{priceError='Spot prices are unavailable.'}}else priceError='Spot prices are unavailable. Lending terms remain available.';
  const result:JupiterMarketSnapshot={network:'solana-mainnet',market:'main',fetchedAt,expiresAt:Date.parse(fetchedAt)+45000,markets:normalizeVaults(vaults.value),prices:normalizedPrices,priceError,source:API+'/lend/v1/borrow/vaults?market=main'};
  cached=result;return result;
 })().finally(()=>{pending=null});
 return pending;
}
export async function jupiterPositions(input:string):Promise<JupiterPositionSnapshot>{
 const owner=walletAddress(input);
 const [data,snapshot]=await Promise.all([read('/lend/v1/borrow/positions?market=main&users='+encodeURIComponent(owner)),jupiterMarkets()]);
 return {network:'solana-mainnet',market:'main',owner,fetchedAt:new Date().toISOString(),positions:normalizePositions(data,owner,snapshot.markets)};
}
