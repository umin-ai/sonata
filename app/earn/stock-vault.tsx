'use client';
import {useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {stockLiquidity,type StockLiquiditySnapshot} from '@/lib/liquidity/stock-runtime';
import {useLive} from '@/app/onchain/live-session';
import {TokenName} from '@/app/token-identity';
import {TokenMarketPanel} from '@/app/token-market-panel';
import {Card} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Badge} from '@/components/ui/badge';
import {formatUnits} from '@/lib/treasury/units';
import {explorer} from '@/lib/treasury/runtime';
export function StockVault({id}:{id:string}){
 const api=useMemo(()=>stockLiquidity(id),[id]);
 const {address,revision,busy,pending,execute}=useLive();
 const [data,setData]=useState<StockLiquiditySnapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[amount,setAmount]=useState('100');
 useEffect(()=>{let active=true;setLoading(true);setData(null);setError('');api.readLiquidity(address||undefined).then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[api,address,revision,refresh]);
 const enabled=!!address&&!!data&&!loading&&!busy&&!pending;
 return <><Link href="/earn?net=devnet">← All earning pools</Link><div className="sr-heading"><div><span className="sr-eyebrow">STOCK LIQUIDITY / DEVNET</span><h1><TokenName symbol={api.manifest.symbolB} size={36}/> / MockUSDC</h1><p>Supply both test assets. Swap fees compound in your wallet-owned Meteora position.</p></div><Badge variant="outline">Devnet · test tokens only</Badge></div>
 <Card className="sr-panel mb-6"><div className="sr-section-top"><h2>Pool overview</h2><Button variant="outline" disabled={loading} onClick={()=>setRefresh(x=>x+1)}>Refresh pool</Button></div>{error&&<p role="alert" className="text-destructive">{error}</p>}<div className="sr-position-strip"><div><span>MockUSDC supplied</span><strong>{data?formatUnits(data.a,6):'—'}</strong></div><div><span>{api.manifest.symbolB} supplied</span><strong>{data?formatUnits(data.b,8):'—'}</strong></div><div><span>Fee APR</span><strong>Collecting data</strong></div></div><p>1% swap fee before Meteora’s protocol share. Net LP fees reinvest automatically. Test activity is not evidence of real investment returns.</p><a href={explorer('address',api.manifest.pool)} target="_blank" rel="noreferrer">View Devnet pool ↗</a></Card>
 <Card className="sr-panel mb-6"><h2>Deposit liquidity</h2><Label htmlFor="stock-cash">MockUSDC to supply</Label><Input id="stock-cash" type="number" min="0" value={amount} onChange={e=>setAmount(e.target.value)}/><p>Wallet: {data?.balance?`${formatUnits(data.balance.base,6)} MockUSDC · ${formatUnits(data.balance.quote,8)} ${api.manifest.symbolB}`:'Connect your wallet to see test balances.'}</p><p>The transaction review shows the matching stock amount and maximum debits. Your position NFT stays in your wallet.</p><Button disabled={!enabled||!Number.isFinite(Number(amount))||Number(amount)<=0} onClick={()=>void execute(()=>api.prepareDeposit(address!,amount))}>Review deposit</Button></Card>
 <Card className="sr-panel mb-6"><h2>Your positions</h2>{loading?<p>Reading Solana…</p>:!address?<p>Connect a Devnet wallet to view positions.</p>:!data?<p>Positions unavailable. Refresh to retry.</p>:!data.positions.length?<p>No positions in this pool yet.</p>:data.positions.map(p=><div key={p.address} className="sr-panel"><h3>{p.sharePercent}% pool share</h3><p>{formatUnits(p.a,6)} MockUSDC + {formatUnits(p.b,8)} {api.manifest.symbolB}</p><div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!enabled} onClick={()=>void execute(()=>api.prepareWithdrawal(address!,p.address,5000))}>Withdraw half</Button><Button variant="outline" disabled={!enabled} onClick={()=>void execute(()=>api.prepareWithdrawal(address!,p.address,10000))}>Withdraw all</Button><a href={explorer('address',p.address)} target="_blank" rel="noreferrer">Position ↗</a></div></div>)}<p>Withdrawals return both assets, including your share of compounded fees. There is no separate fee claim.</p></Card>
 <TokenMarketPanel id={id}/></>;
}
