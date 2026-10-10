// R44a gates: MUNIM_IDP=local is refused in production / non-dev / for an unknown value (at the real entry point,
// exit code asserted), /health reports the active IdP, a devhost-mode server 401s a local-IdP token, and
// worldgen refuses to self-mint against a devhost-mode server.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, resolveIdpMode } from "@munim/config";
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp, createPersistentLocalIdp } from "../../../adapters/dev/idp-local/index.ts";
import { createApp } from "../src/app.ts";
import { serveApi } from "../src/server.ts";
import { setIdpMode } from "../src/health/index.ts";
import type { Deps } from "../src/lib/types.ts";
import { openDb } from "./db.ts";

const SERVER = join(import.meta.dirname, "../src/server.ts");
const MINTER = join(import.meta.dirname, "../../../adapters/dev/idp-local/mint-seed-tokens.ts");
const ROOT = join(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "munim-idp-"));

/** Runs the real entry with no .env and a scratch run dir; a refusal must exit non-zero before it connects anywhere. */
function boot(env: Record<string, string>, args: string[] = []) {
  const e = { PATH: process.env.PATH ?? "", MUNIM_ENV_FILE: join(scratch, "no.env"), MUNIM_RUN_DIR: scratch, ...env };
  return spawnSync(process.execPath, [SERVER, ...args], { env: e, encoding: "utf8", timeout: 20_000 });
}

describe("MUNIM_IDP selector refusals", () => {
  it("defaults to devhost and accepts exactly local|devhost in env and flag forms", () => {
    expect(resolveIdpMode({}, [])).toBe("devhost");
    expect(resolveIdpMode({ MUNIM_IDP: "local", MUNIM_ENV: "dev" }, [])).toBe("local");
    expect(resolveIdpMode({ MUNIM_ENV: "dev" }, ["--idp=local"])).toBe("local");
    expect(resolveIdpMode({ MUNIM_ENV: "dev" }, ["--idp", "local"])).toBe("local");
    expect(resolveIdpMode({ MUNIM_IDP: "local", MUNIM_ENV: "dev" }, ["--idp=devhost"])).toBe("devhost");
  });
  it("refuses unknown values, production and a non-dev MUNIM_ENV", () => {
    for (const bad of ["Local", "", "local ", "none"]) expect(() => resolveIdpMode({ MUNIM_IDP: bad }, [])).toThrow(/exactly/);
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
    expect(a.stderr).toContain('must be exactly "local" or "devhost"');
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
  let devhostDeps: Deps;
  let localDeps: Deps;
  let devhostApp: Awaited<ReturnType<typeof createApp>>;
  let localApp: Awaited<ReturnType<typeof createApp>>;
  const local = createPersistentLocalIdp(scratch);
  beforeAll(async () => {
    db = await openDb();
    pools = { core: db.pool("munim_core", 2), svc: db.pool("munim_svc", 2) };
    const config = { nodeEnv: "test", redact: (s: string) => s };
    const mk = (idp: Deps["idp"]): Deps => ({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
    // The "devhost" server verifies with a different key (stands in for the dev host's JWKS), as a real one would.
    devhostDeps = mk(createLocalIdp());
    localDeps = mk(local);
    setIdpMode(localDeps, "local");
    devhostApp = await createApp(devhostDeps);
    localApp = await createApp(localDeps);
  });
  afterAll(async () => {
    await Promise.allSettled([pools.core.end(), pools.svc.end()]);
    await db?.stop();
  });

  it("reports the active IdP", async () => {
    expect(await (await devhostApp.request("/health")).json()).toMatchObject({ status: "ok", idp: "devhost" });
    expect(await (await localApp.request("/health")).json()).toMatchObject({ status: "ok", idp: "local" });
  });
  it("a devhost-mode server rejects an idp-local token (401); the local server accepts it past auth", async () => {
    const h = { Authorization: `Bearer ${local.sign({ sub: "x", email_verified: true })}` };
    expect((await devhostApp.request("/v1/me/tenants", { headers: h })).status).toBe(401);
    expect((await localApp.request("/v1/me/tenants", { headers: h })).status).toBe(200);
  });
  it("worldgen refuses to self-mint against a devhost-mode server, and mints against a local one", async () => {
    const listen = async (app: Awaited<ReturnType<typeof createApp>>) => {
      const { port, server } = await serveApi(app, 0);
      return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
    };
    const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((ok) => {
      const p = spawn(args[0] === "make" ? "make" : process.execPath, args[0] === "make" ? args.slice(1) : args, { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MUNIM_RUN_DIR: scratch, ...env } });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => ok({ code, out, err }));
    });
    const sup = await listen(devhostApp);
    const loc = await listen(localApp);
    try {
      const m1 = await run([MINTER, "--world=store", `--url=${sup.url}`, `--run-dir=${scratch}`]);
      expect(m1.code).toBe(1);
      expect(m1.out).toBe("");
      expect(m1.err).toContain('not "local"');
      // `make seed` with no tokens: the minter runs first; its refusal stops the seed before worldgen starts.
      const w = await run(["make", "-C", ROOT, "seed", "WORLD=store", `RUN=${scratch}`], { MUNIM_API_URL: sup.url });
      expect(w.code).not.toBe(0);
      expect(w.err).toContain('not "local"');
      expect(w.err).toContain("none can be minted");
      expect(w.out).not.toContain("worldgen:");
      const m2 = await run([MINTER, "--world=store", `--url=${loc.url}`, `--run-dir=${scratch}`]);
      expect(m2.code).toBe(0);
      const tok = (JSON.parse(m2.out) as { owner: string }).owner;
      await expect(local.verify(tok)).resolves.toMatchObject({ sub: "worldgen-store-owner", email_verified: true });
    } finally {
      sup.close();
      loc.close();
    }
  });
});
