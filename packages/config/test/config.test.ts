import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, createLogger, ENV_NAMES, loadConfig } from "../src/index.ts";

// Synthetic planted values — never real keys.
const PLANTED_PW = "pl4nted-Pw-7f3a9c";
const PLANTED_KEY = "pl4nted-gemini-key-0042";

describe("names", () => {
  it("ENV_NAMES is exactly the variable list of .env.example (read independently)", () => {
    const example = readFileSync(join(import.meta.dirname, "../../../.env.example"), "utf8");
    const names = [...example.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...ENV_NAMES].sort()).toEqual([...names].sort());
  });
});

describe("loading", () => {
  it("reads the env file by name, process env wins, unknown names ignored, defaults for internal settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    const file = join(dir, "planted.env");
    writeFileSync(file, `GEMINI_API_KEY=${PLANTED_KEY}\nDEVHOST_PROJECT_ID=fromfile\nNOT_A_MUNIM_NAME=x\n`);
    const cfg = loadConfig({ envFile: file, env: { DEVHOST_PROJECT_ID: "fromenv" } });
    expect(cfg.get("GEMINI_API_KEY")).toBe(PLANTED_KEY);
    expect(cfg.get("DEVHOST_PROJECT_ID")).toBe("fromenv");
    expect(cfg.modelMode).toBe("recorded");
    expect(cfg.port).toBe(8787);
    expect(() => cfg.require("NVIDIA_API_KEY")).toThrow(/NVIDIA_API_KEY is not set/);
    expect(() => loadConfig({ env: { MUNIM_MODEL_MODE: "liv" } })).toThrow(ConfigError);
  });

  it("MUNIM_CORS_ORIGINS is passed through trimmed, default empty", () => {
    expect(loadConfig({ env: {} }).corsOrigins).toBe("");
    expect(loadConfig({ env: { MUNIM_CORS_ORIGINS: "  https://a.example.test, https://b.example.test \n" } }).corsOrigins).toBe("https://a.example.test, https://b.example.test");
  });

  it("MUNIM_TRUSTED_PROXY_HOPS: a whole number 0–99, default 0; anything else is a ConfigError (gotcha 17)", () => {
    expect(loadConfig({ env: {} }).trustedProxyHops).toBe(0);
    expect(loadConfig({ env: { MUNIM_TRUSTED_PROXY_HOPS: "  " } }).trustedProxyHops).toBe(0);
    expect(loadConfig({ env: { MUNIM_TRUSTED_PROXY_HOPS: " 2 " } }).trustedProxyHops).toBe(2);
    expect(loadConfig({ env: { MUNIM_TRUSTED_PROXY_HOPS: "99" } }).trustedProxyHops).toBe(99);
    for (const bad of ["100", "-1", "1.5", "abc", "1e1", "0x1", "2 3"]) {
      expect(() => loadConfig({ env: { MUNIM_TRUSTED_PROXY_HOPS: bad } }), bad).toThrow(ConfigError);
    }
  });

  it("dbUrl logs in as the role on the transaction pooler", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ munim_core: "core-role-pw-1" }));
    const cfg = loadConfig({
      runDir: dir,
      env: {
        DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING: `postgresql://postgres.ref:${PLANTED_PW}@pooler.example.test:6543/postgres`,
        DEVHOST_PROJECT_ID: "ref",
      },
    });
    const u = new URL(cfg.dbUrl("munim_core"));
    expect([u.username, u.password, u.host, u.pathname]).toEqual(["munim_core.ref", "core-role-pw-1", "pooler.example.test:6543", "/postgres"]);
    expect(() => cfg.dbUrl("munim_svc")).toThrow(/no password for munim_svc/);
  });
});

