// file: lib/munim/session.ts
// The session seam: who is signed in, in which business, and the staff client for them. The "Demo sign-in" picker
// offers four invented people:
//   - on the mock, each has a public mock token;
//   - on the real API, this app's server signs the person in (POST /staff/demo-session, the password stays on the
//     server) and returns their token and the demo business; GET /v1/me then proves both, as on the mock.
// The session lives in sessionStorage only (never localStorage, a URL or a log). Plain TypeScript, no React.
import { createMunimClient as createSdkClient } from "@munim/sdk";
import { parseError, settle, type Result } from "./client";
import { createStaffClient, type StaffClient } from "./staff";
import type { Schemas } from "./types";

export type Me = Schemas["V1Me"];
export type Role = Me["role"];

export interface Session {
  token: string;
  tenantId: string;
  /** GET /v1/me as core resolved it: member_id, name, role, outlet_ids ("*" = every outlet). */
  me: Me;
  /** True when signed in with the demo picker: the shell shows the "Demo sign-in" badge. */
  demo: boolean;
  /** The picker person's first screen (the /staff index sends them there); absent for any other sign-in. */
  home?: string;
}

/** The mock's business. Public test values, like the storefront key; the real API never accepts them. */
export const DEMO_TENANT_ID = "019a0c5e-7e11-7a00-8c0b-0000000c0b17";

export type DemoKey = "owner" | "manager" | "counter" | "kitchen";
export const DEMO_KEYS: readonly DemoKey[] = ["owner", "manager", "counter", "kitchen"];

export interface DemoPerson {
  key: DemoKey;
  /** Shown on the picker card, then replaced by GET /v1/me's name once signed in. */
  name: string;
  role: Role;
  /** What the card says the person does. */
  blurb: string;
  /** Where the person lands after signing in. */
  home: string;
  /** The mock's public token for this person; the real API never accepts it. */
  token: string;
}

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  { key: "owner", name: "Nandini Mehrotra", role: "owner", blurb: "Owner · both outlets", home: "/staff/home", token: "mock_member_owner_c0b1_7f2e9a14" },
  { key: "manager", name: "Farah Qureshi", role: "manager", blurb: "Manager · Cobnut Gomti Nagar", home: "/staff/home", token: "mock_member_manager_c0b1_d24e6b05" },
  { key: "counter", name: "Imran Siddiqui", role: "staff", blurb: "Counter · Cobnut Hazratganj", home: "/staff/counter", token: "mock_member_counter_c0b1_3b8d5e60" },
  { key: "kitchen", name: "Kavya Tandon", role: "staff", blurb: "Kitchen · Cobnut Hazratganj", home: "/staff/kitchen", token: "mock_member_kitchen_c0b1_91c4a2d7" },
];

const SESSION_KEY = "munim.staff.session";
const OUTLET_KEY = "munim.staff.outlet";

export function readSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return s && typeof s.token === "string" && typeof s.tenantId === "string" && s.me ? s : null;
  } catch {
    return null;
  }
}

function writeSession(s: Session): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // storage blocked: the person stays signed in for this page only
  }
}

/** Deletes the session and the chosen outlet. Call on "Sign out" and on any 401. */
export function signOut(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(OUTLET_KEY);
  } catch {
    // nothing stored
  }
}

/** The outlet the shell's switcher chose (an id, not a credential); null = not chosen yet. */
export function readOutlet(): string | null {
  try {
    return typeof window === "undefined" ? null : sessionStorage.getItem(OUTLET_KEY);
  } catch {
    return null;
  }
}
export function writeOutlet(outletId: string): void {
  try {
    sessionStorage.setItem(OUTLET_KEY, outletId);
  } catch {
    // storage blocked: the switcher falls back to the first outlet on each page
  }
}

/** The staff client for a session. `extraHeaders` = mockHeaders on the mock (index.ts), else undefined. */
export const clientFor = (baseUrl: string, s: Pick<Session, "token" | "tenantId">, extraHeaders?: () => Record<string, string>): StaffClient =>
  createStaffClient({ baseUrl, token: () => s.token, tenantId: s.tenantId, extraHeaders });

/** Signs in with a token and tenant: GET /v1/me proves both, then the session is stored. A 401 or 404 means the
 *  token or the membership is not good; the caller shows "Sign-in didn't work" and never says which. */
export async function signInWith(baseUrl: string, token: string, tenantId: string, demo: boolean, home?: string): Promise<Result<Session>> {
  const me = await clientFor(baseUrl, { token, tenantId }).getMe();
  if (!me.ok) return me;
  const session: Session = { token, tenantId, me: me.data, demo, ...(home ? { home } : {}) };
  writeSession(session);
  return { ok: true, status: me.status, data: session, replayed: false };
}

/** The "Demo sign-in" picker on the mock. */
export const signInDemo = (baseUrl: string, person: DemoPerson): Promise<Result<Session>> => signInWith(baseUrl, person.token, DEMO_TENANT_ID, true, person.home);

/** The "Demo sign-in" picker on the real API: this app's server signs the person in (app/staff/demo-session), then
 *  GET /v1/me proves the token and the business. A 404 means demo sign-in is switched off on this site. */
export async function signInDemoServer(baseUrl: string, person: DemoPerson): Promise<Result<Session>> {
  let res: Response;
  let body: unknown = null;
  try {
    res = await fetch("/staff/demo-session", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: person.key }),
    });
    body = await res.json().catch(() => null);
  } catch {
    return { ok: false, error: { kind: "network", status: 0, code: null, reasonCode: null, params: {}, retryAfterMs: null } };
  }
  const b = body as { token?: unknown; tenant_id?: unknown } | null;
  if (!res.ok || typeof b?.token !== "string" || typeof b.tenant_id !== "string") return { ok: false, error: parseError(res, body) };
  return signInWith(baseUrl, b.token, b.tenant_id, true, person.home);
}

/** The real API: an ID token from the IdP (the founder sends its details later). Lists the businesses this sign-in
 *  belongs to (no tenant header yet); with exactly one, signs in to it; with several, the caller shows a picker and
 *  calls signInWith for the one chosen. */
export async function tenantsFor(baseUrl: string, idToken: string): Promise<Result<Schemas["TenancyMeTenants"]>> {
  const sdk = createSdkClient({ baseUrl: baseUrl.replace(/\/+$/, ""), token: () => idToken });
  return settle(() => sdk.GET("/v1/me/tenants", { cache: "no-store", signal: AbortSignal.timeout(15_000) }));
}

/** Which screens a role may open (the API is the real guard; this only hides tabs that would be refused). */
export const CAN: Record<string, readonly Role[]> = {
  counter: ["owner", "manager", "staff", "judge"],
  kitchen: ["owner", "manager", "staff", "judge"],
  home: ["owner", "manager", "judge"],
  inbox: ["owner", "manager", "judge"],
  ask: ["owner", "manager", "staff", "advisor", "judge"],
  cares: ["owner", "manager", "staff", "judge"],
  suppliers: ["owner", "manager", "judge"],
  // T-128. Investigations read finance templates (advisor and up), so a manager would only ever see them restricted.
  investigations: ["owner", "advisor", "judge"],
  office: ["owner", "manager", "judge"],
  campaigns: ["owner", "manager", "judge"],
  // Saving needs every outlet (the storefront serves them all); a single-outlet manager sees the page read-only.
  storefront: ["owner", "manager", "judge"],
};
export const can = (s: Session | null, screen: keyof typeof CAN): boolean => s !== null && CAN[screen]!.includes(s.me.role);
