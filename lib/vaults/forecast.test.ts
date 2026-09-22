import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forecast} from './forecast.ts';
const input={capital:100000,otherCapital:0,dailyVolume:1000000,days:30,compoundPercent:50,dailyCost:10};
test('forecast has an independently calculable fixed-pool result and reconciles its components',()=>{
 const f=forecast(input);
 assert.equal(f.gross,90000);assert.equal(f.protocol,9000);assert.equal(f.cost,300);assert.equal(f.net,80700);
 assert.equal(f.position+f.claimable,input.capital+f.net);assert.equal(f.points.length,31);
});
test('zero activity produces no return and costs can exhaust capital without a negative balance',()=>{
 const zero=forecast({...input,dailyVolume:0,dailyCost:0});assert.equal(zero.net,0);
 const cost=forecast({...input,dailyVolume:0,dailyCost:10});assert.equal(cost.net,-300);
 const exhausted=forecast({...input,dailyVolume:0,dailyCost:200000});assert.equal(exhausted.position,0);assert.equal(exhausted.claimable,0);assert.equal(exhausted.net,-input.capital);assert.equal(exhausted.cost,input.capital);assert.equal(exhausted.net,exhausted.gross-exhausted.protocol-exhausted.cost);
});
test('reinvestment changes fee participation while payouts remain part of total value',()=>{
 const base={...input,otherCapital:100000};
 const claim=forecast({...base,compoundPercent:0}),compound=forecast({...base,compoundPercent:100});
 assert.equal(claim.position,input.capital);assert.equal(compound.claimable,0);assert.ok(compound.net>claim.net);
 assert.throws(()=>forecast({...input,capital:NaN}));assert.throws(()=>forecast({...input,days:0}));
});