describe(".run permissions (W1 fix #36)", () => {
  it("serviceSecret() creates .run as 0700 (and tightens an existing 0755 one); the secret file is 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "munim-config-"));
    const fresh = join(base, "fresh", ".run");
    const wide = join(base, "wide");
    mkdirSync(wide, { mode: 0o755 });
    for (const runDir of [fresh, wide]) {
      const cfg = loadConfig({ runDir, env: {} });
      expect(cfg.serviceSecret()).toMatch(/^[0-9a-f]{64}$/);
      expect([runDir, statSync(runDir).mode & 0o777]).toEqual([runDir, 0o700]);
      expect(statSync(join(runDir, "service-secret")).mode & 0o777).toBe(0o600);
    }
  });
});

describe("redaction gate", () => {
  it("a planted secret never appears in a thrown error's message or the logged line", () => {
    // A malformed connection string carrying the password: new URL() throws a TypeError whose `input`
    // property holds the whole string, and ConfigError keeps it as `cause` — the realistic leak path.
    const cfg = loadConfig({
      env: {
        DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING: `postgresql://postgres.ref:${PLANTED_PW}@[bad-host:6543/postgres`,
        DEVHOST_PROJECT_ID: "ref",
        GEMINI_API_KEY: PLANTED_KEY,
      },
    });
    let thrown: unknown;
    try {
      cfg.dbUrl("munim_core");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as Error).message;
    const lines: string[] = [];
    const log = createLogger(cfg, (l) => lines.push(l));
    log("config failed", thrown);
    log(`provider call failed with key ${PLANTED_KEY}`);

    // Positive quantities first: the error and both lines exist and show where a secret was removed.
    expect(message).toContain("[redacted:DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING]");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ConfigError");
    expect(lines[0]).toContain("TypeError"); // the cause was logged …
    expect(lines[0]!.match(/\[redacted:/g)?.length ?? 0).toBeGreaterThanOrEqual(2); // … with its input redacted
    expect(lines[1]).toContain("[redacted:GEMINI_API_KEY]");
    // Then the guarantee.
    for (const text of [message, ...lines]) {
      expect(text).not.toContain(PLANTED_PW);
      expect(text).not.toContain(PLANTED_KEY);
    }
  });

  it("a malformed .run/db-roles.json never echoes the role password it holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    const rolePw = "pl4nted-role-pw-55e1";
    // Unquoted value: V8's SyntaxError then quotes ~10 characters of it ("Unexpected token 'p', …").
    writeFileSync(join(dir, "db-roles.json"), `{"munim_core": ${rolePw}}`);
    const cfg = loadConfig({
      runDir: dir,
      env: { DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING: "postgresql://u:p@pooler.example.test:6543/postgres", DEVHOST_PROJECT_ID: "ref" },
    });
    let thrown: unknown;
    try {
      cfg.dbUrl("munim_core");
    } catch (e) {
      thrown = e;
    }
    const lines: string[] = [];
    createLogger(cfg, (l) => lines.push(l))("config failed", thrown);
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(/db-roles\.json is not valid JSON/);
    expect(lines).toHaveLength(1);
    for (const text of [(thrown as Error).message, ...lines]) expect(text).not.toContain(rolePw.slice(0, 8));
  });
});

