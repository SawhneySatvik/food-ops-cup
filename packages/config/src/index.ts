// The one config module. Loads an env file (`.env`) by the names in ENV_NAMES, holds Munim-internal settings
// (defaults in code, generated files under `.run/`), and redacts every secret value from error messages and log
// lines. Gates never need an env file: they pass `env` directly.
//
// Every name here is provider-neutral. A development checkout may add a dev mapping (`devEnv` below): its own
// variable names for the same settings, extra MUNIM_IDP / MUNIM_BLOB values and their adapters. It is loaded when its
// file exists and is absent from a build without the dev adapters. A neutral name and the dev name that stands in
// for it may not both be set to different values.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect, parseEnv } from "node:util";

/** The names an env file may hold (`.env.example` lists them). Every other setting comes from the process environment. */
export const ENV_NAMES = [
  "GEMINI_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "MUNIM_DB_URL_SESSION",
  "MUNIM_DB_URL_TRANSACTION",
] as const;
export type EnvName = (typeof ENV_NAMES)[number];

/** Values never shown: the provider keys, and the database URLs, which may carry a password. */
const SECRET_NAMES: readonly string[] = ENV_NAMES;

export type ModelMode = "recorded" | "live";
/** Where uploaded documents' bytes live: "fs" (a local directory), "gcs" (a Cloud Storage bucket), or a dev mode. */
export type BlobMode = string;
const BLOB_MODES: readonly string[] = ["fs", "gcs"];
/** Which IdP core-api verifies against: "local" (dev only), "identity-platform", or a dev mode. */
export type IdpMode = string;
const IDP_MODES: readonly string[] = ["local", "identity-platform"];
export type DbRole = "munim_core" | "munim_svc" | "munim_platform";
const DB_ROLES: readonly DbRole[] = ["munim_core", "munim_svc", "munim_platform"];
const quoted = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

/** A dev mapping. Everything it adds is keyed by its own variable names. */
export interface DevEnv {
  /** Its variable names, read from the env file and the process environment like ENV_NAMES. */
  names: readonly string[];
  /** Those whose values are secrets (a URL's password is registered too). */
  secretNames: readonly string[];
  /** A neutral name -> the dev name that may stand in for it. */
  aliases: Readonly<Partial<Record<EnvName, string>>>;
  /** A runtime role's login name on a database URL that came from an alias. */
  dbUser(role: DbRole, cfg: Config): string;
  /** Extra MUNIM_IDP values; `idpDefault` applies when MUNIM_IDP is unset. */
  idpModes: readonly string[];
  idpDefault: string;
  /** Extra MUNIM_BLOB values. */
  blobModes: readonly string[];
  /** The adapter for one of its modes (the composition root that asks knows the port's type). */
  adapter(kind: "idp" | "blob", mode: string, cfg: Config): unknown;
}

// Computed, so that no type checker or bundler follows it into a checkout that lacks the file.
const DEV_ENV = new URL(["..", "..", "..", "adapters", "dev", "env", "index.ts"].join("/"), import.meta.url);
/** This checkout's dev mapping, or null. */
export const devEnv: DevEnv | null = existsSync(DEV_ENV) ? ((await import(DEV_ENV.href)) as { devEnv: DevEnv }).devEnv : null;

