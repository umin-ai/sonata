import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeVaults,normalizePrices,normalizePositions} from './jupiter-data.ts';
const observed=JSON.parse(readFileSync(new URL('./fixtures/jupiter-vault.json',import.meta.url),'utf8'));
const owner='ErfovAj7k8V8b8UcNvKVnLu6Pk8CYwSFMgy7kY8uwqS7';
test('observed vault preserves APR, LTV and debt units as separate scales',()=>{
 const [v]=normalizeVaults([observed]);
 assert.equal(v.id,80);assert.equal(v.market,'main');assert.equal(v.borrowApr,.0449);
 assert.equal(v.maxLtv,.65);assert.equal(v.liquidationLtv,.75);assert.equal(v.liquidationPenalty,.03);
 assert.equal(v.totalBorrow,Number(observed.totalBorrow)/1e6);
 assert.equal(v.minimumBorrow,Number(observed.minimumBorrowing)/1e6);
});
test('changed chain, decimals, duplicate identities and inverted limits fail closed',()=>{
 for(const mutate of [
  (v:any)=>{v.supplyToken.chainId='ethereum'},
  (v:any)=>{v.borrowToken.decimals=18},
  (v:any)=>{v.collateralFactor=v.liquidationThreshold},
  (v:any)=>{v.borrowRate='NaN'},
 ]){const v=structuredClone(observed);mutate(v);assert.throws(()=>normalizeVaults([v]));}
 assert.throws(()=>normalizeVaults([observed,observed]));
 const unknown=structuredClone(observed);unknown.supplyToken.address=owner;
 assert.deepEqual(normalizeVaults([unknown]),[]);
});
test('missing or invalid DEX prices never become zero or an oracle valuation',()=>{
 const mint=observed.supplyToken.address;
 assert.deepEqual(normalizePrices({}),{});
 assert.deepEqual(normalizePrices({[mint]:{usdPrice:0,blockId:100}}),{});
 const p=normalizePrices({[mint]:{usdPrice:214.22,priceChange24h:-1.75,blockId:100,stockData:{price:218.26}}});
 assert.deepEqual(p[mint],{usdPrice:214.22,change24h:-1.75,blockId:100});
});
test('position reads enforce ownership and vault identity without inventing balances',()=>{
 const markets=normalizeVaults([observed]);
 const p={id:42,vaultId:80,address:observed.address,ownerAddress:owner,isLiquidated:false,isSupplyPosition:false,supply:'123',borrow:'456'};
 const [result]=normalizePositions([p],owner,markets);
 assert.equal(result.id,42);assert.equal(result.collateralSymbol,'NVDAx');assert.equal('borrow' in result,false);
 assert.throws(()=>normalizePositions([{...p,ownerAddress:observed.address}],owner,markets));
 assert.throws(()=>normalizePositions([p,p],owner,markets));
 assert.deepEqual(normalizePositions([{...p,vaultId:999}],owner,markets),[]);
 assert.deepEqual(normalizePositions([],owner,markets),[]);
});