describe("T-009 additions", () => {
  const pooler = (port: number) => `postgresql://postgres.ref:${PLANTED_PW}@pooler.example.test:${port}/postgres`;

  it("sessionDbUrl logs in as the role on the session pooler; m-1's {written_at, roles} file is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ written_at: "2026-10-10T00:00:00Z", roles: { munim_core: "core-role-pw-1", munim_svc: "svc-role-pw-2" } }));
    const cfg = loadConfig({
      runDir: dir,
      env: { DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING: pooler(6543), DEVHOST_SESSION_POOLER_CONNECTION_STRING: pooler(5432), DEVHOST_PROJECT_ID: "ref" },
    });
    const s = new URL(cfg.sessionDbUrl("munim_core"));
    const t = new URL(cfg.dbUrl("munim_svc"));
    expect([s.username, s.password, s.port]).toEqual(["munim_core.ref", "core-role-pw-1", "5432"]);
    expect([t.username, t.password, t.port]).toEqual(["munim_svc.ref", "svc-role-pw-2", "6543"]);
    // Both role passwords are registered for redaction once the file is read.
    expect(cfg.redact("a core-role-pw-1 b svc-role-pw-2")).toBe("a [redacted:munim_core password] b [redacted:munim_svc password]");
  });

  it("MUNIM_DATABASE_URL (local Postgres) replaces both poolers and logs in as the bare role", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ roles: { munim_core: "local-pw-1" } }));
    const cfg = loadConfig({ env: { MUNIM_DATABASE_URL: "postgresql://127.0.0.1:55432/munim", MUNIM_RUN_DIR: dir } });
    for (const u of [new URL(cfg.dbUrl("munim_core")), new URL(cfg.sessionDbUrl("munim_core"))]) {
      expect([u.username, u.password, u.host, u.pathname]).toEqual(["munim_core", "local-pw-1", "127.0.0.1:55432", "/munim"]);
    }
    expect(cfg.runDir).toBe(dir);
    expect(cfg.runTokenKeyDir).toBe(join(dir, "keys"));
  });

  it("intel URL defaults; the service secret is generated once under runDir and redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    const cfg = loadConfig({ runDir: dir, env: {} });
    expect(cfg.intelUrl).toBe("http://127.0.0.1:8081");
    expect(loadConfig({ env: { MUNIM_INTEL_URL: "http://intel.example.test" } }).intelUrl).toBe("http://intel.example.test");
    const secret = cfg.serviceSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, "service-secret"), "utf8").trim()).toBe(secret);
    expect(loadConfig({ runDir: dir, env: {} }).serviceSecret()).toBe(secret);
    expect(cfg.redact(`x ${secret} y`)).toBe("x [redacted:service secret] y");
  });
});

describe("registerRunSecrets", () => {
  it("registers role passwords, the service secret and the private key lines found under runDir; creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    const empty = loadConfig({ runDir: dir, env: {} });
    expect(empty.registerRunSecrets()).toBe(0);
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ roles: { munim_core: "run-secret-role-1" } }));
    writeFileSync(join(dir, "service-secret"), "run-secret-service-2\n");
    const cfg = loadConfig({ runDir: dir, env: {} });
    expect(cfg.registerRunSecrets()).toBe(2);
    expect(cfg.redact("run-secret-role-1 run-secret-service-2")).toBe("[redacted:munim_core password] [redacted:service secret]");
  });
});

