// The in-app mock of Munim's storefront API (see mock-server/). Swap NEXT_PUBLIC_MUNIM_API to the real API and this
// route is simply never called.
import { handle } from "@/mock-server/handler";

type Ctx = { params: Promise<{ path: string[] }> };

/** The SSE route keeps a response open for about 50 s before asking the client to reconnect. */
export const maxDuration = 60;

const serve = async (req: Request, ctx: Ctx) => handle(req, (await ctx.params).path);

export const GET = serve;
export const POST = serve;
export const OPTIONS = serve;
