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
export function loanScenario(cash:number,collateralValue:number,apy:number,days:number,maxLtv:number,liquidationLtv:number,decline:number,options:{feeRate?:number;borrowFactor?:number;cashPrice?:number}={}){
 const feeRate=options.feeRate??0,borrowFactor=options.borrowFactor??1,cashPrice=options.cashPrice??1;
 const fee=feeRate>0?Math.max(.000001,Math.ceil(cash*feeRate*1e6)/1e6):0;
 const principal=cash+fee,interest=principal*Math.expm1(Math.log1p(apy)*days/365);
 const debt=principal+interest,stressedValue=collateralValue*(1-decline),weightedDebt=debt*cashPrice*borrowFactor;
 const limit=collateralValue*maxLtv/(cashPrice*borrowFactor*(1+feeRate));
 return {fee,principal,interest,debt,ltv:principal*cashPrice*borrowFactor/collateralValue,limit,allowed:principal*cashPrice*borrowFactor<=collateralValue*maxLtv,stressedLtv:weightedDebt/stressedValue,liquidationValue:weightedDebt/liquidationLtv,atRisk:weightedDebt/stressedValue>=liquidationLtv,buffer:1-weightedDebt/(collateralValue*liquidationLtv)};
}
