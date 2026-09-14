import {jupiterPositions} from '@/lib/server/jupiter';
import {failure} from '@/lib/server/chain';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return Response.json(await jupiterPositions(new URL(request.url).searchParams.get('address')||''),{headers:{'Cache-Control':'no-store'}})}catch(e){return failure(e)}}
