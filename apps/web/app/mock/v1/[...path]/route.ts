// The in-app mock of Munim's API (see mock-server/), for development and tests only: it answers 404 unless the
// server runs with MUNIM_MOCK=1, so a production build (NEXT_PUBLIC_MUNIM_API=/api) never serves it.
import { handle } from "@/mock-server/handler";

type Ctx = { params: Promise<{ path: string[] }> };

/** The SSE route keeps a response open for about 50 s before asking the client to reconnect. */
export const maxDuration = 60;

const serve = async (req: Request, ctx: Ctx) =>
  process.env.MUNIM_MOCK === "1" ? handle(req, (await ctx.params).path) : new Response(null, { status: 404 });

export const GET = serve;
export const POST = serve;
export const OPTIONS = serve;
