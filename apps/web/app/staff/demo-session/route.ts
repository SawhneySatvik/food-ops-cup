// POST /staff/demo-session {person}: the demo picker's server sign-in (lib/server/demo-session.ts says how).
import { demoSession } from "@/lib/server/demo-session";

export const POST = (req: Request) => demoSession(req, process.env);
