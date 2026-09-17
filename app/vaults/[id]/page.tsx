import { notFound } from 'next/navigation';
import { VaultDetail } from '../../vault-workspace';
import { vaults } from '@/lib/vaults/demo';
export default async function Page({params}:{params:Promise<{id:string}>}){ const {id}=await params; if(!vaults.some(v=>v.id===id))notFound();return <VaultDetail id={id}/>; }
