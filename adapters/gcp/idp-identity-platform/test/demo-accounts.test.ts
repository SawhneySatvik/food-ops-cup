// demo-accounts + passwordGrant with an injected fetch standing in for Identity Platform: no network, synthetic
// keys only. Held: users are created verified with the one password (or found and reset on a second run), admin
// calls carry the metadata-server token and sign-ins carry only the web key, and no error carries a key, token,
// password or response body.
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_KEYS, DemoAccountError, demoEmail, demoPassword, ensureDemoAccounts, passwordGrant } from "../demo-accounts.ts";

const WEB_KEY = "synthetic-web-api-key";
const ADMIN = "synthetic-admin-access-token";
const PASSWORD = "synthetic-demo-password-0123456789";

function identityToolkit() {
  const users = new Map<string, { id: string; email: string; password: string }>();
  const calls: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: `${url.pathname}${url.search}`, auth: h.get("authorization"), body });
    const admin = h.get("authorization") === `Bearer ${ADMIN}`;
    if (url.pathname === "/v1/accounts:signInWithPassword") {
      const u = [...users.values()].find((x) => x.email === body.email && x.password === body.password);
      if (url.searchParams.get("key") !== WEB_KEY || !u) return json(400, { error: { message: "INVALID_LOGIN_CREDENTIALS " + String(body.password) } });
      return json(200, { idToken: `id-token-${u.id}`, refreshToken: "r", expiresIn: "3600" });
    }
    if (!admin) return json(401, {});
    if (url.pathname.endsWith("/accounts:lookup")) {
      const u = [...users.values()].find((x) => x.email === (body.email as string[])[0]);
      return json(200, u ? { users: [{ localId: u.id }] } : {});
    }
    if (url.pathname.endsWith("/accounts:update")) {
      const u = users.get(String(body.localId))!;
      u.password = String(body.password);
      return json(200, {});
    }
    if (url.pathname.endsWith("/accounts")) {
      const id = `u${users.size + 1}`;
      users.set(id, { id, email: String(body.email), password: String(body.password) });
      return json(200, { localId: id });
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { users, calls, fetch };
}

const opts = (fetch: typeof globalThis.fetch) => ({ projectId: "p1", webApiKey: WEB_KEY, password: PASSWORD, fetch, token: async () => ADMIN });

describe("ensureDemoAccounts", () => {
  it("creates the four users, then resets them on a second run", async () => {
    const s = identityToolkit();
    const t = await ensureDemoAccounts(opts(s.fetch));
    expect(Object.keys(t)).toEqual([...DEMO_KEYS]);
    expect([...s.users.values()].map((u) => u.email)).toEqual(DEMO_KEYS.map(demoEmail));
    expect(s.calls.filter((c) => c.path.endsWith("/accounts")).every((c) => c.body.emailVerified === true)).toBe(true);
    await ensureDemoAccounts({ ...opts(s.fetch), password: "rotated-password-xyz" });
    expect(s.users.size).toBe(4);
    expect([...s.users.values()].every((u) => u.password === "rotated-password-xyz")).toBe(true);
    expect(s.calls.some((c) => c.path.endsWith("/accounts:update"))).toBe(true);
  });

  it("sends the admin token only to admin routes", async () => {
    const s = identityToolkit();
    await ensureDemoAccounts(opts(s.fetch));
    for (const c of s.calls) expect(c.auth !== null).toBe(!c.path.includes("signInWithPassword"));
  });

  it("errors name the step and status, never a secret or body", async () => {
    const s = identityToolkit();
    const err = await ensureDemoAccounts({ ...opts(s.fetch), token: async () => "wrong" }).catch((e) => e);
    expect(err).toBeInstanceOf(DemoAccountError);
    expect(err.message).toBe("look up owner: HTTP 401");
  });
});

describe("passwordGrant", () => {
  it("returns the ID token on success", async () => {
    const s = identityToolkit();
    await ensureDemoAccounts(opts(s.fetch));
    const g = await passwordGrant({ apiKey: WEB_KEY, email: demoEmail("owner"), password: PASSWORD, fetch: s.fetch });
    expect(g).toEqual({ idToken: "id-token-u1", refreshToken: "r", expiresIn: 3600 });
  });

  it("failure carries the status only: no password, key or body", async () => {
    const s = identityToolkit();
    const err = await passwordGrant({ apiKey: WEB_KEY, email: "x@example.test", password: PASSWORD, fetch: s.fetch }).catch((e) => e);
    expect(err.message).toBe("sign in: HTTP 400");
    expect(err.message + String(err.stack)).not.toContain(PASSWORD);
    expect(err.message).not.toContain(WEB_KEY);
  });

  it("does not log on success or failure", async () => {
    const out: unknown[] = [];
    const [log, error, warn] = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a: unknown[]) => void out.push(a);
    try {
      const s = identityToolkit();
      await passwordGrant({ apiKey: "bad", email: "x@example.test", password: PASSWORD, fetch: s.fetch }).catch(() => {});
    } finally {
      Object.assign(console, { log, error, warn });
    }
    expect(out).toEqual([]);
  });
});

describe("demoPassword", () => {
  it("generates once, 0600, and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-pw-"));
    const a = demoPassword(dir);
    expect(a.password.length).toBeGreaterThanOrEqual(24);
    expect(statSync(a.file).mode & 0o777).toBe(0o600);
    expect(demoPassword(dir).password).toBe(a.password);
  });
});
