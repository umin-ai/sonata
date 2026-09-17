import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialDemo,transition} from './demo.ts';
const run=(s:ReturnType<typeof initialDemo>,a:Parameters<typeof transition>[1])=>transition(s,a,'test','2026-09-17T00:00:00Z');
test('deposit, fee batch, compound and full exit conserve user balances',()=>{
 let s=initialDemo();s=run(s,{type:'deposit',vault:'spy',amount:100000});assert.equal(s.cash,900000);
 s=run(s,{type:'trade',vault:'spy'});const earned=s.positions.spy.rewards;assert.ok(earned>0);assert.equal(s.positions.spy.earned,earned);
 s=run(s,{type:'compound',vault:'spy'});assert.equal(s.positions.spy.rewards,0);assert.equal(s.positions.spy.capital,100000+earned);
 s=run(s,{type:'withdraw',vault:'spy',amount:s.positions.spy.capital});assert.equal(s.cash,1000000+earned);assert.equal(s.positions.spy.capital,0);
 assert.throws(()=>run(s,{type:'withdraw',vault:'spy',amount:1}));assert.throws(()=>run(s,{type:'compound',vault:'spy'}));
});
test('claim does not compound and invalid amounts never change funds',()=>{
 let s=run(initialDemo(),{type:'deposit',vault:'nvda',amount:250000});s=run(s,{type:'trade',vault:'nvda'});const earned=s.positions.nvda.rewards;
 s=run(s,{type:'claim',vault:'nvda'});assert.equal(s.cash,750000+earned);assert.equal(s.positions.nvda.capital,250000);
 for(const amount of [0,-1,NaN,Infinity,1.5,999999999])assert.throws(()=>run(s,{type:'deposit',vault:'spy',amount}));
});
test('creator allocation remains separate, sums exactly and cannot be replayed',()=>{
 let s=run(initialDemo(),{type:'policy',amount:65});s=run(s,{type:'allocate'});
 assert.equal(s.cash,1000000);assert.equal(s.treasury+s.community+s.operations,50000);assert.equal(s.treasury,32500);assert.equal(s.community,10000);assert.equal(s.creatorCash,0);
 assert.throws(()=>run(s,{type:'allocate'}));assert.throws(()=>run(s,{type:'policy',amount:81}));
});
