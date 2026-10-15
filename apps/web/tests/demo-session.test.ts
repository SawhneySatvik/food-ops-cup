// [unit] POST /staff/demo-session (lib/server/demo-session.ts): off unless MUNIM_DEMO_SIGNIN=1, the four keys only,
// Identity Platform's password grant for <key>@cobnut-demo.invalid, the local tokens file, a dev checkout's own grant
// (passed in), an unset MUNIM_IDP without one is 503, and no secret in any refusal.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { demoSession, type DemoEnv } from "@/lib/server/demo-session";
import type { DevSignin } from "@/lib/server/no-dev/web-signin";

const PASSWORD = "test-password-not-real";
const TENANT = "019a0c5e-7e11-7a00-8c0b-0000000c0b99";
const ask = (person: unknown) => new Request("http://web.test/staff/demo-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person }) });
const API_KEY = "web-api-key-for-tests";
const gcp: DemoEnv = {
  MUNIM_DEMO_SIGNIN: "1", MUNIM_IDP: "identity-platform", MUNIM_IDP_WEB_API_KEY: API_KEY, MUNIM_DEMO_PASSWORD: PASSWORD, MUNIM_DEMO_TENANT_ID: TENANT,
};
type Sent = { url: string; init: RequestInit };
const idp = (answer: Response) => {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return answer.clone(); }) as unknown as typeof fetch;
  return { f, sent };
};

describe("demo sign-in route", () => {
  it("answers 404 when MUNIM_DEMO_SIGNIN is not 1", async () => {
    for (const on of [undefined, "", "0", "true"]) expect((await demoSession(ask("owner"), { ...gcp, MUNIM_DEMO_SIGNIN: on }, fetch, null)).status).toBe(404);
  });

  it("refuses anything but the four keys, without calling the IdP", async () => {
    const { f, sent } = idp(Response.json({ idToken: "never" }));
    for (const p of ["judge", "Owner", "owner ", "", null, 1, ["owner"], { key: "owner" }]) expect((await demoSession(ask(p), gcp, f, null)).status).toBe(400);
    expect(sent.length).toBe(0);
  });

  it("runs Identity Platform's password grant for <key>@cobnut-demo.invalid and returns the token and the demo business", async () => {
    for (const key of ["owner", "manager", "counter", "kitchen"]) {
      const { f, sent } = idp(Response.json({ idToken: `jwt-for-${key}`, refreshToken: "r", expiresIn: "3600" }));
      const r = await demoSession(ask(key), gcp, f, null);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ token: `jwt-for-${key}`, tenant_id: TENANT });
      expect(sent[0]!.url).toBe(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`);
      expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ email: `${key}@cobnut-demo.invalid`, password: PASSWORD, returnSecureToken: true });
    }
  });

  it("a dev checkout's own grant serves its mode and an unset MUNIM_IDP; without one, unset is 503", async () => {
    const asked: string[] = [];
    const dev: DevSignin = { mode: "devmode", grant: async (login) => (asked.push(login.email), `dev-token-${login.email}`) };
    const unset: DemoEnv = { MUNIM_DEMO_SIGNIN: "1", MUNIM_DEMO_PASSWORD: PASSWORD, MUNIM_DEMO_TENANT_ID: TENANT };
    expect(await (await demoSession(ask("owner"), unset, fetch, dev)).json()).toEqual({ token: "dev-token-owner@cobnut-demo.invalid", tenant_id: TENANT });
    expect((await demoSession(ask("owner"), { ...unset, MUNIM_IDP: "devmode" }, fetch, dev)).status).toBe(200);
    expect((await demoSession(ask("owner"), unset, fetch, null)).status).toBe(503);
    expect((await demoSession(ask("owner"), { ...unset, MUNIM_IDP: "okta" }, fetch, dev)).status).toBe(503);
    expect(asked).toEqual(["owner@cobnut-demo.invalid", "owner@cobnut-demo.invalid"]);
  });

  it("a refused grant or a missing setting is 503, and the answer never carries the password", async () => {
    const { f } = idp(Response.json({ error: { message: "INVALID_PASSWORD", password: PASSWORD } }, { status: 400 }));
    const cases: [DemoEnv, typeof fetch][] = [[gcp, f], [{ ...gcp, MUNIM_DEMO_PASSWORD: undefined }, f], [{ ...gcp, MUNIM_DEMO_TENANT_ID: undefined }, f],
      [{ ...gcp, MUNIM_IDP_WEB_API_KEY: undefined }, f]];
    for (const [env, fetchImpl] of cases) {
      const r = await demoSession(ask("owner"), env, fetchImpl, null);
      expect(r.status).toBe(503);
      expect(await r.text()).not.toContain(PASSWORD);
    }
  });

  describe("MUNIM_IDP=local reads the tokens file", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-tokens-"));
    const file = join(dir, "tokens.json");
    writeFileSync(file, JSON.stringify({ owner: "local-owner", manager: "local-manager", counter: "local-counter", kitchen: "" }));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const local: DemoEnv = { MUNIM_DEMO_SIGNIN: "1", MUNIM_IDP: "local", MUNIM_DEMO_TOKENS: file, MUNIM_DEMO_TENANT_ID: TENANT };

    it("returns the person's token without calling any IdP", async () => {
      const { f, sent } = idp(Response.json({}));
      const r = await demoSession(ask("manager"), local, f, null);
      expect(await r.json()).toEqual({ token: "local-manager", tenant_id: TENANT });
      expect(sent.length).toBe(0);
    });
    it("an empty token or a missing file is 503", async () => {
      expect((await demoSession(ask("kitchen"), local, fetch, null)).status).toBe(503);
      expect((await demoSession(ask("owner"), { ...local, MUNIM_DEMO_TOKENS: join(dir, "missing.json") }, fetch, null)).status).toBe(503);
    });
  });
});