export interface Config {
  nodeEnv: string;
  port: number;
  modelMode: ModelMode;
  /** An env-file setting by its ENV_NAMES name (or a dev mapping's name); undefined when unset or empty. */
  get(name: EnvName | (string & {})): string | undefined;
  /** Like get(), but throws a ConfigError naming the variable (never its value) when unset. */
  require(name: EnvName | (string & {})): string;
  /**
   * App-pool connection string for a runtime role (03-arch §1.2): MUNIM_DB_URL_TRANSACTION's host, port and database,
   * logged in as the role with its password (`MUNIM_DB_PASSWORD_<ROLE>`, else `.run/db-roles.json`).
   */
  dbUrl(role: DbRole): string;
  /**
   * Session-mode connection string for a runtime role: MUNIM_DB_URL_SESSION, logged in as the role like dbUrl(). For
   * LISTEN/NOTIFY: a transaction-mode pooler never delivers notifications.
   */
  sessionDbUrl(role: DbRole): string;
  /** Directory of generated Munim-internal files (`.run/`; `MUNIM_RUN_DIR` or LoadOptions.runDir). */
  runDir: string;
  /** Dev run-token Ed25519 key pair directory: `<runDir>/keys` (core-api's ensureDevRunTokenKeys writes it). */
  runTokenKeyDir: string;
  /** intel's base URL: `MUNIM_INTEL_URL`, default http://127.0.0.1:8081 (the local intel stub in dev). */
  intelUrl: string;
  /** `MUNIM_CORS_ORIGINS`, trimmed, default "": the comma-separated browser origins core-api's public routes allow
   *  (parsed by core-api's parseCorsOrigins; empty = no CORS). Not a secret, but never logged. */
  corsOrigins: string;
  /** `MUNIM_TRUSTED_PROXY_HOPS`: how many proxies in front of core-api append to X-Forwarded-For (the rate limiters'
   *  client address). A whole number 0–99, default 0; anything else is a ConfigError (gotcha 17: never a silent default). */
  trustedProxyHops: number;
  /** The core → intel shared service secret (dev; 03-arch §1.9): `MUNIM_SERVICE_SECRET`, else generated once
   *  under `<runDir>/service-secret` (mode 0600). Registered for redaction. */
  serviceSecret(): string;
  /** The run-token Ed25519 PEMs from `MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM` / `MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM` (both or
   *  neither; a literal `\n` counts as a newline), registered for redaction. Neither set → null (the caller uses the
   *  dev pair under runTokenKeyDir), except env-only, where it is a ConfigError. */
  runTokenKeyPems(): { privateKeyPem: string; publicKeyPem: string } | null;
  /** `MUNIM_CRON_SECRET` (≥ 16 characters), the bearer the tick route accepts; unset → null (no tick route). Registered. */
  cronSecret(): string | null;
  /** `MUNIM_STREAM_MAX_AGE_S` × 1000: when core-api ends an SSE stream with a reconnect hint. Whole seconds 10–86400,
   *  default 3300 (55 min); a host that cuts requests sooner (e.g. at 300 s) sets it below its limit. */
  streamMaxAgeMs: number;
  /** `MUNIM_ASK_TIMEOUT_S` × 1000: how long `POST /v1/ask` waits for intel's answer. Whole seconds 10–600, default 90. A host
   *  that cuts requests (the deploy platform Hobby: 300 s) sets it under that limit and above intel's own `MUNIM_ASK_BUDGET_S`. */
  askTimeoutMs: number;
  /** `MUNIM_DB_POOL_MAX`: a ceiling on core-api's app pools (3–50; below 3 is refused: untested, and a request that
   *  holds one connection while asking for another would wait forever), for a host that runs many small instances
   *  against one pooler; unset → undefined (each pool keeps its own size). */
  dbPoolMax: number | undefined;
  /** The tick route's slot (`MUNIM_TICK_PERIOD_MIN`, 1–1440, default 1440 = a daily cron) and its time budget
   *  (`MUNIM_TICK_BUDGET_S`, 1–3600, default 240: under a 300 s request limit). */
  tickPeriodMinutes: number;
  tickBudgetMs: number;
  /** `MUNIM_BLOB`: "fs" (default), "gcs" or a dev mapping's mode; anything else is a ConfigError (gotcha 17). Every
   *  process that writes or reads uploads (core-api, the tick, core-worker) must see the same value. */
  blob: BlobMode;
  /** `MUNIM_BLOB_BUCKET`, the bucket for a shared store (3–63 of a-z 0-9 . _ -); unset or malformed → ConfigError. */
  blobBucket(): string;
  /** `MUNIM_IDP_PROJECT_ID`, the Identity Platform project (6–30 of a-z 0-9 -); unset or malformed → ConfigError. */
  idpProjectId(): string;
  /** The dev mapping's adapter for a dev MUNIM_IDP / MUNIM_BLOB value; a ConfigError in a build without it. */
  devAdapter(kind: "idp" | "blob", mode: string): unknown;
  /** Registers for redaction every secret already generated under runDir (role passwords, service secret, the
   *  dev run-token private key) without creating any; returns how many values are now registered in total. */
  registerRunSecrets(): number;
  /** Replace every secret value (and the password inside each connection string) with `[redacted:NAME]`. */
  redact(text: string): string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadOptions {
  /** Path of the env file; read only if it exists. Gates pass `env` instead and no file. */
  envFile?: string;
  /** Process-style environment. Values here win over the file. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directory of generated Munim-internal files (`.run/`). `MUNIM_RUN_DIR` in `env` wins. */
  runDir?: string;
  /** Every secret from `env` only: nothing under runDir is read or written (role passwords, service secret,
   *  run-token keys), and a missing one is a ConfigError. For hosts with a read-only, per-instance filesystem. */
  envOnly?: boolean;
  /** The dev mapping to apply: default this checkout's (`devEnv`); tests pass null or their own. */
  dev?: DevEnv | null;
}

/** A local Postgres (`make up LOCAL_DB=1`): a base URL with host, port and database only; each runtime role logs in
 *  as itself with its password from `<runDir>/db-roles.json`. Wins over MUNIM_DB_URL_*. */
const LOCAL_DB_URL = "MUNIM_DATABASE_URL";
const DEFAULT_INTEL_URL = "http://127.0.0.1:8081";

export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const dev = opts.dev === undefined ? devEnv : opts.dev;
  const fromFile = (opts.envFile && existsSync(opts.envFile) ? parseEnv(readFileSync(opts.envFile, "utf8")) : {}) as Record<string, string | undefined>;
  const values = new Map<string, string>();
  for (const n of [...ENV_NAMES, ...(dev?.names ?? [])]) {
    const v = (env[n] ?? fromFile[n] ?? "").trim();
    if (v !== "") values.set(n, v);
  }
  // A dev name stands in for its neutral name; both set to different values is refused (names only, never values).
  const aliasOf = new Map<string, string>();
  for (const [neutral, devName] of Object.entries(dev?.aliases ?? {}) as [EnvName, string][]) {
    aliasOf.set(neutral, devName);
    const d = values.get(devName);
    if (d === undefined) continue;
    const n = values.get(neutral);
    if (n !== undefined && n !== d) throw new ConfigError(`${neutral} and ${devName} are both set and differ — set one`);
    values.set(neutral, d);
  }
  const viaAlias = (n: EnvName) => aliasOf.has(n) && values.has(aliasOf.get(n)!);
  const named = (n: string) => (aliasOf.has(n) ? `${n} (or ${aliasOf.get(n)})` : n);