// Lane B2 (serverless deploy): a host with a read-only, per-instance filesystem boots from env alone.
describe("env-only config (envOnly: true)", () => {
  const PRIV = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPl4ntedPrivKeyBodyLine0000000000000000\n-----END PRIVATE KEY-----";
  const PUB = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPl4ntedPubKeyBodyLine00000000000000000000\n-----END PUBLIC KEY-----";
  const dirWithRunFiles = () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ roles: { munim_core: "file-pw-should-not-be-read" } }));
    writeFileSync(join(dir, "service-secret"), "file-secret-should-not-be-read-000\n");
    return dir;
  };

  it("reads role passwords, service secret and run-token PEMs from env; never the files under runDir", () => {
    const dir = dirWithRunFiles();
    const cfg = loadConfig({
      runDir: dir, envOnly: true,
      env: {
        MUNIM_DATABASE_URL: "postgresql://127.0.0.1:55432/munim", MUNIM_DB_PASSWORD_MUNIM_CORE: "env-core-pw-1",
        MUNIM_SERVICE_SECRET: "env-service-secret-0123456789", MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM: PRIV.replaceAll("\n", "\\n"),
        MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM: PUB,
      },
    });
    expect(new URL(cfg.dbUrl("munim_core")).password).toBe("env-core-pw-1");
    expect(() => cfg.dbUrl("munim_svc")).toThrow(/no password for munim_svc/);
    expect(cfg.serviceSecret()).toBe("env-service-secret-0123456789");
    const pems = cfg.runTokenKeyPems()!;
    expect(pems.privateKeyPem).toBe(`${PRIV}\n`); // the literal "\n" form is unescaped
    expect(pems.publicKeyPem).toBe(`${PUB}\n`);
    expect(cfg.redact("x MC4CAQAwBQYDK2VwBCIEIPl4ntedPrivKeyBodyLine0000000000000000 y")).toBe("x [redacted:run-token private key] y");
    expect(cfg.redact("env-core-pw-1 env-service-secret-0123456789")).toBe("[redacted:munim_core password] [redacted:service secret]");
  });

  it("a missing secret is a ConfigError, and nothing is generated or written under runDir", () => {
    const dir = dirWithRunFiles();
    const cfg = loadConfig({ runDir: dir, envOnly: true, env: { MUNIM_DATABASE_URL: "postgresql://127.0.0.1:55432/munim" } });
    expect(() => cfg.serviceSecret()).toThrow(/MUNIM_SERVICE_SECRET is not set/);
    expect(() => cfg.runTokenKeyPems()).toThrow(/MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM and MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM are not set/);
    expect(() => cfg.dbUrl("munim_core")).toThrow(/no password for munim_core/); // the file's password is not read
    const fresh = mkdtempSync(join(tmpdir(), "munim-config-"));
    expect(() => loadConfig({ runDir: fresh, envOnly: true, env: {} }).serviceSecret()).toThrow(ConfigError);
    expect(readdirSync(fresh)).toEqual([]);
  });

  it("without envOnly the files still work, env wins over them, and one PEM alone is refused", () => {
    const dir = dirWithRunFiles();
    const cfg = loadConfig({ runDir: dir, env: { MUNIM_DATABASE_URL: "postgresql://127.0.0.1:55432/munim" } });
    expect(new URL(cfg.dbUrl("munim_core")).password).toBe("file-pw-should-not-be-read");
    expect(cfg.serviceSecret()).toBe("file-secret-should-not-be-read-000");
    expect(cfg.runTokenKeyPems()).toBeNull();
    const env = loadConfig({ runDir: dir, env: { MUNIM_DATABASE_URL: "postgresql://127.0.0.1:55432/munim", MUNIM_DB_PASSWORD_MUNIM_CORE: "env-wins-pw" } });
    expect(new URL(env.dbUrl("munim_core")).password).toBe("env-wins-pw");
    expect(() => loadConfig({ env: { MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM: PUB } }).runTokenKeyPems()).toThrow(/both .* or neither/);
  });

  it("cron secret, stream max age, pool ceiling and tick settings: defaults, bounds, refusals (gotcha 17)", () => {
    const d = loadConfig({ env: {} });
    expect([d.cronSecret(), d.streamMaxAgeMs, d.dbPoolMax, d.tickPeriodMinutes, d.tickBudgetMs]).toEqual([null, 3_300_000, undefined, 1440, 240_000]);
    const s = loadConfig({ env: { MUNIM_CRON_SECRET: "cron-secret-0123456789", MUNIM_STREAM_MAX_AGE_S: "270", MUNIM_DB_POOL_MAX: "3", MUNIM_TICK_PERIOD_MIN: "15", MUNIM_TICK_BUDGET_S: "60" } });
    expect([s.cronSecret(), s.streamMaxAgeMs, s.dbPoolMax, s.tickPeriodMinutes, s.tickBudgetMs]).toEqual(["cron-secret-0123456789", 270_000, 3, 15, 60_000]);
    expect(s.redact("cron-secret-0123456789")).toBe("[redacted:cron secret]");
    expect(() => loadConfig({ env: { MUNIM_CRON_SECRET: "short" } }).cronSecret()).toThrow(/at least 16/);
    for (const [name, bad] of [["MUNIM_STREAM_MAX_AGE_S", "9"], ["MUNIM_STREAM_MAX_AGE_S", "270s"], ["MUNIM_DB_POOL_MAX", "2"], ["MUNIM_DB_POOL_MAX", "51"],
      ["MUNIM_TICK_PERIOD_MIN", "1441"], ["MUNIM_TICK_BUDGET_S", "1.5"], ["MUNIM_TICK_BUDGET_S", "-1"]] as const) {
      expect(() => loadConfig({ env: { [name]: bad } }), `${name}=${bad}`).toThrow(ConfigError);
    }
  });
});
