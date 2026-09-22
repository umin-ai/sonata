// Fixed-price, full-range scenario model. All amounts are demo USD cents.
export type ForecastInput = {capital:number;otherCapital:number;dailyVolume:number;days:number;compoundPercent:number;dailyCost:number};
export function forecast(input:ForecastInput){
 const {capital,otherCapital,dailyVolume,days,compoundPercent,dailyCost}=input;
 if(![capital,otherCapital,dailyVolume,dailyCost].every(n=>Number.isSafeInteger(n)&&n>=0)||capital<=0||!Number.isInteger(days)||days<1||days>365||![0,50,100].includes(compoundPercent))throw new Error('Enter valid scenario assumptions.');
 let position=capital,claimable=0,gross=0,protocol=0,cost=0;
 const points=[{day:0,value:capital}];
 for(let day=1;day<=days;day++){
  const fee=Math.floor(Math.floor(dailyVolume*30/10000)*position/(position+otherCapital));
  const charge=Math.floor(fee/10),paidCost=Math.min(dailyCost,position+claimable+fee-charge),net=fee-charge-paidCost;
  gross+=fee;protocol+=charge;cost+=paidCost;
  if(net>=0){const reinvest=Math.floor(net*compoundPercent/100);position+=reinvest;claimable+=net-reinvest;}
  else {const fromCash=Math.min(claimable,-net);claimable-=fromCash;position=Math.max(0,position+net+fromCash);}
  points.push({day,value:position+claimable});
  if(position===0)break;
 }
 return {position,claimable,gross,protocol,cost,net:position+claimable-capital,points};
}
