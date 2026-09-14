import { PublicKey } from '@solana/web3.js';
import { NVDA, USDC } from '../finance';

export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com';
// PublicNode blocks owner-index queries. A dedicated provider should serve both in production.
const WALLET_RPC_URL = process.env.SOLANA_WALLET_RPC_URL || process.env.SOLANA_RPC_URL;
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
export const STOCK_RESERVE = '7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q';
export const CASH_RESERVE = '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E';
export const SCOPE = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';
export const SCOPE_PROGRAM = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';

export async function getJSON(url:string, init:RequestInit={}):Promise<any> {
  const res=await fetch(url,{...init,headers:{'User-Agent':'Stockroom/0.2',...init.headers},signal:AbortSignal.timeout(15000),cache:'no-store'});
  if(res.status===429) throw new Error('Provider rate limit reached. Wait a minute and try again.');
  if(!res.ok) throw new Error(`${new URL(url).hostname} could not complete this request (${res.status}).`);
  return res.json();
}
// Internal callers only. No public arbitrary RPC proxy and no server-side signing or sending.
export async function rpc(method:string,params:unknown[],endpoint=RPC_URL) {
  const data=await getJSON(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(data.error) throw new Error(`Solana could not complete ${method}: ${String(data.error.message).slice(0,180)}`);
  if(!('result' in data)) throw new Error('Invalid Solana response');
  return data.result;
}
export function walletAddress(value:unknown):string {
  if(typeof value!=='string'||value.length>44) throw new Error('Enter a valid Solana wallet address.');
  const key=new PublicKey(value);
  if(!PublicKey.isOnCurve(key.toBytes())) throw new Error('A signing wallet address is required.');
  return key.toBase58();
}
export function associatedToken(wallet:string,mint:string,program:string) {
  return PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(),new PublicKey(program).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
}
export type WalletBalances={balanceScope:'all-token-accounts'|'associated-token-accounts';address:string;sol:number;stockRaw:string;cashRaw:string;stockAta:string;cashAta:string;stockAtaRaw:string;cashAtaRaw:string;fetchedAt:string};
export async function balances(wallet:string):Promise<WalletBalances> {
  const address=walletAddress(wallet);
  const stockAta=associatedToken(address,NVDA,TOKEN_2022),cashAta=associatedToken(address,USDC,TOKEN_PROGRAM);
  let stock,cash,sol;
  const balanceScope=WALLET_RPC_URL?'all-token-accounts':'associated-token-accounts';
  if(WALLET_RPC_URL){
    [sol,stock,cash]=await Promise.all([
      rpc('getBalance',[address,{commitment:'confirmed'}],WALLET_RPC_URL),
      rpc('getTokenAccountsByOwner',[address,{mint:NVDA},{encoding:'jsonParsed',commitment:'confirmed'}],WALLET_RPC_URL),
      rpc('getTokenAccountsByOwner',[address,{mint:USDC},{encoding:'jsonParsed',commitment:'confirmed'}],WALLET_RPC_URL)
    ]);
  }else{
    const [native,accounts]=await Promise.all([
      rpc('getBalance',[address,{commitment:'confirmed'}]),
      rpc('getMultipleAccounts',[[stockAta,cashAta],{encoding:'jsonParsed',commitment:'confirmed'}])
    ]);
    sol=native;
    stock={value:accounts.value[0]?[{pubkey:stockAta,account:accounts.value[0]}]:[]};
    cash={value:accounts.value[1]?[{pubkey:cashAta,account:accounts.value[1]}]:[]};
  }
  const amounts=(result:{value:unknown[]},mint:string,program:string,ata:string)=>{
    let total=0n,ataRaw=0n;
    for(const entry of result.value){
      const a=entry as {pubkey:string;account:{owner:string;data:{parsed:{info:{mint:string;owner:string;state:string;tokenAmount:{amount:string}}}}}};
      const info=a.account.data.parsed.info;
      if(a.account.owner!==program||info.owner!==address||info.mint!==mint)throw new Error('Unexpected token account');
      if(info.state!=='initialized')continue;
      if(!/^\d+$/.test(info.tokenAmount.amount))throw new Error('Invalid token amount');
      const raw=BigInt(info.tokenAmount.amount);total+=raw;if(a.pubkey===ata)ataRaw=raw;
    }
    return [total.toString(),ataRaw.toString()];
  };
  const [stockRaw,stockAtaRaw]=amounts(stock,NVDA,TOKEN_2022,stockAta),[cashRaw,cashAtaRaw]=amounts(cash,USDC,TOKEN_PROGRAM,cashAta);
  return {balanceScope,address,sol:sol.value/1e9,stockRaw,cashRaw,stockAta,cashAta,stockAtaRaw,cashAtaRaw,fetchedAt:new Date().toISOString()};
}
export function sameOrigin(request:Request){
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)throw new Error('Cross-origin action requests are not accepted.');
  if(Number(request.headers.get('content-length')||0)>16000)throw new Error('Request too large.');
}
export function failure(error:unknown,status=502){return Response.json({error:error instanceof Error?error.message:'Request unavailable'},{status,headers:{'Cache-Control':'no-store'}});}
