import { balances,failure } from '@/lib/server/chain';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return Response.json(await balances(new URL(request.url).searchParams.get('address')||''),{headers:{'Cache-Control':'no-store'}})}catch(e){return failure(e,400)}}
