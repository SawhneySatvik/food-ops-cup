// R44a gates: MUNIM_IDP=local is refused in production / non-dev / for an unknown value (at the real entry point,
// exit code asserted), an unset MUNIM_IDP is refused unless a dev mapping supplies a default, /health reports the
// active IdP, and a server on another IdP 401s a local-IdP token. (The seed minter's refusal: seed-minter.test.ts.)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type DevEnv, resolveIdpMode } from "@munim/config";
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp, createPersistentLocalIdp } from "../src/auth/local-idp.ts";
import { createApp } from "../src/app.ts";
import { setIdpMode } from "../src/health/index.ts";
import type { Deps } from "../src/lib/types.ts";
import { openDb } from "./db.ts";

const SERVER = join(import.meta.dirname, "../src/server.ts");
const scratch = mkdtempSync(join(tmpdir(), "munim-idp-"));

/** Runs the real entry with no .env and a scratch run dir; a refusal must exit non-zero before it connects anywhere. */
function boot(env: Record<string, string>, args: string[] = []) {
  const e = { PATH: process.env.PATH ?? "", MUNIM_ENV_FILE: join(scratch, "no.env"), MUNIM_RUN_DIR: scratch, ...env };
  return spawnSync(process.execPath, [SERVER, ...args], { env: e, encoding: "utf8", timeout: 20_000 });
}

describe("MUNIM_IDP selector refusals", () => {
  // A dev mapping as a development checkout's adapters/dev supplies one: an extra value that is also the default.
  const dev = { idpModes: ["devmode"], idpDefault: "devmode" } as unknown as DevEnv;
  it("accepts exactly local|identity-platform in env and flag forms; unset is refused unless a dev mapping has a default", () => {
    expect(() => resolveIdpMode({}, [], null)).toThrow('MUNIM_IDP is not set: one of "local", "identity-platform"');
    expect(resolveIdpMode({}, [], dev)).toBe("devmode");
    expect(resolveIdpMode({ MUNIM_IDP: "identity-platform" }, [], null)).toBe("identity-platform");
    expect(resolveIdpMode({ MUNIM_IDP: "local", MUNIM_ENV: "dev" }, [], null)).toBe("local");
    expect(resolveIdpMode({ MUNIM_ENV: "dev" }, ["--idp=local"], null)).toBe("local");
    expect(resolveIdpMode({ MUNIM_ENV: "dev" }, ["--idp", "local"], null)).toBe("local");
    expect(resolveIdpMode({ MUNIM_IDP: "local", MUNIM_ENV: "dev" }, ["--idp=identity-platform"], null)).toBe("identity-platform");
    expect(() => resolveIdpMode({ MUNIM_IDP: "devmode" }, [], null)).toThrow(/exactly/); // a dev value without its mapping
  });
  it("refuses unknown values, production and a non-dev MUNIM_ENV", () => {
    for (const bad of ["Local", "", "local ", "none", "Identity-Platform"]) expect(() => resolveIdpMode({ MUNIM_IDP: bad }, [])).toThrow(/exactly/);
    expect(() => resolveIdpMode({}, ["--idp=bogus"])).toThrow(/exactly/);
    expect(() => resolveIdpMode({ MUNIM_IDP: "local", NODE_ENV: "production" }, [])).toThrow(/production/);
    expect(() => resolveIdpMode({ MUNIM_IDP: "local", MUNIM_ENV: "staging" }, [])).toThrow(/MUNIM_ENV/);
    expect(() => resolveIdpMode({ MUNIM_IDP: "local" }, [])).toThrow(/MUNIM_ENV/); // unset is not dev
  });
  it("core-api boot exits non-zero under NODE_ENV=production + MUNIM_IDP=local", () => {
    const r = boot({ MUNIM_IDP: "local", NODE_ENV: "production" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("core-api: failed to start");
    expect(r.stderr).toContain("refused when NODE_ENV=production");
    expect(r.stderr).not.toContain("DEV LOCAL SIGN-IN ENABLED");
  });
  it("core-api boot exits non-zero for an unknown MUNIM_IDP and an unknown --idp flag value", () => {
    const a = boot({ MUNIM_IDP: "okta" });
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('MUNIM_IDP must be exactly one of "local", "identity-platform"');
    expect(boot({}, ["--idp=okta"]).status).toBe(1);
  });
  it("a valid local boot announces itself loudly (then fails on the missing database, which is fine here)", () => {
    const r = boot({ MUNIM_IDP: "local", MUNIM_ENV: "dev" });
    expect(r.stderr).toContain("DEV LOCAL SIGN-IN ENABLED — not for real users");
  });
});

describe("persistent local signing key", () => {
  it("is generated once under the run dir with mode 0600 and shared by a second instance", async () => {
    const a = createPersistentLocalIdp(scratch);
    const file = join(scratch, "idp-local", "signing-key.pem");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const b = createPersistentLocalIdp(scratch);
    await expect(b.verify(a.sign({ sub: "s", email_verified: true }))).resolves.toMatchObject({ sub: "s" });
    await expect(createLocalIdp().verify(a.sign({ sub: "s" }))).rejects.toThrow();
  });
});

describe("/health idp and cross-mode rejection", () => {
  let db: TestDb;
  let pools: { core: pg.Pool; svc: pg.Pool };
  let otherDeps: Deps;
  let localDeps: Deps;
  let otherApp: Awaited<ReturnType<typeof createApp>>;
  let localApp: Awaited<ReturnType<typeof createApp>>;
  const local = createPersistentLocalIdp(scratch);
  beforeAll(async () => {
    db = await openDb();
    pools = { core: db.pool("munim_core", 2), svc: db.pool("munim_svc", 2) };
    const config = { nodeEnv: "test", redact: (s: string) => s };
    const mk = (idp: Deps["idp"]): Deps => ({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
    // The other server verifies with a different key (stands in for Identity Platform's JWKS), as a real one would.
    otherDeps = mk(createLocalIdp());
    setIdpMode(otherDeps, "identity-platform");
    localDeps = mk(local);
    setIdpMode(localDeps, "local");
    otherApp = await createApp(otherDeps);
    localApp = await createApp(localDeps);
  });
  afterAll(async () => {
    await Promise.allSettled([pools.core.end(), pools.svc.end()]);
    await db?.stop();
  });

  it("reports the active IdP", async () => {
    expect(await (await otherApp.request("/health")).json()).toMatchObject({ status: "ok", idp: "identity-platform" });
    expect(await (await localApp.request("/health")).json()).toMatchObject({ status: "ok", idp: "local" });
  });
  it("a server on another IdP rejects a local-IdP token (401); the local server accepts it past auth", async () => {
    const h = { Authorization: `Bearer ${local.sign({ sub: "x", email_verified: true })}` };
    expect((await otherApp.request("/v1/me/tenants", { headers: h })).status).toBe(401);
    expect((await localApp.request("/v1/me/tenants", { headers: h })).status).toBe(200);
  });
});
