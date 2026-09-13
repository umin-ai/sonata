export const NVDA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
export function validPositive(value:number,max:number){return Number.isFinite(value)&&value>0&&value<=max;}
export function effectiveMultiplier(state:{multiplier:string;newMultiplier?:string;newMultiplierEffectiveTimestamp?:number},nowSeconds:number){
 const value=Number(state.newMultiplier && state.newMultiplierEffectiveTimestamp!==undefined && nowSeconds>=state.newMultiplierEffectiveTimestamp ? state.newMultiplier:state.multiplier);
 if(!Number.isFinite(value)||value<=0)throw new Error('Invalid stock balance multiplier');return value;
}
export function rawFromDisplay(display:number,decimals:number,multiplier:number){return Math.floor(display/multiplier*10**decimals);}
export function displayFromRaw(raw:number,decimals:number,multiplier:number){return raw/10**decimals*multiplier;}
export function loanScenario(cash:number,collateralValue:number,apy:number,days:number,maxLtv:number,liquidationLtv:number,decline:number){
 const interest=cash*Math.expm1(Math.log1p(apy)*days/365);
 const debt=cash+interest;const stressedValue=collateralValue*(1-decline);
 return {interest,debt,ltv:cash/collateralValue,limit:collateralValue*maxLtv,allowed:cash<=collateralValue*maxLtv,stressedLtv:debt/stressedValue,liquidationValue:debt/liquidationLtv,atRisk:debt/stressedValue>=liquidationLtv};
}
