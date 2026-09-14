import { marketSnapshot } from '@/lib/server/market';
import { fetchPosition,positionSummary } from '@/lib/server/position';
import { walletAddress,failure } from '@/lib/server/chain';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
  const wallet=walletAddress(new URL(request.url).searchParams.get('address'));
  const [m,p]=await Promise.all([marketSnapshot(),fetchPosition(wallet)]);
  return Response.json({address:p.address,...positionSummary(p.state,m.stock,m.debt,m.multiplier),multiplier:m.multiplier,fetchedAt:m.fetchedAt,scope:'Vanilla position in the xStocks market. Amounts reflect the latest reserve refresh; transaction simulation determines current repayment.'},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e)}}
