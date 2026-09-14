export const dynamic='force-dynamic';
// Transaction-building experiments are deliberately not exposed by the hosted app.
export async function POST(){
  return Response.json({error:'Stockroom is read-only on mainnet. Complete transactions in Kamino.'},{status:503,headers:{'Cache-Control':'no-store'}});
}
