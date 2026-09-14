import { z } from 'zod';
import { loanScenario } from './finance.ts';

export const TermsSchema = z.object({
  price: z.number().positive(), cashPrice: z.number().positive(), apy: z.number().min(0).max(10),
  maxLtv: z.number().positive().lt(1), liquidationLtv: z.number().positive().lt(1),
  feeRate: z.number().min(0).lt(1), borrowFactor: z.number().min(1),
});
export type Terms = z.infer<typeof TermsSchema>;
export const EXAMPLE_TERMS: Terms = {price:218.31,cashPrice:1,apy:.0508,maxLtv:.55,liquidationLtv:.65,feeRate:0,borrowFactor:1};
export function creditPlan(cash:number,stock:number,days:number,decline:number,terms:Terms){
  TermsSchema.parse(terms);
  if(![cash,stock,days,decline].every(Number.isFinite)||cash<=0||stock<=0||days<0||days>365||decline<0||decline>=1)throw new Error('Enter valid amounts and a decline below 100%.');
  if(terms.maxLtv>=terms.liquidationLtv)throw new Error('Invalid collateral thresholds.');
  const value=stock*terms.price;
  const loan=loanScenario(cash,value,terms.apy,days,terms.maxLtv,terms.liquidationLtv,decline,terms);
  const factor=terms.cashPrice*terms.borrowFactor;
  const requiredStock=Math.max(loan.principal*factor/terms.maxLtv,loan.debt*factor/(terms.liquidationLtv*(1-decline)))/terms.price;
  return {...loan,collateralValue:value,liquidationPrice:loan.liquidationValue/stock,requiredStock,
    stressedPrice:terms.price*(1-decline),stressedValue:value*(1-decline),
    scenarioHeadroom:value*(1-decline)*terms.liquidationLtv-loan.debt*factor};
}

const EventSchema=z.object({id:z.number().int(),day:z.number().int().nonnegative(),kind:z.enum(['borrow','repay','deposit','withdraw','sale']),stock:z.number(),cash:z.number(),debt:z.number().nonnegative()});
export const ExampleSchema=z.object({version:z.literal(1),day:z.number().int().min(0).max(365),stock:z.number().min(0).max(10000),cash:z.number().min(0).max(10000000),
  loan:z.object({collateral:z.number().positive(),principal:z.number().nonnegative(),accruedFrom:z.number().int().nonnegative(),openedDay:z.number().int().nonnegative(),horizon:z.number().int().min(1).max(180),terms:TermsSchema}).nullable(),
  events:z.array(EventSchema).max(200)
}).superRefine((s,ctx)=>{if(s.loan&&(s.loan.accruedFrom>s.day||s.loan.openedDay>s.day))ctx.addIssue({code:'custom',message:'Invalid example clock.'})});
export type Example = z.infer<typeof ExampleSchema>;
export type ExampleEvent = Example['events'][number];
export const newExample=():Example=>({version:1,day:0,stock:10,cash:100,loan:null,events:[]});
const roundCash=(v:number)=>Math.round(v*1e6)/1e6;
export function exampleDebt(s:Example){return s.loan?Math.ceil(s.loan.principal*Math.pow(1+s.loan.terms.apy,(s.day-s.loan.accruedFrom)/365)*1e6)/1e6:0;}
function event(s:Example,kind:ExampleEvent['kind'],stock:number,cash:number):Example{
  return {...s,events:[{id:(s.events[0]?.id??0)+1,day:s.day,kind,stock,cash,debt:exampleDebt(s)},...s.events].slice(0,200)};
}
export function openExample(s:Example,stock:number,cash:number,horizon:number,terms:Terms):Example{
  if(s.loan)throw new Error('Repay and release your current collateral before opening another example loan.');
  const plan=creditPlan(cash,stock,horizon,0,terms);
  if(stock>s.stock||!plan.allowed)throw new Error('This loan exceeds the available collateral or opening limit.');
  const next={...s,stock:s.stock-stock,cash:roundCash(s.cash+cash),loan:{collateral:stock,principal:plan.principal,accruedFrom:s.day,openedDay:s.day,horizon,terms:{...terms}}};
  return event(next,'borrow',-stock,cash);
}
export function repayExample(s:Example,amount:number):Example{
  const debt=exampleDebt(s);
  if(!s.loan||debt<=0||!Number.isFinite(amount)||amount<=0)throw new Error('Enter a repayment amount.');
  const payment=roundCash(Math.min(amount,debt));
  if(payment<=0)throw new Error('Repayment must be at least one USDC base unit.');
  if(payment>s.cash)throw new Error('Not enough example USDC to make this repayment.');
  return event({...s,cash:roundCash(s.cash-payment),loan:{...s.loan,principal:roundCash(debt-payment),accruedFrom:s.day}},'repay',0,-payment);
}
export function depositExample(s:Example,stock:number):Example{
  if(!s.loan||!Number.isFinite(stock)||stock<=0||stock>s.stock)throw new Error('Not enough available example stock.');
  return event({...s,stock:s.stock-stock,loan:{...s.loan,collateral:s.loan.collateral+stock}},'deposit',-stock,0);
}
export function withdrawExample(s:Example):Example{
  if(!s.loan||exampleDebt(s)>0)throw new Error('Repay the example loan before releasing all collateral.');
  const stock=s.loan.collateral;
  return event({...s,stock:s.stock+stock,loan:null},'withdraw',stock,0);
}
export function advanceExample(s:Example,days:number):Example{
  if(!Number.isInteger(days)||days<=0||s.day+days>365)throw new Error('Example time must stay within one year.');
  return {...s,day:s.day+days};
}
export function sellExample(s:Example,cash:number,price:number):Example{
  if(!Number.isFinite(cash)||cash<=0||!Number.isFinite(price)||price<=0)throw new Error('Enter valid sale inputs.');
  const stock=cash/(price*(1-.003));
  if(stock>s.stock)throw new Error('Not enough available example stock.');
  return event({...s,stock:s.stock-stock,cash:roundCash(s.cash+cash)},'sale',-stock,cash);
}
