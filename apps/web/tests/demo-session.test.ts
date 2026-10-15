// [unit] POST /staff/demo-session (lib/server/demo-session.ts): off unless MUNIM_DEMO_SIGNIN=1, the four keys only,
// the the dev host password grant for <key>@cobnut-demo.invalid, the local tokens file, and no secret in any refusal.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { demoSession, type DemoEnv } from "@/lib/server/demo-session";

const PASSWORD = "test-password-not-real";
const TENANT = "019a0c5e-7e11-7a00-8c0b-0000000c0b99";
const ask = (person: unknown) => new Request("http://web.test/staff/demo-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person }) });
const devhost: DemoEnv = {
  MUNIM_DEMO_SIGNIN: "1", MUNIM_DEMO_PASSWORD: PASSWORD, MUNIM_DEMO_TENANT_ID: TENANT,
  DEVHOST_PROJECT_URL: "https://project.example.test/", DEVHOST_PUBLISHABLE_KEY: "sb_publishable_test",
};
type Sent = { url: string; init: RequestInit };
const idp = (answer: Response) => {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return answer.clone(); }) as unknown as typeof fetch;
  return { f, sent };
};

describe("demo sign-in route", () => {
  it("answers 404 when MUNIM_DEMO_SIGNIN is not 1", async () => {
    for (const on of [undefined, "", "0", "true"]) expect((await demoSession(ask("owner"), { ...devhost, MUNIM_DEMO_SIGNIN: on })).status).toBe(404);
  });

  it("refuses anything but the four keys, without calling the IdP", async () => {
    const { f, sent } = idp(Response.json({ access_token: "never" }));
    for (const p of ["judge", "Owner", "owner ", "", null, 1, ["owner"], { key: "owner" }]) expect((await demoSession(ask(p), devhost, f)).status).toBe(400);
    expect(sent.length).toBe(0);
  });

  it("runs the dev host's password grant for <key>@cobnut-demo.invalid and returns the token and the demo business", async () => {
    for (const key of ["owner", "manager", "counter", "kitchen"]) {
      const { f, sent } = idp(Response.json({ access_token: `jwt-for-${key}`, refresh_token: "r" }));
      const r = await demoSession(ask(key), devhost, f);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ token: `jwt-for-${key}`, tenant_id: TENANT });
      expect(sent[0]!.url).toBe("https://project.example.test/auth/v1/token?grant_type=password");
      expect((sent[0]!.init.headers as Record<string, string>).apikey).toBe("sb_publishable_test");
      expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ email: `${key}@cobnut-demo.invalid`, password: PASSWORD });
    }
  });

  it("a refused grant or a missing setting is 503, and the answer never carries the password", async () => {
    const { f } = idp(Response.json({ error: "invalid_grant", password: PASSWORD }, { status: 400 }));
    const cases: [DemoEnv, typeof fetch][] = [[devhost, f], [{ ...devhost, MUNIM_DEMO_PASSWORD: undefined }, f], [{ ...devhost, MUNIM_DEMO_TENANT_ID: undefined }, f]];
    for (const [env, fetchImpl] of cases) {
      const r = await demoSession(ask("owner"), env, fetchImpl);
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
      const r = await demoSession(ask("manager"), local, f);
      expect(await r.json()).toEqual({ token: "local-manager", tenant_id: TENANT });
      expect(sent.length).toBe(0);
    });
    it("an empty token or a missing file is 503", async () => {
      expect((await demoSession(ask("kitchen"), local)).status).toBe(503);
      expect((await demoSession(ask("owner"), { ...local, MUNIM_DEMO_TOKENS: join(dir, "missing.json") })).status).toBe(503);
    });
  });
});
