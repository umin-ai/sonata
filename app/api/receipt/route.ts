import bs58 from 'bs58';
import { rpc,walletAddress,failure } from '@/lib/server/chain';
import { NVDA,USDC } from '@/lib/finance';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
  const s=new URL(request.url).searchParams,signature=s.get('signature')||'',wallet=walletAddress(s.get('wallet'));
  if(signature.length>90||bs58.decode(signature).length!==64)return failure(new Error('Invalid signature.'),400);
  const status=await rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]);
  const entry=status.value[0];if(!entry||!['confirmed','finalized'].includes(entry.confirmationStatus))return Response.json({status:'pending',signature},{headers:{'Cache-Control':'no-store'}});
  if(entry.err)return Response.json({status:'failed',signature,error:entry.err},{headers:{'Cache-Control':'no-store'}});
  const tx=await rpc('getTransaction',[signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
  if(!tx)return Response.json({status:'pending',signature},{headers:{'Cache-Control':'no-store'}});
  if(tx.meta.err||tx.transaction.message.accountKeys[0].pubkey!==wallet)throw new Error('Transaction failed or belongs to another wallet.');
  function total(rows:any[],mint:string){return rows.filter(r=>r.owner===wallet&&r.mint===mint).reduce((a:bigint,r:any)=>a+BigInt(r.uiTokenAmount.amount),0n)}
  const pre=tx.meta.preTokenBalances??[],post=tx.meta.postTokenBalances??[];
  return Response.json({status:entry.confirmationStatus,signature,slot:tx.slot,blockTime:tx.blockTime,wallet,stockRawDelta:(total(post,NVDA)-total(pre,NVDA)).toString(),cashRawDelta:(total(post,USDC)-total(pre,USDC)).toString(),networkFee:tx.meta.fee/1e9,solDelta:(tx.meta.postBalances[0]-tx.meta.preBalances[0])/1e9,explorer:`https://solscan.io/tx/${signature}`},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e)}}
