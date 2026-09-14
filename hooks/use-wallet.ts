"use client";
import { useEffect,useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet,WalletAccount } from '@wallet-standard/base';
import type { StandardConnectFeature,StandardDisconnectFeature,StandardEventsFeature } from '@wallet-standard/features';

export function useWallet(){
  const [wallets,setWallets]=useState<readonly Wallet[]>([]),[wallet,setWallet]=useState<Wallet|null>(null),[account,setAccount]=useState<WalletAccount|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const registry=getWallets();const update=()=>setWallets(registry.get().filter(w=>w.chains.includes('solana:mainnet')&&'standard:connect' in w.features));update();const a=registry.on('register',update),b=registry.on('unregister',update);return()=>{a();b()}},[]);
  useEffect(()=>{if(!wallet)return;const f=wallet.features as unknown as Partial<StandardEventsFeature>;return f['standard:events']?.on('change',event=>{if(event.accounts)setAccount(event.accounts.find(a=>a.chains.includes('solana:mainnet'))??null)})},[wallet]);
  const connect=async(selected:Wallet)=>{setBusy(true);setError('');try{const f=selected.features as unknown as StandardConnectFeature;const result=await f['standard:connect'].connect();const a=result.accounts.find(a=>a.chains.includes('solana:mainnet'));if(!a)throw new Error('Select a Solana mainnet account in your wallet.');setWallet(selected);setAccount(a)}catch(e){setError(e instanceof Error?e.message:'Connection declined')}finally{setBusy(false)}};
  const disconnect=async()=>{const previous=wallet;setWallet(null);setAccount(null);setError('');try{const f=previous?.features as unknown as Partial<StandardDisconnectFeature>;await f?.['standard:disconnect']?.disconnect()}catch{}};
  return {wallets,wallet,account,busy,error,connect,disconnect};
}
