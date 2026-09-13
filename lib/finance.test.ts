import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveMultiplier,rawFromDisplay,displayFromRaw,loanScenario,validPositive} from './finance.ts';
test('scheduled stock multiplier activates at its effective timestamp',()=>{const s={multiplier:'1.01',newMultiplier:'4.04',newMultiplierEffectiveTimestamp:100};assert.equal(effectiveMultiplier(s,99),1.01);assert.equal(effectiveMultiplier(s,100),4.04);assert.throws(()=>effectiveMultiplier({multiplier:'NaN'},100));});
test('display to raw truncates without overspending a fractional holding',()=>{for(const m of [1,1.001701196801074,4.04]){const raw=rawFromDisplay(10.1234,8,m);assert.ok(Number.isSafeInteger(raw));assert.ok(displayFromRaw(raw,8,m)<=10.1234+1e-12);assert.ok(10.1234-displayFromRaw(raw,8,m)<m/1e8+1e-12);}});
test('APY compounds to the given annual return; debt rises with time',()=>{assert.ok(Math.abs(loanScenario(500,2000,.05,365,.55,.65,0).interest-25)<1e-9);const a=loanScenario(500,2000,.05,30,.55,.65,0),b=loanScenario(500,2000,.05,90,.55,.65,0);assert.ok(b.debt>a.debt);});
test('borrowing and liquidation are separate boundaries',()=>{assert.equal(loanScenario(1100,2000,0,30,.55,.65,0).allowed,true);assert.equal(loanScenario(1101,2000,0,30,.55,.65,0).allowed,false);assert.equal(loanScenario(1000,2000,0,30,.55,.65,.3).atRisk,true);assert.equal(loanScenario(1000,2000,0,30,.55,.65,0).atRisk,false);});
test('invalid public inputs fail',()=>{for(const n of [NaN,Infinity,-1,0,100001])assert.equal(validPositive(n,100000),false);assert.equal(validPositive(500,100000),true)});
