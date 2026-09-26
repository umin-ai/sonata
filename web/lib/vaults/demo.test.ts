import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialDemo,hydrateDemo,transition} from './demo.ts';
// Retain the old funded fixture solely for backward-compatibility tests.
const fixtureDemo=()=>{const s=initialDemo();s.creatorCash=50000;s.markets.room.status='active';s.markets.room.externalCapital=2500000;return s;};
const run=(s:ReturnType<typeof initialDemo>,a:Parameters<typeof transition>[1])=>transition(s,a,'test','2026-09-17T00:00:00Z');
test('deposit, fee batch, compound and full exit conserve user balances',()=>{
 let s=fixtureDemo();s=run(s,{type:'deposit',vault:'spy',amount:100000});assert.equal(s.cash,900000);
 s=run(s,{type:'trade',vault:'spy'});const earned=s.positions.spy.rewards;assert.ok(earned>0);assert.equal(s.positions.spy.earned,earned);
 s=run(s,{type:'compound',vault:'spy'});assert.equal(s.positions.spy.rewards,0);assert.equal(s.positions.spy.capital,100000+earned);
 s=run(s,{type:'withdraw',vault:'spy',amount:s.positions.spy.capital});assert.equal(s.cash,1000000+earned);assert.equal(s.positions.spy.capital,0);
 assert.throws(()=>run(s,{type:'withdraw',vault:'spy',amount:1}));assert.throws(()=>run(s,{type:'compound',vault:'spy'}));
});
test('claim does not compound and invalid amounts never change funds',()=>{
 let s=run(fixtureDemo(),{type:'deposit',vault:'nvda',amount:250000});s=run(s,{type:'trade',vault:'nvda'});const earned=s.positions.nvda.rewards;
 s=run(s,{type:'claim',vault:'nvda'});assert.equal(s.cash,750000+earned);assert.equal(s.positions.nvda.capital,250000);
 for(const amount of [0,-1,NaN,Infinity,1.5,999999999])assert.throws(()=>run(s,{type:'deposit',vault:'spy',amount}));
});
test('creator allocation remains separate, sums exactly and cannot be replayed',()=>{
 let s=run(fixtureDemo(),{type:'policy',amount:65});s=run(s,{type:'allocate'});
 assert.equal(s.cash,1000000);assert.equal(s.treasury+s.community+s.operations,50000);assert.equal(s.treasury,32500);assert.equal(s.community,10000);assert.equal(s.creatorCash,0);
 assert.throws(()=>run(s,{type:'allocate'}));assert.throws(()=>run(s,{type:'policy',amount:81}));
});

test('one trade batch pays both owners once and accounts for every fee cent',()=>{
 let s=run(fixtureDemo(),{type:'allocate'});
 s=run(s,{type:'deposit',vault:'room',amount:10000,owner:'treasury'});
 s=run(s,{type:'deposit',vault:'room',amount:10000});
 s=run(s,{type:'trade',vault:'room'});
 assert.equal(s.positions.room.earned,s.treasuryPositions.room.earned);
 assert.equal(s.fees.pool,30000);
 assert.equal(s.fees.pool,s.fees.externalLP+s.fees.protocol+s.positions.room.earned+s.treasuryPositions.room.earned);
 assert.equal(s.creatorCash,10000);assert.equal(s.fees.creator,10000);
 assert.equal(s.volume,10000000);assert.equal(s.marketVolume.room,10000000);
});

test('creator to treasury to LP fees to member claim is connected and conserves money',()=>{
 let s=fixtureDemo();
 const total=(x:typeof s)=>x.cash+x.creatorCash+x.treasury+x.community+x.operations+
  [...Object.values(x.positions),...Object.values(x.treasuryPositions)].reduce((a,p)=>a+p.capital+p.rewards,0)+
  Object.values(x.claimable).reduce((a,b)=>a+b,0)+Object.entries(x.paid).reduce((a,[id,n])=>a+(id==='you'?0:n),0)+x.fees.protocol+x.fees.externalLP;
 const starting=total(s);
 const conserved=()=>assert.equal(total(s),starting+s.fees.pool+s.fees.creator);
 s=run(s,{type:'allocate'});conserved();
 s=run(s,{type:'deposit',vault:'room',owner:'treasury',amount:30000});conserved();
 s=run(s,{type:'trade',vault:'room',owner:'treasury'});conserved();
 const earned=s.treasuryPositions.room.rewards;assert.ok(earned>0);
 s=run(s,{type:'fundRewards',vault:'room',owner:'treasury'});conserved();
 assert.equal(s.community,10000+earned);assert.equal(s.treasuryPositions.room.capital,30000);
 s=run(s,{type:'distribute'});conserved();
 assert.throws(()=>run(s,{type:'distribute'}));
 for(const recipient of ['you','builders','contributors']) {s=run(s,{type:'rewardClaim',recipient});conserved();assert.throws(()=>run(s,{type:'rewardClaim',recipient}));}
 s=run(s,{type:'withdraw',vault:'room',owner:'treasury',amount:30000});conserved();
 s=run(s,{type:'allocate'});conserved();
 assert.equal(s.creatorCash,0);assert.equal(s.treasury,36000);
});

