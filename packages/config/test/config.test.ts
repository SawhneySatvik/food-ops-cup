import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, createLogger, type DevEnv, devEnv, ENV_NAMES, loadConfig } from "../src/index.ts";

// Synthetic planted values — never real keys.
const PLANTED_PW = "pl4nted-Pw-7f3a9c";
const PLANTED_KEY = "pl4nted-gemini-key-0042";

describe("names", () => {
  it(".env.example (read independently) lists exactly ENV_NAMES, a dev mapping's names standing in for the ones it aliases", () => {
    const example = readFileSync(join(import.meta.dirname, "../../../.env.example"), "utf8");
    const names = [...example.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(3);
    const expected = devEnv ? [...ENV_NAMES.filter((n) => !devEnv!.aliases[n]), ...devEnv.names] : [...ENV_NAMES];
    expect([...expected].sort()).toEqual([...names].sort());
  });
});

// A dev mapping of the shape adapters/dev/env provides in a development checkout, with neutral test names. Tests whose
// outcome depends on the mapping pass `dev` explicitly (this one or null), so they hold with or without adapters/dev.
const OTHER_PW = "pl4nted-Pw-other-1b2c";
const fakeDev: DevEnv = {
  names: ["OTHER_SESSION_URL", "OTHER_TRANSACTION_URL", "OTHER_PROJECT"],
  secretNames: ["OTHER_SESSION_URL", "OTHER_TRANSACTION_URL"],
  aliases: { MUNIM_DB_URL_SESSION: "OTHER_SESSION_URL", MUNIM_DB_URL_TRANSACTION: "OTHER_TRANSACTION_URL" },
  dbUser: (role, cfg) => `${role}.${cfg.require("OTHER_PROJECT")}`,
  idpModes: ["devmode"],
  idpDefault: "devmode",
  blobModes: ["devstore"],
  adapter: (kind, mode) => ({ kind, mode }),
};

describe("a dev mapping", () => {
  const other = (port: number) => `postgresql://postgres.ref:${OTHER_PW}@pooler.example.test:${port}/postgres`;
  it("its names stand in for the neutral ones; a role on an aliased URL logs in by its rule, on a neutral URL as itself", () => {
    const env = { OTHER_TRANSACTION_URL: other(6543), OTHER_PROJECT: "ref", MUNIM_DB_PASSWORD_MUNIM_CORE: "core-pw" };
    const cfg = loadConfig({ env, dev: fakeDev });
    expect(cfg.get("MUNIM_DB_URL_TRANSACTION")).toBe(other(6543));
    expect(new URL(cfg.dbUrl("munim_core")).username).toBe("munim_core.ref");
    const neutral = loadConfig({ env: { MUNIM_DB_URL_TRANSACTION: other(6543), OTHER_PROJECT: "ref", MUNIM_DB_PASSWORD_MUNIM_CORE: "core-pw" }, dev: fakeDev });
    expect(new URL(neutral.dbUrl("munim_core")).username).toBe("munim_core");
    expect(cfg.redact(`x ${OTHER_PW} y`)).toMatch(/^x \[redacted:(MUNIM_DB_URL_TRANSACTION|OTHER_TRANSACTION_URL)\] y$/);
  });
  it("a neutral name and its dev name both set and different: refused, naming both and never a value", () => {
    let thrown: unknown;
    try {
      loadConfig({ env: { MUNIM_DB_URL_SESSION: other(5432), OTHER_SESSION_URL: other(6543) }, dev: fakeDev });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toBe("MUNIM_DB_URL_SESSION and OTHER_SESSION_URL are both set and differ — set one");
    expect((thrown as Error).message).not.toContain(OTHER_PW);
    expect(loadConfig({ env: { MUNIM_DB_URL_SESSION: other(5432), OTHER_SESSION_URL: other(5432) }, dev: fakeDev }).get("MUNIM_DB_URL_SESSION")).toBe(other(5432));
  });
  it("its modes and adapters exist only with it", () => {
    const cfg = loadConfig({ env: { MUNIM_BLOB: "devstore" }, dev: fakeDev });
    expect([cfg.blob, cfg.devAdapter("blob", "devstore"), cfg.devAdapter("idp", "devmode")]).toEqual(["devstore", { kind: "blob", mode: "devstore" }, { kind: "idp", mode: "devmode" }]);
    expect(() => cfg.devAdapter("blob", "gcs")).toThrow(/no blob adapter "gcs"/);
    expect(() => loadConfig({ env: { MUNIM_BLOB: "devstore" }, dev: null })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, dev: null }).devAdapter("idp", "devmode")).toThrow(/no idp adapter "devmode" in this build/);
  });
});