  const secrets: Array<[string, string]> = [];
  const addSecret = (label: string, v: string | undefined) => {
    if (!v || v.length < 4) return;
    secrets.push([label, v]);
    const enc = encodeURIComponent(v);
    if (enc !== v) secrets.push([label, enc]);
  };
  for (const n of [...SECRET_NAMES, ...(dev?.secretNames ?? [])]) {
    const v = values.get(n);
    addSecret(n, v);
    const pw = v ? urlPassword(v) : null;
    if (pw) {
      addSecret(n, pw);
      addSecret(n, safeDecode(pw));
    }
  }
  // Longest first, so a secret that contains another is replaced whole.
  secrets.sort((a, b) => b[1].length - a[1].length);
  const redact = (text: string) => secrets.reduce((t, [label, v]) => t.replaceAll(v, `[redacted:${label}]`), text);

  const modelMode = env.MUNIM_MODEL_MODE ?? "recorded";
  if (modelMode !== "recorded" && modelMode !== "live") {
    throw new ConfigError(`MUNIM_MODEL_MODE must be "recorded" or "live"`);
  }
  const blobModes = [...BLOB_MODES, ...(dev?.blobModes ?? [])];
  const blob = env.MUNIM_BLOB?.trim() || "fs";
  if (!blobModes.includes(blob)) throw new ConfigError(`MUNIM_BLOB must be one of ${quoted(blobModes)}`);
  const port = Number(env.PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError("PORT must be an integer 1–65535");

  const wholeNumber = (name: string, min: number, max: number, dflt: number | undefined): number | undefined => {
    const raw = env[name]?.trim() ?? "";
    if (raw === "") return dflt;
    const n = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= min && n <= max)) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const streamMaxAgeMs = wholeNumber("MUNIM_STREAM_MAX_AGE_S", 10, 86_400, 3_300)! * 1000;
  const askTimeoutMs = wholeNumber("MUNIM_ASK_TIMEOUT_S", 10, 600, 90)! * 1000;
  const dbPoolMax = wholeNumber("MUNIM_DB_POOL_MAX", 3, 50, undefined);
  const tickPeriodMinutes = wholeNumber("MUNIM_TICK_PERIOD_MIN", 1, 1_440, 1_440)!;
  const tickBudgetMs = wholeNumber("MUNIM_TICK_BUDGET_S", 1, 3_600, 240)! * 1000;
  const envOnly = opts.envOnly === true;

