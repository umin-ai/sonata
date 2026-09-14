import {jupiterMarkets} from '@/lib/server/jupiter';
import {failure} from '@/lib/server/chain';
export const dynamic='force-dynamic';
export async function GET(){try{return Response.json(await jupiterMarkets(),{headers:{'Cache-Control':'no-store'}})}catch(e){return failure(e)}}
