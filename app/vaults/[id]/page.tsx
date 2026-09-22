import stockPools from '@/lib/liquidity/stock-markets.json';
import {StockVault} from '@/app/earn/stock-vault';
import { notFound } from 'next/navigation';
import { VaultDetail } from '../../vault-workspace';
import { vaults } from '@/lib/vaults/demo';
export default async function Page({params}:{params:Promise<{id:string}>}){ const {id}=await params; if(!vaults.some(v=>v.id===id))notFound();if((stockPools as {id:string}[]).some(p=>p.id===id))return <StockVault id={id}/>;return <VaultDetail id={id}/>; }