test('treasury compounding and exits do not move personal money',()=>{
 let s=run(fixtureDemo(),{type:'allocate'});s=run(s,{type:'deposit',vault:'spy',owner:'treasury',amount:30000});
 s=run(s,{type:'trade',vault:'spy',owner:'treasury'});const fee=s.treasuryPositions.spy.rewards;
 s=run(s,{type:'compound',vault:'spy',owner:'treasury'});
 assert.equal(s.treasuryPositions.spy.capital,30000+fee);assert.equal(s.cash,1000000);
 s=run(s,{type:'withdraw',vault:'spy',owner:'treasury',amount:30000+fee});assert.equal(s.treasury,30000+fee);
 assert.throws(()=>run(s,{type:'fundRewards',vault:'spy'}));
});

test('stale pricing blocks both owners at the ledger, while allowing fixed-price exits',()=>{
 let s=run(fixtureDemo(),{type:'allocate'});s=run(s,{type:'deposit',vault:'spy',amount:10000});
 s=run(s,{type:'trade',vault:'spy'});s=run(s,{type:'price',vault:'spy'});
 for(const owner of ['investor','treasury'] as const) for(const type of ['deposit','compound','trade'] as const) assert.throws(()=>run(s,{type,vault:'spy',amount:100,owner}));
 s=run(s,{type:'withdraw',vault:'spy',amount:10000});assert.equal(s.positions.spy.capital,0);
 s=run(s,{type:'price',vault:'spy'});s=run(s,{type:'deposit',vault:'spy',amount:100});assert.equal(s.positions.spy.capital,100);
});


test('existing sessions retain money and acquire the new treasury ledgers',()=>{
 const old={version:1,cash:950000,positions:{spy:{capital:50000,rewards:12,earned:12}},entries:[],volume:10000000,creatorCash:0,treasury:32500,community:10000,operations:7500,split:65};
 const migrated=hydrateDemo(old);
 assert.equal(migrated.version,3);assert.equal(migrated.cash,950000);assert.equal(migrated.treasury,32500);assert.equal(migrated.positions.spy.rewards,12);
 assert.deepEqual(migrated.treasuryPositions,{});assert.equal(migrated.fees.pool,0);
 assert.deepEqual(hydrateDemo({...old,positions:{fake:{capital:1,rewards:0,earned:0}}}),initialDemo());
 assert.deepEqual(hydrateDemo(null),initialDemo());
});

test('fresh launch to fees to treasury to member payout is funded and traceable',()=>{
 let s=initialDemo();assert.equal(s.creatorCash,0);assert.throws(()=>run(s,{type:'allocate'}));
 const total=(x:typeof s)=>Object.values(ledgerBalances(x)).reduce((a,b)=>a+b,0);
 const conserved=()=>assert.equal(total(s),1000000+s.fees.pool+s.fees.creator);
 let i=0;const step=(a:Parameters<typeof transition>[1])=>{s=transition(s,a,`tx-${++i}`,'2026-09-18T00:00:00Z');conserved();};
 step({type:'launch',vault:'room',amount:100000,quote:'SPYx',lockDays:7,compoundPercent:50});
 assert.equal(s.cash,900000);assert.equal(s.markets.room.quote,'SPYx');
 assert.throws(()=>run(s,{type:'launch',vault:'room',amount:100000,quote:'SPYx',lockDays:7,compoundPercent:50}));
 step({type:'trade',vault:'room',amount:1000000});
 assert.equal(s.positions.room.capital,101350);assert.equal(s.positions.room.rewards,1350);assert.equal(s.creatorCash,1000);
 assert.equal(s.fees.pool,3000);assert.equal(s.fees.protocol,300);
 assert.equal(s.entries[0].movements?.reduce((n,m)=>n+m.after-m.before,0),4000);
 step({type:'allocate'});assert.deepEqual(s.entries[0].sources,['tx-2']);
 step({type:'deposit',vault:'spy',owner:'treasury',amount:600});assert.deepEqual(s.entries[0].sources,['tx-3']);
 step({type:'trade',vault:'spy',amount:100000000});
 step({type:'fundRewards',vault:'spy',owner:'treasury'});
 step({type:'distribute'});assert.deepEqual(s.entries[0].sources,['tx-3','tx-6']);
 step({type:'rewardClaim',recipient:'you'});assert.deepEqual(s.entries[0].sources,['tx-7']);
 assert.throws(()=>run(s,{type:'rewardClaim',recipient:'you'}));
});

