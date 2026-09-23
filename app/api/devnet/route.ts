import { getChatGPTUser } from "@/app/chatgpt-auth";
import { sameOrigin } from "@/lib/server/chain";
import { SponsorRequest, cosignDemo } from "@/lib/server/stockroom";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  // The historical credit demo's co-signing endpoint. It authenticates on
  // headers a public client could forge, so it is off unless a local operator
  // enables it explicitly.
  if (process.env.SONATA_ENABLE_DEVNET_SPONSOR !== "1")
    return Response.json(
      { error: "Not available." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  try {
    sameOrigin(request);
    if (!(await getChatGPTUser()))
      return Response.json(
        { error: "Sign in to Sonata before using the Devnet demo." },
        { status: 401 },
      );
    const body = await request.text();
    if (body.length > 3000) throw Error("Request too large.");
    return Response.json(
      await cosignDemo(SponsorRequest.parse(JSON.parse(body))),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Demo sponsorship failed." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