describe("loading", () => {
  it("reads the env file by name, process env wins, unknown names ignored, defaults for internal settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    const file = join(dir, "planted.env");
    writeFileSync(file, `GEMINI_API_KEY=${PLANTED_KEY}\nMUNIM_DB_URL_SESSION=postgres://file.example.test/m\nNOT_A_MUNIM_NAME=x\n`);
    const cfg = loadConfig({ envFile: file, env: { MUNIM_DB_URL_SESSION: "postgres://env.example.test/m" }, dev: null });
    expect(cfg.get("GEMINI_API_KEY")).toBe(PLANTED_KEY);
    expect(cfg.get("MUNIM_DB_URL_SESSION")).toBe("postgres://env.example.test/m");
    expect(cfg.get("NOT_A_MUNIM_NAME")).toBeUndefined();
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

  it("dbUrl logs in as the role on MUNIM_DB_URL_TRANSACTION", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ munim_core: "core-role-pw-1" }));
    const cfg = loadConfig({
      runDir: dir,
      env: { MUNIM_DB_URL_TRANSACTION: `postgresql://postgres:${PLANTED_PW}@db.example.test:6543/postgres` },
    });
    const u = new URL(cfg.dbUrl("munim_core"));
    expect([u.username, u.password, u.host, u.pathname]).toEqual(["munim_core", "core-role-pw-1", "db.example.test:6543", "/postgres"]);
    expect(() => cfg.dbUrl("munim_svc")).toThrow(/no password for munim_svc/);
    expect(() => loadConfig({ env: {}, dev: null }).dbUrl("munim_core")).toThrow("MUNIM_DB_URL_TRANSACTION is not set");
  });

  it("MUNIM_IDP_PROJECT_ID: a project id or a ConfigError, read only when asked", () => {
    expect(loadConfig({ env: { MUNIM_IDP_PROJECT_ID: " munim-cup-2026 " } }).idpProjectId()).toBe("munim-cup-2026");
    for (const bad of [undefined, "", "Munim", "ab", "x".repeat(31), "1abcdef", "abcdef-"]) {
      expect(() => loadConfig({ env: { MUNIM_IDP_PROJECT_ID: bad } }).idpProjectId(), String(bad)).toThrow(/MUNIM_IDP_PROJECT_ID/);
    }
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
        MUNIM_DB_URL_TRANSACTION: `postgresql://postgres.ref:${PLANTED_PW}@[bad-host:6543/postgres`,
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
    expect(message).toContain("[redacted:MUNIM_DB_URL_TRANSACTION]");
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
      env: { MUNIM_DB_URL_TRANSACTION: "postgresql://u:p@pooler.example.test:6543/postgres" },
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

  it("sessionDbUrl logs in as the role on MUNIM_DB_URL_SESSION; m-1's {written_at, roles} file is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "munim-config-"));
    writeFileSync(join(dir, "db-roles.json"), JSON.stringify({ written_at: "2026-10-10T00:00:00Z", roles: { munim_core: "core-role-pw-1", munim_svc: "svc-role-pw-2" } }));
    const cfg = loadConfig({ runDir: dir, env: { MUNIM_DB_URL_TRANSACTION: pooler(6543), MUNIM_DB_URL_SESSION: pooler(5432) } });
    const s = new URL(cfg.sessionDbUrl("munim_core"));
    const t = new URL(cfg.dbUrl("munim_svc"));
    expect([s.username, s.password, s.port]).toEqual(["munim_core", "core-role-pw-1", "5432"]);
    expect([t.username, t.password, t.port]).toEqual(["munim_svc", "svc-role-pw-2", "6543"]);
    // The admin password inside each URL is a secret too (the Cloud SQL runbook puts one in MUNIM_DB_URL_SESSION).
    expect(cfg.redact(`a ${PLANTED_PW} b`)).toBe("a [redacted:MUNIM_DB_URL_SESSION] b");
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

  it("blob store: MUNIM_BLOB defaults to fs, takes exactly fs|gcs (or a dev mapping's mode); the bucket is read only when asked and must be a bucket name", () => {
    const d = loadConfig({ env: {} });
    expect(d.blob).toBe("fs");
    expect(() => d.blobBucket()).toThrow(/MUNIM_BLOB_BUCKET is not set/);
    expect(loadConfig({ env: { MUNIM_BLOB: "gcs", MUNIM_BLOB_BUCKET: "munim-uploads" } }).blobBucket()).toBe("munim-uploads");
    expect(loadConfig({ env: { MUNIM_BLOB: " gcs " } }).blob).toBe("gcs");
    for (const bad of ["s3", "GCS", "fs,gcs", "--blob=gcs", "devstore"]) {
      expect(() => loadConfig({ env: { MUNIM_BLOB: bad }, dev: null }), bad).toThrow(ConfigError);
    }
    for (const bad of ["ab", "Munim", "-x-", "a/b", "x".repeat(64)]) {
      expect(() => loadConfig({ env: { MUNIM_BLOB_BUCKET: bad } }).blobBucket(), bad).toThrow(ConfigError);
    }
  });
});