  const hopsRaw = env.MUNIM_TRUSTED_PROXY_HOPS?.trim() ?? "";
  if (hopsRaw !== "" && !/^[0-9]{1,2}$/.test(hopsRaw)) throw new ConfigError("MUNIM_TRUSTED_PROXY_HOPS must be a whole number from 0 to 99");
  const trustedProxyHops = hopsRaw === "" ? 0 : Number(hopsRaw);

  const runDir = env.MUNIM_RUN_DIR?.trim() || opts.runDir || ".run";
  const register = (label: string, v: string) => {
    addSecret(label, v);
    secrets.sort((a, b) => b[1].length - a[1].length);
  };
  // The PEM body lines: a leaked key shows up as any one of them.
  const registerPem = (pem: string) => {
    for (const line of pem.split("\n")) if (line.trim() && !line.startsWith("-----")) register("run-token private key", line.trim());
  };

  /** Every role password in `<runDir>/db-roles.json` (registered for redaction). m-1's bootstrap CLI writes
   *  `{written_at, roles: {role: password}}`; a flat `{role: password}` map is accepted too. `MUNIM_DB_PASSWORD_<ROLE>`
   *  (e.g. MUNIM_DB_PASSWORD_MUNIM_CORE) wins over the file; env-only reads no file. */
  const rolePasswords = (): { file: string; passwords: Record<string, string> } => {
    const file = envOnly ? "MUNIM_DB_PASSWORD_<ROLE>" : join(runDir, "db-roles.json");
    let passwords: Record<string, string> = {};
    if (!envOnly && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { roles?: Record<string, string> } & Record<string, unknown>;
        passwords = (parsed.roles ?? parsed) as Record<string, string>;
      } catch {
        // No cause: a JSON SyntaxError quotes the input, and these values are not registered secrets yet.
        throw new ConfigError(`${file} is not valid JSON`);
      }
    }
    for (const role of DB_ROLES) {
      const v = env[`MUNIM_DB_PASSWORD_${role.toUpperCase()}`]?.trim();
      if (v) passwords[role] = v;
    }
    for (const [role, pw] of Object.entries(passwords)) if (typeof pw === "string") register(`${role} password`, pw);
    return { file, passwords };
  };

  const roleUrl = (base: "MUNIM_DB_URL_TRANSACTION" | "MUNIM_DB_URL_SESSION", role: DbRole): string => {
    const local = env[LOCAL_DB_URL]?.trim();
    const name = local ? LOCAL_DB_URL : base;
    const text = local || cfg.require(base);
    let url: URL;
    try {
      url = new URL(text);
    } catch (e) {
      throw new ConfigError(redact(`${name} is not a URL: ${text}`), { cause: e });
    }
    const { file, passwords } = rolePasswords();
    const pw = passwords[role];
    if (!pw) throw new ConfigError(`no password for ${role} in ${file}`);
    url.username = !local && dev && viaAlias(base) ? dev.dbUser(role, cfg) : role;
    url.password = pw;
    return url.toString();
  };

  const cfg: Config = {
    nodeEnv: env.NODE_ENV ?? "development",
    port,
    modelMode,
    get: (n) => values.get(n),
    require(n) {
      const v = values.get(n);
      if (v === undefined) throw new ConfigError(`${named(n)} is not set — see .env.example`);
      return v;
    },
    dbUrl: (role) => roleUrl("MUNIM_DB_URL_TRANSACTION", role),
    sessionDbUrl: (role) => roleUrl("MUNIM_DB_URL_SESSION", role),
    runDir,
    runTokenKeyDir: join(runDir, "keys"),
    intelUrl: env.MUNIM_INTEL_URL?.trim() || DEFAULT_INTEL_URL,
    corsOrigins: env.MUNIM_CORS_ORIGINS?.trim() ?? "",
    trustedProxyHops,
    serviceSecret() {
      let v = env.MUNIM_SERVICE_SECRET?.trim();
      if (!v && envOnly) throw new ConfigError("MUNIM_SERVICE_SECRET is not set (env-only config generates no secret)");
      if (!v) {
        const file = join(runDir, "service-secret");
        if (existsSync(file)) v = readFileSync(file, "utf8").trim();
        if (!v) {
          v = randomBytes(32).toString("hex");
          ensureRunDir(runDir);
          writeFileSync(file, `${v}\n`, { mode: 0o600 });
        }
      }
      register("service secret", v);
      return v;
    },
    runTokenKeyPems() {
      const pem = (name: string) => env[name]?.trim().replaceAll("\\n", "\n") || undefined;
      const privateKeyPem = pem("MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM");
      const publicKeyPem = pem("MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM");
      if (!privateKeyPem && !publicKeyPem) {
        if (envOnly) throw new ConfigError("MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM and MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM are not set (env-only config generates no keys)");
        return null;
      }
      if (!privateKeyPem || !publicKeyPem) throw new ConfigError("set both MUNIM_RUN_TOKEN_PRIVATE_KEY_PEM and MUNIM_RUN_TOKEN_PUBLIC_KEY_PEM, or neither");
      registerPem(privateKeyPem);
      return { privateKeyPem: `${privateKeyPem}\n`, publicKeyPem: `${publicKeyPem}\n` };
    },
    cronSecret() {
      const v = env.MUNIM_CRON_SECRET?.trim();
      if (!v) return null;
      if (v.length < 16) throw new ConfigError("MUNIM_CRON_SECRET must be at least 16 characters");
      register("cron secret", v);
      return v;
    },
    streamMaxAgeMs,
    askTimeoutMs,
    dbPoolMax,
    tickPeriodMinutes,
    tickBudgetMs,
    blob,
    blobBucket() {
      const v = env.MUNIM_BLOB_BUCKET?.trim() ?? "";
      if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(v)) throw new ConfigError("MUNIM_BLOB_BUCKET is not set or not a bucket name (3–63 of a-z 0-9 . _ -)");
      return v;
    },
    idpProjectId() {
      const v = env.MUNIM_IDP_PROJECT_ID?.trim() ?? "";
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v)) throw new ConfigError("MUNIM_IDP_PROJECT_ID is not set or not a project id (6–30 of a-z 0-9 -)");
      return v;
    },
    devAdapter(kind, mode) {
      const modes = kind === "idp" ? dev?.idpModes : dev?.blobModes;
      if (!dev || !modes?.includes(mode)) throw new ConfigError(`no ${kind} adapter "${mode}" in this build`);
      return dev.adapter(kind, mode, cfg);
    },
    registerRunSecrets() {
      rolePasswords();
      const secret = join(runDir, "service-secret");
      if (existsSync(secret)) register("service secret", readFileSync(secret, "utf8").trim());
      const key = join(runDir, "keys", "run-token-ed25519.pem");
      if (existsSync(key)) registerPem(readFileSync(key, "utf8"));
      return secrets.length;
    },
    redact,
  };
  return cfg;
}

