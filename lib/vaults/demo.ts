export const vaults = [
// No apy or volume field. These are simulation fixtures, and a yield or volume
// number here would be invented, not measured. Only publish a rate that comes
// from a real pool. `tvl` remains solely as the seed for simulated capital.
  { id: 'spy', name: 'S&P 500', ticker: 'SPYx', quote: 'USDC', subtitle: 'Broad market. Working capital.', category: 'Index', tvl: 1240000, color: '#fa5373', risk: 'Moderate', description: 'A stock / stablecoin liquidity strategy with broad US market exposure. Fees are earned when traders swap through the underlying pool.' },
  { id: 'nvda', name: 'NVIDIA', ticker: 'NVDAx', quote: 'USDC', subtitle: 'The compute economy.', category: 'Technology', tvl: 864200, color: '#b5ed70', risk: 'Elevated', description: 'Provide liquidity for NVIDIA exposure and USDC. Higher trading activity can generate fees, while price moves change your stock and cash inventory.' },
  { id: 'qqq', name: 'Nasdaq 100', ticker: 'QQQx', quote: 'USDC', subtitle: 'One position. A wider horizon.', category: 'Index', tvl: 642800, color: '#8bb9ff', risk: 'Moderate', description: 'A Nasdaq-focused stock / stablecoin liquidity position. Reinvestment adds earned fees to the strategy; it does not preserve a fixed share count.' },
  { id: 'tsla', name: 'Tesla', ticker: 'TSLAx', quote: 'USDC', subtitle: 'Exposure to what moves next.', category: 'Technology', tvl: 328600, color: '#e3abf5', risk: 'Elevated', description: 'A more volatile single-stock liquidity strategy. Fees may not offset inventory losses during large price movements.' },
  { id: 'room', name: 'ROOM community', ticker: 'ROOM', quote: 'NVDAx', subtitle: 'Community activity. Visible capital.', category: 'Community', tvl: 25000, color: '#c4a2ff', risk: 'Speculative', description: 'A fictional ROOM / NVDAx market illustrating existing meme-and-stock pair mechanics. Both assets can fall. ROOM is not backed by NVIDIA shares, and fees do not guarantee a positive return.' },
] as const;
export type Vault = Omit<typeof vaults[number], 'quote' | 'tvl'> & {quote:string;tvl:number};
export const pairName = (v: Vault) => `${v.ticker} / ${v.quote}`;
export type Movement = {account:string;before:number;after:number};
export type Entry = { id: string; at: string; type: string; vault: string; amount: number; note: string; marketId?:string; owner?:string; day?:number; movements?:Movement[]; sources?:string[] };
export type MarketSetup = {status:'draft'|'active'; quote:string; compoundPercent:number; seed:number; lockUntilDay:number; createdBy?:string; externalCapital:number};
export type FeeBreakdown = {pool:number;externalLP:number;protocol:number;investor:number;treasury:number;creator:number;reinvested:number};
export type Position = { capital: number; rewards: number; earned: number };
export const recipients = [{id:'you',name:'You · demo member',weight:50},{id:'builders',name:'Builder group',weight:30},{id:'contributors',name:'Contributor group',weight:20}] as const;
export type Demo = {
 version: 3; day:number; markets:Record<string,MarketSetup>; marketFees:Record<string,FeeBreakdown>; sources:Record<string,string[]>; cash: number; positions: Record<string, Position>; entries: Entry[];
 volume: number; creatorCash: number; treasury: number; community: number; operations: number; split: number;
 treasuryPositions: Record<string, Position>; marketVolume: Record<string, number>; staleMarkets: Record<string, boolean>;
 claimable: Record<string, number>; paid: Record<string, number>;
 fees: {pool:number; externalLP:number; protocol:number; creator:number};
};
const emptyPosition = (): Position => ({capital:0,rewards:0,earned:0});
export const initialDemo = (): Demo => ({version:3,day:0,markets:defaultMarkets(),marketFees:{},sources:{},cash:1000000,positions:{},entries:[],volume:0,creatorCash:0,treasury:0,community:0,operations:0,split:60,treasuryPositions:{},marketVolume:{},staleMarkets:{},claimable:{},paid:{},fees:{pool:0,externalLP:0,protocol:0,creator:0}});
export const defaultMarkets = ():Record<string,MarketSetup> => Object.fromEntries(vaults.map(v=>[v.id,{status:v.id==='room'?'draft':'active',quote:v.quote,compoundPercent:0,seed:0,lockUntilDay:0,externalCapital:v.id==='room'?0:v.tvl*100}]));
export function marketVaults(state:Demo):Vault[] {return vaults.map(v=>({...v,quote:state.markets[v.id].quote,tvl:state.markets[v.id].externalCapital/100}));}
export function lockedCapital(state:Demo,id:string):number {const m=state.markets[id];return m&&state.day<m.lockUntilDay?m.seed:0;}
export function availableCapital(state:Demo,id:string,owner='investor'):number {return Math.max(0,((owner==='treasury'?state.treasuryPositions:state.positions)[id]?.capital??0)-(owner==='investor'?lockedCapital(state,id):0));}
const nonnegative=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
// Old balances retain their historical fixture origin. New sessions start with no creator revenue.
export function hydrateDemo(value: unknown): Demo {
 try {
  if(!value || typeof value !== 'object') return initialDemo();
  const s=value as Demo;
  if(![1,2,3].includes(s.version) || !nonnegative(s.cash) || !s.positions || !Array.isArray(s.entries)) return initialDemo();
  const next={...initialDemo(),...s,version:3 as const};
  if(s.version!==3){next.markets=defaultMarkets();next.markets.room={...next.markets.room,status:'active',externalCapital:2500000};next.day=0;next.marketFees={};next.sources={};}
  if(!['cash','creatorCash','treasury','community','operations','volume','day'].every(k=>nonnegative(next[k as keyof Demo])) || !Number.isInteger(next.split)||next.split<0||next.split>80) return initialDemo();
  for(const positions of [next.positions,next.treasuryPositions]) for(const [id,p] of Object.entries(positions)) {
   if(!vaults.some(v=>v.id===id) || ![p.capital,p.rewards,p.earned].every(nonnegative)) return initialDemo();
  }
  for(const v of vaults){const m=next.markets[v.id];if(!m||!['draft','active'].includes(m.status)||![0,50,100].includes(m.compoundPercent)||![m.seed,m.lockUntilDay,m.externalCapital].every(nonnegative)||!['USDC','SPYx','NVDAx','QQQx','TSLAx'].includes(m.quote))return initialDemo();}
  for(const ledger of [next.claimable,next.paid,next.fees,next.marketVolume]) if(!Object.values(ledger).every(nonnegative))return initialDemo();
  return next;
 } catch {return initialDemo();}
}
export function ledgerBalances(s:Demo):Record<string,number> {
 const result:Record<string,number>={'Personal wallet':s.cash,'Creator revenue':s.creatorCash,'Treasury cash':s.treasury,'Reward reserve':s.community,'Operations':s.operations,'Protocol fees':s.fees.protocol,'External LP fees':s.fees.externalLP};
 for(const [owner,positions] of [['Personal',s.positions],['Treasury',s.treasuryPositions]] as const)for(const [id,p]of Object.entries(positions)){result[`${owner} / ${id} / capital`]=p.capital;result[`${owner} / ${id} / claimable fees`]=p.rewards;}
 for(const [id,n]of Object.entries(s.claimable))result[`Member / ${id} / claimable`]=n;
 for(const [id,n]of Object.entries(s.paid))if(id!=='you')result[`Member / ${id} / paid`]=n;
 return result;
}
export type Action = {type:'deposit'|'withdraw'|'compound'|'claim'|'trade'|'allocate'|'policy'|'distribute'|'rewardClaim'|'fundRewards'|'price'|'launch'|'advanceDay'; vault?: string; amount?: number; owner?: 'investor'|'treasury'; recipient?: string; quote?:string; lockDays?:number; compoundPercent?:number};
export function transition(state: Demo, action: Action, id: string, at: string): Demo {
 const next: Demo = structuredClone(state);
 const v = marketVaults(next).find(v=>v.id === action.vault);
 const treasury=action.owner==='treasury';
 const positions=treasury?next.treasuryPositions:next.positions;
 const p = v ? (positions[v.id] ??= emptyPosition()) : null;
 const amount = action.amount ?? 0;
 let sources:string[]=[];
 const linkSource=(key:string)=>{next.sources[key]=[...new Set([...(next.sources[key]??[]),id])];};
 const record = (type:string,value:number,note:string,name=v?.ticker??'Creator treasury') => next.entries.unshift({id,at,type,vault:name,amount:value,note,marketId:v?.id,owner:action.owner??'investor',day:next.day,sources:[...sources]});
 if(v && next.markets[v.id].status==='draft' && ['deposit','withdraw','trade','compound','claim','fundRewards'].includes(action.type))throw new Error('Create and seed this market first.');
 if(['deposit','withdraw'].includes(action.type) && (!Number.isSafeInteger(amount)||amount<=0)) throw new Error('Enter an amount greater than zero.');
 if(v && next.staleMarkets[v.id] && ['deposit','compound','trade'].includes(action.type)) throw new Error('Demo price is stale. Restore it before this action.');
 const account=treasury?'treasury':'cash';
 const ownerLabel=treasury?'Treasury ':'';
 if(action.type==='launch' && v?.id==='room' && p) {
  if(treasury)throw new Error('The creator seeds this market from the personal demo wallet.');
  const m=next.markets.room;
  if(m.status!=='draft')throw new Error('This community market has already been created.');
  if(!Number.isSafeInteger(amount)||amount<10000||amount>next.cash)throw new Error('Seed the market with at least $100 and no more than your available balance.');
  if(!['SPYx','NVDAx','QQQx','TSLAx'].includes(action.quote??'')||![0,7,30].includes(action.lockDays??-1)||![0,50,100].includes(action.compoundPercent??-1))throw new Error('Select a supported quote, lock and fee policy.');
  m.status='active';m.quote=action.quote!;m.compoundPercent=action.compoundPercent!;m.seed=amount;m.lockUntilDay=next.day+action.lockDays!;m.createdBy=id;
  next.cash-=amount;p.capital+=amount;
  record('Create market',amount,`Seeded fictional ROOM / ${m.quote} with personal demo capital. ${m.compoundPercent}% of net LP fees reinvests on each simulated trade. Seed locked until demo day ${m.lockUntilDay}; later deposits and claimable fees are not locked. No token mint, bonding curve or onchain migration is executed.`);
 } else if(action.type==='advanceDay') {
  if(!Number.isInteger(amount)||amount<1||amount>30||next.day+amount>365)throw new Error('Advance between 1 and 30 days, up to demo day 365.');
  next.day+=amount;record('Advance demo clock',0,`Demo day ${next.day}. This only changes lock eligibility; it generates no trades or earnings.`,'Demo clock');
 } else if(action.type==='deposit' && p && v) {
  if(amount>next[account]) throw new Error('Amount exceeds the available demo balance.');
  if(treasury)sources=next.sources.treasury??[];
  next[account]-=amount;p.capital+=amount;
  record(`${ownerLabel}Deposit`,amount,`${treasury?'Creator-managed treasury':'Personal demo wallet'} funds allocated 50 / 50 by value to ${pairName(v)}. Fixed prices, no real swap.`);
 } else if(action.type==='withdraw' && p) {
  if(amount>availableCapital(next,v!.id,action.owner)) throw new Error('Amount exceeds your unlocked position. Creator seed remains locked until its release day.');
  p.capital-=amount;next[account]+=amount;
  record(`${ownerLabel}Withdraw`,amount,`Position redeemed to ${treasury?'treasury cash':'personal demo USDC'} at fixed prices. Unclaimed fees remain separate.`);
 } else if(action.type==='trade' && v) {
  const investor=next.positions[v.id]??emptyPosition();
  const community=next.treasuryPositions[v.id]??emptyPosition();
  if(investor.capital+community.capital<=0) throw new Error('Deposit personal or treasury capital before simulating fees.');
  const volume=action.amount??10000000;
  if(!Number.isSafeInteger(volume)||volume<10000||volume>100000000)throw new Error('Simulate volume from $100 to $1,000,000.');
  const poolFee=Math.floor(volume*30/10000);
  const denominator=next.markets[v.id].externalCapital+investor.capital+community.capital;
  let allocated=0;let protocol=0;let net=0;let reinvested=0;
  const shares:number[]=[];
  const owners=[investor,community];
  const grossShares=owners.map(position=>Math.floor(poolFee*position.capital/denominator));
  // With no external liquidity, assign cent dust to the last funded owner rather than an imaginary LP.
  if(next.markets[v.id].externalCapital===0)grossShares[community.capital>0?1:0]+=poolFee-grossShares[0]-grossShares[1];
  for(const [index,position] of owners.entries()) {
   const gross=grossShares[index];
   const charge=Math.floor(gross/10);
   const income=gross-charge;
   const compound=Math.floor(income*next.markets[v.id].compoundPercent/100);
   position.rewards+=income-compound;position.earned+=income;position.capital+=compound;
   allocated+=gross;protocol+=charge;net+=income;reinvested+=compound;shares.push(income);
  }
  next.fees.pool+=poolFee;next.fees.externalLP+=poolFee-allocated;next.fees.protocol+=protocol;
  next.volume+=volume;next.marketVolume[v.id]=(next.marketVolume[v.id]??0)+volume;
  const creator=v.category==='Community'?Math.floor(volume*10/10000):0;
  next.creatorCash+=creator;next.fees.creator+=creator;
  const f=next.marketFees[v.id]??={pool:0,externalLP:0,protocol:0,investor:0,treasury:0,creator:0,reinvested:0};
  f.pool+=poolFee;f.externalLP+=poolFee-allocated;f.protocol+=protocol;f.investor+=shares[0];f.treasury+=shares[1];f.creator+=creator;f.reinvested+=reinvested;
  if(creator)linkSource('creator');if(shares[1])linkSource(`treasury:${v.id}`);
  record('Trading fees',net,`$${(volume/100).toFixed(2)} fictional volume. $${(poolFee/100).toFixed(2)} LP fees allocated by pre-trade capital; 10% of managed gross fees to protocol. $${(reinvested/100).toFixed(2)} net fees reinvested; $${((net-reinvested)/100).toFixed(2)} claimable. Additional creator fee: $${(creator/100).toFixed(2)}. No real trading occurs.`);
 } else if(['compound','claim','fundRewards'].includes(action.type) && p) {
  if(action.type==='fundRewards'&&!treasury) throw new Error('Only treasury earnings can fund community rewards.');
  if(p.rewards<=0) throw new Error('No fees available yet.');
  const r=p.rewards;p.rewards=0;
  if(treasury){sources=next.sources[`treasury:${v!.id}`]??[];next.sources[`treasury:${v!.id}`]=[];if(action.type==='claim')linkSource('treasury');}
  if(action.type==='compound')p.capital+=r;
  else if(action.type==='fundRewards'){next.community+=r;linkSource('reserve');}
  else next[account]+=r;
  record(`${ownerLabel}${action.type==='compound'?'Compound':action.type==='fundRewards'?'Fund rewards':'Claim fees'}`,r,action.type==='compound'?'Reinvested earned fees. Principal is retained.':action.type==='fundRewards'?'Treasury earnings moved into the community reserve; personal LP fees are untouched.':`Fees returned to ${treasury?'treasury cash':'personal demo balance'}.`);
 } else if(action.type==='allocate') {
  if(next.creatorCash<=0) throw new Error('No creator revenue to allocate. Simulate activity in the ROOM market to create another batch.');
  sources=next.sources.creator??[];next.sources.creator=[];linkSource('reserve');linkSource('treasury');
  const total=next.creatorCash;const t=Math.floor(total*next.split/100);const c=Math.floor(total*.2);
  next.treasury+=t;next.community+=c;next.operations+=total-t-c;next.creatorCash=0;
  record('Allocate revenue',total,`${next.split}% treasury cash · 20% community reserve · ${80-next.split}% operations. No stock purchase occurs until a treasury deposit.`);
 } else if(action.type==='policy') {
  if(!Number.isInteger(amount)||amount<0||amount>80) throw new Error('Treasury allocation must be between 0 and 80%.');
  next.split=amount;record('Update policy',0,`${amount}% treasury · 20% community · ${80-amount}% operations. Future batches only.`);
 } else if(action.type==='distribute') {
  if(next.community<=0) throw new Error('No community reserve to distribute.');
  sources=next.sources.reserve??[];next.sources.reserve=[];
  const total=next.community;let remaining=total;
  recipients.forEach((r,i)=>{const share=i===recipients.length-1?remaining:Math.floor(total*r.weight/100);remaining-=share;next.claimable[r.id]=(next.claimable[r.id]??0)+share;linkSource(`member:${r.id}`);});
  next.community=0;record('Publish rewards',total,'Reserve moved to claimable balances using the fictional 50 / 30 / 20 member snapshot. Nothing is minted and no funds are counted twice.','Community rewards');
 } else if(action.type==='rewardClaim') {
  const recipient=recipients.find(r=>r.id===action.recipient);
  if(!recipient)throw new Error('Unknown demo recipient.');
  const due=next.claimable[recipient.id]??0;
  if(due<=0)throw new Error('No unclaimed rewards for this member.');
  sources=next.sources[`member:${recipient.id}`]??[];next.sources[`member:${recipient.id}`]=[];
  next.claimable[recipient.id]=0;next.paid[recipient.id]=(next.paid[recipient.id]??0)+due;
  if(recipient.id==='you')next.cash+=due;
  record('Claim community reward',due,`${recipient.name} received their allocated share ${recipient.id==='you'?'in the demo wallet':'in a separate simulated recipient wallet'}.`,'Community rewards');
 } else if(action.type==='price' && v) {
  next.staleMarkets[v.id]=!next.staleMarkets[v.id];
  record('Price scenario',0,next.staleMarkets[v.id]?'Stale: deposits, compounding and trade simulations paused for both owners.':'Demo pricing restored.');
 } else throw new Error('This demo action is unavailable.');
 const before=ledgerBalances(state),after=ledgerBalances(next);
 next.entries[0].movements=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>(before[k]??0)!==(after[k]??0)).map(account=>({account,before:before[account]??0,after:after[account]??0}));
 return next;
}
