export const vaults = [
  { id: 'spy', name: 'S&P 500', ticker: 'SPYx', subtitle: 'Broad market. Working capital.', category: 'Index', apy: 8.42, tvl: 1240000, volume: 386400, color: '#fa5373', risk: 'Moderate', description: 'A stock / stablecoin liquidity strategy with broad US market exposure. Fees are earned when traders swap through the underlying pool.' },
  { id: 'nvda', name: 'NVIDIA', ticker: 'NVDAx', subtitle: 'The compute economy.', category: 'Technology', apy: 14.68, tvl: 864200, volume: 512800, color: '#b5ed70', risk: 'Elevated', description: 'Provide liquidity for NVIDIA exposure and USDC. Higher trading activity can generate fees, while price moves change your stock and cash inventory.' },
  { id: 'qqq', name: 'Nasdaq 100', ticker: 'QQQx', subtitle: 'One position. A wider horizon.', category: 'Index', apy: 10.24, tvl: 642800, volume: 218500, color: '#8bb9ff', risk: 'Moderate', description: 'A Nasdaq-focused stock / stablecoin liquidity position. Reinvestment adds earned fees to the strategy; it does not preserve a fixed share count.' },
  { id: 'tsla', name: 'Tesla', ticker: 'TSLAx', subtitle: 'Exposure to what moves next.', category: 'Technology', apy: 18.32, tvl: 328600, volume: 294200, color: '#e3abf5', risk: 'Elevated', description: 'A more volatile single-stock liquidity strategy. Fees may not offset inventory losses during large price movements.' },
] as const;
export type Vault = typeof vaults[number];
export type Entry = { id: string; at: string; type: string; vault: string; amount: number; note: string };
export type Position = { capital: number; rewards: number; earned: number };
export type Demo = { version: 1; cash: number; positions: Record<string, Position>; entries: Entry[]; volume: number; creatorCash: number; treasury: number; community: number; operations: number; split: number; };
export const initialDemo = (): Demo => ({version:1,cash:1000000,positions:{},entries:[],volume:0,creatorCash:50000,treasury:0,community:0,operations:0,split:60});
export type Action = {type:'deposit'|'withdraw'|'compound'|'claim'|'trade'|'allocate'|'policy'; vault?: string; amount?: number};
export function transition(state: Demo, action: Action, id: string, at: string): Demo {
  const next: Demo = structuredClone(state);
  const v = vaults.find(v=>v.id === action.vault);
  const p = v ? (next.positions[v.id] ??= {capital:0,rewards:0,earned:0}) : null;
  const amount = action.amount ?? 0;
  const record = (type:string, value:number, note:string, name = v?.ticker ?? 'Creator treasury') => next.entries.unshift({id,at,type,vault:name,amount:value,note});
  if (['deposit','withdraw'].includes(action.type) && (!Number.isSafeInteger(amount) || amount<=0)) throw new Error('Enter an amount greater than zero.');
  if (action.type==='deposit' && p) {if(amount>next.cash)throw new Error('Amount exceeds your demo balance.');next.cash-=amount;p.capital+=amount;record('Deposit',amount,'Demo USDC converted into a 50 / 50 stock–cash position.');}
  else if(action.type==='withdraw' && p) {if(amount>p.capital)throw new Error('Amount exceeds your position.');p.capital-=amount;next.cash+=amount;record('Withdraw',amount,'Position redeemed into demo USDC at fixed example prices.');}
  else if(action.type==='trade' && p && v) {if(p.capital<=0)throw new Error('Deposit before simulating trading fees.');const gross=Math.floor(10000000 * 0.003 * p.capital/(v.tvl*100+p.capital));const fee=Math.floor(gross*0.1);const net=gross-fee;p.rewards+=net;p.earned+=net;next.volume+=10000000;record('Trading fees',net,`$100,000 simulated volume × 0.30% pool fee × your pool share, less 10% protocol fee (${(fee/100).toFixed(2)} demo USD).`);}
  else if((action.type==='compound'||action.type==='claim') && p) {if(p.rewards<=0)throw new Error('No fees available yet.');const r=p.rewards;p.rewards=0;if(action.type==='compound')p.capital+=r;else next.cash+=r;record(action.type==='compound'?'Compound':'Claim fees',r,action.type==='compound'?'Earned fees added to your vault position.':'Earned fees returned to demo balance.');}
  else if(action.type==='allocate') {if(next.creatorCash<=0)throw new Error('This example fee batch has already been allocated.');const total=next.creatorCash;const t=Math.floor(total*next.split/100);const c=Math.floor(total*0.2);next.treasury+=t;next.community+=c;next.operations+=total-t-c;next.creatorCash=0;record('Allocate revenue',total,`${next.split}% stock treasury · 20% community · ${80-next.split}% operations. Creator funds only.`);}
  else if(action.type==='policy') {if(!Number.isInteger(amount)||amount<0||amount>80)throw new Error('Treasury allocation must be between 0 and 80%.');next.split=amount;record('Update policy',0,`${amount}% treasury · 20% community · ${80-amount}% operations.`);}
  else throw new Error('This demo action is unavailable.');
  return next;
}