import {availableCapital,ledgerBalances,lockedCapital} from './demo.ts';
test('seed lock restricts only its original capital, with exact release and no time-generated income',()=>{
 let s=run(initialDemo(),{type:'launch',vault:'room',amount:100000,quote:'NVDAx',lockDays:7,compoundPercent:0});
 assert.equal(lockedCapital(s,'room'),100000);assert.equal(availableCapital(s,'room'),0);
 assert.throws(()=>run(s,{type:'withdraw',vault:'room',amount:1}));
 s=run(s,{type:'deposit',vault:'room',amount:10000});assert.equal(availableCapital(s,'room'),10000);
 s=run(s,{type:'withdraw',vault:'room',amount:10000});assert.equal(availableCapital(s,'room'),0);
 s=run(s,{type:'advanceDay',amount:6});assert.equal(availableCapital(s,'room'),0);
 s=run(s,{type:'advanceDay',amount:1});assert.equal(availableCapital(s,'room'),100000);
 assert.equal(s.positions.room.earned,0);assert.equal(s.creatorCash,0);assert.equal(s.volume,0);
 s=run(s,{type:'withdraw',vault:'room',amount:100000});assert.equal(s.cash,1000000);
});

test('100% reinvestment never creates a second claim and treasury receives only its fee share',()=>{
 let s=run(initialDemo(),{type:'launch',vault:'room',amount:100000,quote:'TSLAx',lockDays:0,compoundPercent:100});
 s=run(s,{type:'trade',vault:'room',amount:1000000});assert.equal(s.positions.room.rewards,0);assert.equal(s.positions.room.capital,102700);
 assert.throws(()=>run(s,{type:'compound',vault:'room'}));assert.throws(()=>run(s,{type:'claim',vault:'room'}));
 s=run(s,{type:'allocate'});s=run(s,{type:'deposit',vault:'room',amount:600,owner:'treasury'});
 s=run(s,{type:'trade',vault:'room',amount:1000000});
 const f=s.marketFees.room;assert.equal(f.externalLP,0);assert.equal(f.pool,f.investor+f.treasury+f.protocol+f.externalLP);assert.equal(f.reinvested,f.investor+f.treasury);
 assert.equal(s.treasuryPositions.room.rewards,0);assert.ok(s.treasuryPositions.room.earned>0);
});

test('draft and invalid market operations reject without mutating the input',()=>{
 const s=initialDemo(),snapshot=structuredClone(s);
 for(const type of ['deposit','trade','compound','withdraw'] as const)assert.throws(()=>run(s,{type,vault:'room',amount:10000}));
 for(const patch of [{amount:0},{amount:NaN},{amount:1000001},{quote:'FAKE'},{lockDays:-1},{lockDays:365},{compoundPercent:49}])assert.throws(()=>run(s,{type:'launch',vault:'room',amount:10000,quote:'SPYx',lockDays:7,compoundPercent:50,...patch}));
 assert.deepEqual(s,snapshot);
 assert.deepEqual(hydrateDemo({...s,markets:null}),initialDemo());
 assert.deepEqual(hydrateDemo({...s,treasury:-1}),initialDemo());
 const restored=hydrateDemo(run(s,{type:'launch',vault:'room',amount:10000,quote:'QQQx',lockDays:30,compoundPercent:50}));
 assert.equal(restored.markets.room.status,'active');assert.equal(restored.markets.room.lockUntilDay,30);
});