/** A logger whose every line passes through the config's redaction. Errors are inspected in full (own
 *  properties and causes included — e.g. a URL TypeError carries the bad input) and then redacted — except a
 *  Postgres server error (also as a cause), which is logged by SQLSTATE, constraint and table only (R1-m12): its
 *  message and detail quote row values (23505 "Key (email)=(…) already exists", 22P02 the bad input). */
export function createLogger(cfg: Pick<Config, "redact">, sink: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
  return (msg: string, err?: unknown) => {
    const pg = err === undefined ? null : pgLabel(err);
    const line = err === undefined ? msg : pg ? `${msg} pg ${pg}` : `${msg} ${inspect(err, { depth: 4, breakLength: Infinity })}`;
    sink(cfg.redact(line));
  };
}

/** "<sqlstate> constraint=<name> table=<schema>.<table>" for a pg DatabaseError (severity + 5-char code) found in
 *  `err` or its causes, else null. Built from those identifier fields only. */
function pgLabel(err: unknown): string | null {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { code?: unknown; severity?: unknown; constraint?: unknown; schema?: unknown; table?: unknown };
    if (typeof x.code === "string" && /^[0-9A-Z]{5}$/.test(x.code) && typeof x.severity === "string") {
      const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_$]{1,63}$/.test(v) ? v : "-");
      return `${x.code} constraint=${id(x.constraint)} table=${id(x.schema)}.${id(x.table)}`;
    }
  }
  return null;
}
export type Logger = ReturnType<typeof createLogger>;

