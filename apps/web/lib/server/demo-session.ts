// Server only: the work behind POST /staff/demo-session (app/staff/demo-session/route.ts). The "Demo sign-in" picker
// sends one of the four demo people's keys; this signs that person in and returns their token and the demo business,
// which the browser then proves with GET /v1/me (session.ts signInDemoServer). The one demo password and the local
// tokens file never leave the server, and nothing here logs, echoes or embeds a token or the password in an error.
//   - MUNIM_IDP=local: the token comes from MUNIM_DEMO_TOKENS, a JSON file {"owner", "manager", "counter", "kitchen"}
//     the Cobnut world seed writes to the run dir;
//   - otherwise: the dev IdP's password grant for <key>@cobnut-demo.invalid with MUNIM_DEMO_PASSWORD.
// These are read from process.env here, not through packages/config: that module reads the repo's .env and .run/,
// which a deployed apps/web does not have, and lists none of these names.
import { readFile } from "node:fs/promises";
import { DEMO_KEYS, type DemoKey } from "@/lib/munim/session";

/** process.env, or a test's own settings. */
export interface DemoEnv {
  [name: string]: string | undefined;
  MUNIM_DEMO_SIGNIN?: string;
  MUNIM_IDP?: string;
  MUNIM_DEMO_TOKENS?: string;
  MUNIM_DEMO_PASSWORD?: string;
  MUNIM_DEMO_TENANT_ID?: string;
  DEVHOST_PROJECT_URL?: string;
  DEVHOST_PUBLISHABLE_KEY?: string;
}

/** `<key>@cobnut-demo.invalid`: the .invalid TLD can never receive mail. */
export const demoEmail = (key: DemoKey): string => `${key}@cobnut-demo.invalid`;

const MESSAGE: Record<string, string> = {
  not_found: "Not found.",
  bad_request: "Choose one of the demo people.",
  unavailable: "Demo sign-in is not working right now.",
};
const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, code: "not_found" | "bad_request" | "unavailable") => answer(status, { error: { code, message: MESSAGE[code], reason_code: null } });

async function fromFile(path: string | undefined, key: DemoKey): Promise<string | null> {
  if (!path) return null;
  try {
    const tokens = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return typeof tokens[key] === "string" && tokens[key] !== "" ? tokens[key] : null;
  } catch {
    return null; // missing or unreadable file: the person sees "not working right now"
  }
}

async function passwordGrant(env: DemoEnv, key: DemoKey, fetchImpl: typeof fetch): Promise<string | null> {
  const base = env.DEVHOST_PROJECT_URL?.replace(/\/+$/, "");
  if (!base || !env.DEVHOST_PUBLISHABLE_KEY || !env.MUNIM_DEMO_PASSWORD) return null;
  try {
    const res = await fetchImpl(`${base}/auth/v1/token?grant_type=password`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { apikey: env.DEVHOST_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: demoEmail(key), password: env.MUNIM_DEMO_PASSWORD }),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { access_token?: unknown };
    return typeof b.access_token === "string" && b.access_token !== "" ? b.access_token : null;
  } catch {
    return null;
  }
}

/** 404 when demo sign-in is off; 400 for anything but the four keys; 503 when the token cannot be had. */
export async function demoSession(req: Request, env: DemoEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (env.MUNIM_DEMO_SIGNIN !== "1") return refuse(404, "not_found");
  const body = (await req.json().catch(() => null)) as { person?: unknown } | null;
  const key = DEMO_KEYS.find((k) => k === body?.person);
  if (!key) return refuse(400, "bad_request");
  const tenantId = env.MUNIM_DEMO_TENANT_ID;
  if (!tenantId) return refuse(503, "unavailable");
  const token = env.MUNIM_IDP === "local" ? await fromFile(env.MUNIM_DEMO_TOKENS, key) : await passwordGrant(env, key, fetchImpl);
  if (!token) return refuse(503, "unavailable");
  return answer(200, { token, tenant_id: tenantId });
}
