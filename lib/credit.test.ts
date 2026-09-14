import test from 'node:test';
import assert from 'node:assert/strict';
import {EXAMPLE_TERMS,creditPlan,newExample,openExample,repayExample,withdrawExample,exampleDebt,advanceExample,depositExample,sellExample,ExampleSchema} from './credit.ts';

test('full example lifecycle conserves stock and pays accrued interest from cash',()=>{
 let s=openExample(newExample(),8,500,30,EXAMPLE_TERMS);
 assert.equal(s.stock,2);assert.equal(s.cash,600);assert.equal(s.loan!.collateral,8);assert.equal(exampleDebt(s),500);
 assert.throws(()=>withdrawExample(s));
 s=advanceExample(s,30);
 const owed=exampleDebt(s);assert.ok(owed>502&&owed<503);
 s=repayExample(s,100);assert.equal(exampleDebt(s),Math.round((owed-100)*1e6)/1e6);assert.equal(s.cash,500);
 const remainder=exampleDebt(s);s=repayExample(s,remainder);assert.equal(exampleDebt(s),0);
 s=withdrawExample(s);assert.equal(s.stock,10);assert.equal(s.loan,null);
 assert.ok(Math.abs(s.cash-(600-owed))<.000002);
 assert.deepEqual(s.events.map(e=>e.kind),['withdraw','repay','repay','borrow']);
 assert.equal(ExampleSchema.safeParse(s).success,true);
});
test('partial repayment settles past interest once, with future interest on the remaining debt',()=>{
 let s=openExample(newExample(),8,500,30,EXAMPLE_TERMS);s=advanceExample(s,30);
 s=repayExample(s,100);const before=exampleDebt(s);s=advanceExample(s,30);
 assert.ok(Math.abs(exampleDebt(s)-before*Math.pow(1.0508,30/365))<.000002);
 const unchanged=exampleDebt(s);assert.equal(exampleDebt(s),unchanged);
});
test('additional collateral preserves funds and debt',()=>{
 let s=openExample(newExample(),8,500,30,EXAMPLE_TERMS);s=depositExample(s,1.5);
 assert.equal(s.stock,0.5);assert.equal(s.loan!.collateral,9.5);assert.equal(s.cash,600);assert.equal(exampleDebt(s),500);
 assert.throws(()=>depositExample(s,1));
});
test('opening, cash and account constraints fail before any mutation',()=>{
 const s=newExample();assert.throws(()=>openExample(s,11,500,30,EXAMPLE_TERMS));
 assert.throws(()=>openExample(s,8,1000,30,EXAMPLE_TERMS));
 let loan=openExample(s,8,500,30,EXAMPLE_TERMS);assert.throws(()=>openExample(loan,1,10,30,EXAMPLE_TERMS));
 loan={...loan,cash:0};assert.throws(()=>repayExample(loan,1));
 assert.throws(()=>repayExample(loan,0.00000001));assert.throws(()=>advanceExample(loan,-1));
 assert.equal(s.stock,10);assert.equal(s.loan,null);
});
test('projected downside includes accrued debt and supports a non-dollar stablecoin oracle',()=>{
 const terms={...EXAMPLE_TERMS,feeRate:.01,borrowFactor:1.2,cashPrice:.98};
 const p=creditPlan(500,8,30,.3,terms);
 assert.equal(p.fee,5);
 assert.ok(Math.abs(p.ltv-505*.98*1.2/(8*218.31))<1e-12);
 assert.ok(p.stressedLtv>p.ltv/.7);
 assert.ok(p.requiredStock>0);
 const boundary=creditPlan(500,p.requiredStock,30,.3,terms);
 assert.ok(boundary.allowed);assert.ok(Math.abs(boundary.scenarioHeadroom)<.000001);
});
test('invalid scenarios and persisted state cannot manufacture valid inputs',()=>{
 assert.throws(()=>creditPlan(500,0,30,.3,EXAMPLE_TERMS));
 assert.throws(()=>creditPlan(500,8,30,1,EXAMPLE_TERMS));
 assert.throws(()=>creditPlan(NaN,8,30,.3,EXAMPLE_TERMS));
 assert.equal(ExampleSchema.safeParse({...newExample(),cash:-1}).success,false);
});
test('example sale uses the cost assumption and only available, unlocked stock',()=>{
 const s=sellExample(newExample(),500,EXAMPLE_TERMS.price);
 assert.equal(s.cash,600);assert.ok(Math.abs(s.stock+500/(218.31*.997)-10)<1e-10);
 assert.equal(s.events[0].kind,'sale');
 assert.throws(()=>sellExample(openExample(newExample(),10,500,30,EXAMPLE_TERMS),100,218.31));
});
