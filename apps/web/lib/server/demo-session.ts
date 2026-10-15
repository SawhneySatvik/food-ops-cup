// Server only: the work behind POST /staff/demo-session (app/staff/demo-session/route.ts). The "Demo sign-in" picker
// sends one of the four demo people's keys; this signs that person in and returns their token and the demo business,
// which the browser then proves with GET /v1/me (session.ts signInDemoServer). The one demo password and the local
// tokens file never leave the server, and nothing here logs, echoes or embeds a token or the password in an error.
// MUNIM_IDP chooses how, as it does for core-api:
//   - local: the token comes from MUNIM_DEMO_TOKENS, a JSON file {"owner", "manager", "counter", "kitchen"} the Cobnut
//     world seed writes to the run dir;
//   - identity-platform: Identity Platform's password grant for <key>@cobnut-demo.invalid with MUNIM_DEMO_PASSWORD and
//     the public web API key MUNIM_IDP_WEB_API_KEY (adapters/gcp);
//   - a development checkout's own IdP, when it has one (`@munim-dev/web-signin`, resolved by tsconfig `paths`); it
//     also serves an unset MUNIM_IDP. Without one, an unset MUNIM_IDP is 503.
// These are read from process.env here, not through packages/config: that module reads the repo's .env and .run/,
// which a deployed apps/web does not have.
import { readFile } from "node:fs/promises";
import { devSignin } from "@munim-dev/web-signin";
import type { DevSignin } from "@/lib/server/no-dev/web-signin";
import { passwordGrant } from "../../../../adapters/gcp/idp-identity-platform/demo-accounts.ts";
import { DEMO_KEYS, type DemoKey } from "@/lib/munim/session";

/** process.env, or a test's own settings. */
export interface DemoEnv {
  [name: string]: string | undefined;
  MUNIM_DEMO_SIGNIN?: string;
  MUNIM_IDP?: string;
  MUNIM_IDP_WEB_API_KEY?: string;
  MUNIM_DEMO_TOKENS?: string;
  MUNIM_DEMO_PASSWORD?: string;
  MUNIM_DEMO_TENANT_ID?: string;
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

async function token(env: DemoEnv, key: DemoKey, fetchImpl: typeof fetch, dev: DevSignin | null): Promise<string | null> {
  const mode = env.MUNIM_IDP || dev?.mode;
  if (mode === "local") return fromFile(env.MUNIM_DEMO_TOKENS, key);
  if (!env.MUNIM_DEMO_PASSWORD) return null;
  const login = { email: demoEmail(key), password: env.MUNIM_DEMO_PASSWORD };
  if (mode === "identity-platform") {
    if (!env.MUNIM_IDP_WEB_API_KEY) return null;
    try {
      return (await passwordGrant({ apiKey: env.MUNIM_IDP_WEB_API_KEY, ...login, fetch: fetchImpl })).idToken;
    } catch {
      return null; // its errors carry the status only, and none of them reaches the person
    }
  }
  return dev && mode === dev.mode ? dev.grant(login, env, fetchImpl) : null;
}

/** 404 when demo sign-in is off; 400 for anything but the four keys; 503 when the token cannot be had. `dev` is this
 *  checkout's own IdP grant, if any (tests pass their own or null). */
export async function demoSession(req: Request, env: DemoEnv, fetchImpl: typeof fetch = fetch, dev: DevSignin | null = devSignin): Promise<Response> {
  if (env.MUNIM_DEMO_SIGNIN !== "1") return refuse(404, "not_found");
  const body = (await req.json().catch(() => null)) as { person?: unknown } | null;
  const key = DEMO_KEYS.find((k) => k === body?.person);
  if (!key) return refuse(400, "bad_request");
  const tenantId = env.MUNIM_DEMO_TENANT_ID;
  if (!tenantId) return refuse(503, "unavailable");
  const t = await token(env, key, fetchImpl, dev);
  if (!t) return refuse(503, "unavailable");
  return answer(200, { token: t, tenant_id: tenantId });
}