/** `.run/` holds generated secrets: owner-only (0700, W1 fix #36), also when it already existed wider. */
export function ensureRunDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function urlPassword(s: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^:/?#@]*:([^@/?#]*)@/i.exec(s);
  return m?.[1] || null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The config every process of this repo loads: `<root>/.env` (or `MUNIM_ENV_FILE`, so an rsync-isolated copy
 *  without `.env` still loads the founder's file through this module) and `<root>/.run` (or `MUNIM_RUN_DIR`). */
export function loadRepoConfig(root: string, env: Record<string, string | undefined> = process.env): Config {
  return loadConfig({ envFile: env.MUNIM_ENV_FILE?.trim() || join(root, ".env"), runDir: join(root, ".run"), env });
}


/** Which IdP core-api verifies against (R44a): `--idp=<v>` / `--idp <v>` beats `MUNIM_IDP`; unset → the dev mapping's
 *  default, and a ConfigError in a build without one. Anything but exactly one of the known values throws (gotcha 17).
 *  "local" is refused unless this is a dev environment: `NODE_ENV=production` or a `MUNIM_ENV` other than `dev` →
 *  ConfigError, before anything starts. */
export function resolveIdpMode(env: Record<string, string | undefined> = process.env, argv: readonly string[] = [], dev: DevEnv | null = devEnv): IdpMode {
  let raw = env.MUNIM_IDP;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--idp") raw = argv[++i] ?? "";
    else if (a.startsWith("--idp=")) raw = a.slice("--idp=".length);
  }
  const modes = [...IDP_MODES, ...(dev?.idpModes ?? [])];
  const mode = raw === undefined ? dev?.idpDefault : raw;
  if (mode === undefined) throw new ConfigError(`MUNIM_IDP is not set: one of ${quoted(modes)}`);
  if (!modes.includes(mode)) throw new ConfigError(`MUNIM_IDP must be exactly one of ${quoted(modes)}`);
  if (mode === "local") {
    if (env.NODE_ENV === "production") throw new ConfigError("MUNIM_IDP=local is refused when NODE_ENV=production");
    // Explicit: an unset MUNIM_ENV is not "dev" (a deploy that forgot NODE_ENV must not accept local tokens). `make up` sets it.
    if (env.MUNIM_ENV !== "dev") throw new ConfigError(`MUNIM_IDP=local is refused unless MUNIM_ENV is "dev"`);
  }
  return mode;
}
