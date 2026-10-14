// file: lib/munim/session.ts
// The session seam: who is signed in, in which business, and the staff client for them. Two ways in:
//   - the mock: the "Demo sign-in" picker with three invented people, each with a public mock token;
//   - the real API: an IdP ID token (the founder sends the IdP details later) -> GET /v1/me/tenants -> GET /v1/me.
// The session lives in sessionStorage only (never localStorage, a URL or a log). Plain TypeScript, no React.
import { createMunimClient as createSdkClient } from "@munim/sdk";
import { settle, type Result } from "./client";
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
}

/** The mock's business. Public test values, like the storefront key; the real API never accepts them. */
export const DEMO_TENANT_ID = "019a0c5e-7e11-7a00-8c0b-0000000c0b17";

export interface DemoPerson {
  key: "owner" | "counter" | "kitchen";
  /** Shown on the picker card, then replaced by GET /v1/me's name once signed in. */
  name: string;
  role: Role;
  /** What the card says the person does. */
  blurb: string;
  /** Where the person lands after signing in. */
  home: string;
  token: string;
}

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  { key: "owner", name: "Nandini Mehrotra (demo)", role: "owner", blurb: "Owner · both outlets", home: "/staff/home", token: "mock_member_owner_c0b1_7f2e9a14" },
  { key: "counter", name: "Imran Siddiqui (demo)", role: "staff", blurb: "Counter · Cobnut Hazratganj", home: "/staff/counter", token: "mock_member_counter_c0b1_3b8d5e60" },
  { key: "kitchen", name: "Kavya Tandon (demo)", role: "staff", blurb: "Kitchen · Cobnut Hazratganj", home: "/staff/kitchen", token: "mock_member_kitchen_c0b1_91c4a2d7" },
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
export async function signInWith(baseUrl: string, token: string, tenantId: string, demo: boolean): Promise<Result<Session>> {
  const me = await clientFor(baseUrl, { token, tenantId }).getMe();
  if (!me.ok) return me;
  const session: Session = { token, tenantId, me: me.data, demo };
  writeSession(session);
  return { ok: true, status: me.status, data: session, replayed: false };
}

/** The mock's "Demo sign-in" picker. */
export const signInDemo = (baseUrl: string, person: DemoPerson): Promise<Result<Session>> => signInWith(baseUrl, person.token, DEMO_TENANT_ID, true);

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
};
export const can = (s: Session | null, screen: keyof typeof CAN): boolean => s !== null && CAN[screen]!.includes(s.me.role);
