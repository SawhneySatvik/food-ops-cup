// Demo accounts for the Cobnut world on Identity Platform: the four demo people as users `<key>@cobnut-demo.invalid`
// (the `.invalid` TLD can never receive mail), email-verified, all with ONE generated password. Plus the server-side
// password grant the web app's demo sign-in calls (`accounts:signInWithPassword` with the public web API key).
// Admin calls use a metadata-server access token (Cloud Run job or service). Errors name the step and the HTTP
// status only — never a body, a key, a token or the password.
// Run: MUNIM_IDP_PROJECT_ID=… MUNIM_IDP_WEB_API_KEY=… node adapters/gcp/idp-identity-platform/demo-accounts.ts
// prints a JSON {owner, manager, counter, kitchen} of ID tokens on stdout, for MUNIM_SEED_TOKENS.
// UNVERIFIED against a live project: the REST routes follow Google's public Identity Toolkit reference, and whether
// an `.invalid` address is accepted was not checked.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { metadataTokenSource, type TokenSource } from "../metadata-token.ts";

export const DEMO_KEYS = ["owner", "manager", "counter", "kitchen"] as const;
export type DemoKey = (typeof DEMO_KEYS)[number];
export const demoEmail = (key: DemoKey): string => `${key}@cobnut-demo.invalid`;

const API = "https://identitytoolkit.googleapis.com";

export class DemoAccountError extends Error {
  override name = "DemoAccountError";
}

async function post(call: typeof fetch, step: string, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await call(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new DemoAccountError(`${step}: Identity Platform unreachable`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new DemoAccountError(`${step}: HTTP ${res.status}`);
  return json;
}

/** The password grant: email + password -> an ID token. Called server-side only, with the public web API key. */
export async function passwordGrant(o: {
  apiKey: string; email: string; password: string; fetch?: typeof fetch | undefined; apiBase?: string | undefined;
}): Promise<{ idToken: string; refreshToken: string | null; expiresIn: number | null }> {
  const j = await post(o.fetch ?? fetch, "sign in", `${(o.apiBase ?? API).replace(/\/+$/, "")}/v1/accounts:signInWithPassword?key=${encodeURIComponent(o.apiKey)}`, {},
    { email: o.email, password: o.password, returnSecureToken: true });
  if (typeof j.idToken !== "string") throw new DemoAccountError("sign in: no ID token");
  return {
    idToken: j.idToken,
    refreshToken: typeof j.refreshToken === "string" ? j.refreshToken : null,
    expiresIn: typeof j.expiresIn === "string" && Number.isFinite(Number(j.expiresIn)) ? Number(j.expiresIn) : null,
  };
}

export interface DemoAccountsOptions {
  projectId: string;
  /** The public web API key: the password grant. */
  webApiKey: string;
  password: string;
  fetch?: typeof fetch | undefined;
  /** Admin access token source; default: the metadata server. */
  token?: TokenSource | undefined;
  apiBase?: string | undefined;
}

/** Creates (or resets the password of) each demo user, verified, then signs each in: their ID tokens. */
export async function ensureDemoAccounts(o: DemoAccountsOptions): Promise<Record<DemoKey, string>> {
  const call = o.fetch ?? fetch;
  const token = o.token ?? metadataTokenSource({ fetch: o.fetch });
  const base = `${(o.apiBase ?? API).replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(o.projectId)}`;
  const admin = async () => ({ Authorization: `Bearer ${await token()}` });
  const tokens = {} as Record<DemoKey, string>;
  for (const key of DEMO_KEYS) {
    const email = demoEmail(key);
    const found = await post(call, `look up ${key}`, `${base}/accounts:lookup`, await admin(), { email: [email] });
    const existing = (found.users as Array<{ localId?: unknown }> | undefined)?.[0]?.localId;
    if (typeof existing === "string") {
      await post(call, `update ${key}`, `${base}/accounts:update`, await admin(), { localId: existing, password: o.password, emailVerified: true });
    } else {
      await post(call, `create ${key}`, `${base}/accounts`, await admin(), { email, password: o.password, emailVerified: true });
    }
    tokens[key] = (await passwordGrant({ apiKey: o.webApiKey, email, password: o.password, fetch: o.fetch, apiBase: o.apiBase })).idToken;
  }
  return tokens;
}

/** The one demo password: read from `<runDir>/cobnut/demo-password`, else generated there (0600 in a 0700 directory). */
export function demoPassword(runDir: string): { password: string; file: string } {
  const dir = join(runDir, "cobnut");
  const file = join(dir, "demo-password");
  if (existsSync(file)) return { password: readFileSync(file, "utf8").trim(), file };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("base64url");
  writeFileSync(file, `${password}\n`, { mode: 0o600 });
  return { password, file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error("takes no arguments (the run directory is MUNIM_RUN_DIR, default <repo>/.run)");
    const need = (n: string) => process.env[n] || (() => { throw new Error(`${n} is not set`); })();
    const runDir = process.env.MUNIM_RUN_DIR || resolve(import.meta.dirname, "../../..", ".run");
    const tokens = await ensureDemoAccounts({ projectId: need("MUNIM_IDP_PROJECT_ID"), webApiKey: need("MUNIM_IDP_WEB_API_KEY"), password: demoPassword(runDir).password });
    console.log(JSON.stringify(tokens));
  } catch (e) {
    console.error(`demo-accounts: FAIL — ${e instanceof Error ? e.message : "error"}`);
    process.exit(1);
  }
}
