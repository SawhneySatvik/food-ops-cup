// The one config module (project rule 20). Loads the founder's `.env` by the names in `.env.example`,
// holds Munim-internal settings (defaults in code, generated files under `.run/`), and redacts every
// secret value from error messages and log lines. Gates never need `.env`: they pass `env` directly.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect, parseEnv } from "node:util";

/** Exactly the names in `.env.example` (test: test/names.test.ts compares the two). */
export const ENV_NAMES = [
  "GEMINI_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEVHOST_DB_PASSWORD",
  "DEVHOST_PROJECT_URL",
  "DEVHOST_PUBLISHABLE_KEY",
  "DEVHOST_PROJECT_ID",
  "DEVHOST_SECRET_KEY",
  "DEVHOST_DIRECT_CONNECTION_STRING",
  "DEVHOST_DIRECT_CONNECTION_HOST",
  "DEVHOST_DIRECT_CONNECTION_PORT",
  "DEVHOST_DIRECT_CONNECTION_DATABASE",
  "DEVHOST_DIRECT_CONNECTION_USER",
  "DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING",
  "DEVHOST_TRANSACTION_POOLER_HOST",
  "DEVHOST_TRANSACTION_POOLER_PORT",
  "DEVHOST_TRANSACTION_POOLER_DATABASE",
  "DEVHOST_TRANSACTION_POOLER_USER",
  "DEVHOST_SESSION_POOLER_CONNECTION_STRING",
  "DEVHOST_SESSION_POOLER_HOST",
  "DEVHOST_SESSION_POOLER_PORT",
  "DEVHOST_SESSION_POOLER_DATABASE",
  "DEVHOST_SESSION_POOLER_USER",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
export type EnvName = (typeof ENV_NAMES)[number];

/** Values never shown. Connection strings carry the database password inside them. */
const SECRET_NAMES: readonly EnvName[] = [
  "GEMINI_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEVHOST_DB_PASSWORD",
  "DEVHOST_SECRET_KEY",
  "DEVHOST_DIRECT_CONNECTION_STRING",
  "DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING",
  "DEVHOST_SESSION_POOLER_CONNECTION_STRING",
  "UPSTASH_REDIS_REST_TOKEN",
];

export type ModelMode = "recorded" | "live";
export type DbRole = "munim_core" | "munim_svc" | "munim_platform";

export interface Config {
  nodeEnv: string;
  port: number;
  modelMode: ModelMode;
  /** A `.env` value by its `.env.example` name; undefined when unset or empty. */
  get(name: EnvName): string | undefined;
  /** Like get(), but throws a ConfigError naming the variable (never its value) when unset. */
  require(name: EnvName): string;
  /**
   * App-pool connection string for a runtime role (03-arch §1.2): the transaction pooler's host, port and
   * database, logged in as the role. UNVERIFIED against the hosted project: the dev host's pooler expects the
   * user as `<role>.<project id>`; role passwords are not in `.env` and are read from `.run/db-roles.json`
   * (`{"munim_core": "…", "munim_svc": "…"}`) — how they get there is an open founder question (T-004 report).
   */
  dbUrl(role: DbRole): string;
  /**
   * Session-mode connection string for a runtime role: the session pooler's host, port and database (IPv4),
   * logged in as the role like dbUrl(). For LISTEN/NOTIFY (rule 20): a transaction pooler never delivers
   * notifications.
   */
  sessionDbUrl(role: DbRole): string;
  /** Directory of generated Munim-internal files (`.run/`; `MUNIM_RUN_DIR` or LoadOptions.runDir). */
  runDir: string;
  /** Dev run-token Ed25519 key pair directory: `<runDir>/keys` (core-api's ensureDevRunTokenKeys writes it). */
  runTokenKeyDir: string;
  /** intel's base URL: `MUNIM_INTEL_URL`, default http://127.0.0.1:8081 (the local intel stub in dev). */
  intelUrl: string;
  /** The core → intel shared service secret (dev; 03-arch §1.9): `MUNIM_SERVICE_SECRET`, else generated once
   *  under `<runDir>/service-secret` (mode 0600). Registered for redaction. */
  serviceSecret(): string;
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
  /** Path of the founder's `.env`; read only if it exists. Gates pass `env` instead and no file. */
  envFile?: string;
  /** Process-style environment. Values here win over the file. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directory of generated Munim-internal files (`.run/`). `MUNIM_RUN_DIR` in `env` wins. */
  runDir?: string;
}

/** Local Postgres instead of the the dev host poolers (`make up LOCAL_DB=1`): a base URL with host, port and
 *  database only; each runtime role logs in as itself with its password from `<runDir>/db-roles.json`. */
const LOCAL_DB_URL = "MUNIM_DATABASE_URL";
const DEFAULT_INTEL_URL = "http://127.0.0.1:8081";

export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const fromFile = opts.envFile && existsSync(opts.envFile) ? parseEnv(readFileSync(opts.envFile, "utf8")) : {};
  const values = new Map<EnvName, string>();
  for (const n of ENV_NAMES) {
    const v = (env[n] ?? (fromFile as Record<string, string | undefined>)[n] ?? "").trim();
    if (v !== "") values.set(n, v);
  }

  const secrets: Array<[string, string]> = [];
  const addSecret = (label: string, v: string | undefined) => {
    if (!v || v.length < 4) return;
    secrets.push([label, v]);
    const enc = encodeURIComponent(v);
    if (enc !== v) secrets.push([label, enc]);
  };
  for (const n of SECRET_NAMES) {
    const v = values.get(n);
    addSecret(n, v);
    if (v && n.endsWith("_CONNECTION_STRING")) {
      const pw = urlPassword(v);
      if (pw) {
        addSecret(n, pw);
        addSecret(n, safeDecode(pw));
      }
    }
  }
  // Longest first, so a secret that contains another is replaced whole.
  secrets.sort((a, b) => b[1].length - a[1].length);
  const redact = (text: string) => secrets.reduce((t, [label, v]) => t.replaceAll(v, `[redacted:${label}]`), text);

  const modelMode = env.MUNIM_MODEL_MODE ?? "recorded";
  if (modelMode !== "recorded" && modelMode !== "live") {
    throw new ConfigError(`MUNIM_MODEL_MODE must be "recorded" or "live"`);
  }
  const port = Number(env.PORT ?? "8787");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError("PORT must be an integer 1–65535");

  const runDir = env.MUNIM_RUN_DIR?.trim() || opts.runDir || ".run";
  const register = (label: string, v: string) => {
    addSecret(label, v);
    secrets.sort((a, b) => b[1].length - a[1].length);
  };

  /** Every role password in `<runDir>/db-roles.json` (registered for redaction). m-1's bootstrap CLI writes
   *  `{written_at, roles: {role: password}}`; a flat `{role: password}` map is accepted too. */
  const rolePasswords = (): { file: string; passwords: Record<string, string> } => {
    const file = join(runDir, "db-roles.json");
    let passwords: Record<string, string> = {};
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { roles?: Record<string, string> } & Record<string, unknown>;
        passwords = (parsed.roles ?? parsed) as Record<string, string>;
      } catch {
        // No cause: a JSON SyntaxError quotes the input, and these values are not registered secrets yet.
        throw new ConfigError(`${file} is not valid JSON`);
      }
    }
    for (const [role, pw] of Object.entries(passwords)) if (typeof pw === "string") register(`${role} password`, pw);
    return { file, passwords };
  };

  const roleUrl = (base: "DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING" | "DEVHOST_SESSION_POOLER_CONNECTION_STRING", role: DbRole): string => {
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
    url.username = local ? role : `${role}.${cfg.require("DEVHOST_PROJECT_ID")}`;
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
      if (v === undefined) throw new ConfigError(`${n} is not set — see .env.example`);
      return v;
    },
    dbUrl: (role) => roleUrl("DEVHOST_TRANSACTION_POOLER_CONNECTION_STRING", role),
    sessionDbUrl: (role) => roleUrl("DEVHOST_SESSION_POOLER_CONNECTION_STRING", role),
    runDir,
    runTokenKeyDir: join(runDir, "keys"),
    intelUrl: env.MUNIM_INTEL_URL?.trim() || DEFAULT_INTEL_URL,
    serviceSecret() {
      let v = env.MUNIM_SERVICE_SECRET?.trim();
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
    registerRunSecrets() {
      rolePasswords();
      const secret = join(runDir, "service-secret");
      if (existsSync(secret)) register("service secret", readFileSync(secret, "utf8").trim());
      const key = join(runDir, "keys", "run-token-ed25519.pem");
      if (existsSync(key)) {
        // The PEM body lines: a leaked key shows up as any one of them.
        for (const line of readFileSync(key, "utf8").split("\n")) if (line && !line.startsWith("-----")) register("run-token private key", line.trim());
      }
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

export type IdpMode = "local" | "devhost";

/** Which IdP core-api verifies against (R44a): `--idp=<v>` / `--idp <v>` beats `MUNIM_IDP`; default `devhost`.
 *  Anything but exactly "local" or "devhost" throws (gotcha 17). "local" is refused unless this is a dev
 *  environment: `NODE_ENV=production` or a `MUNIM_ENV` other than `dev` → ConfigError, before anything starts. */
export function resolveIdpMode(env: Record<string, string | undefined> = process.env, argv: readonly string[] = []): IdpMode {
  let raw = env.MUNIM_IDP;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--idp") raw = argv[++i] ?? "";
    else if (a.startsWith("--idp=")) raw = a.slice("--idp=".length);
  }
  const mode = raw === undefined ? "devhost" : raw;
  if (mode !== "local" && mode !== "devhost") throw new ConfigError(`MUNIM_IDP must be exactly "local" or "devhost"`);
  if (mode === "local") {
    if (env.NODE_ENV === "production") throw new ConfigError("MUNIM_IDP=local is refused when NODE_ENV=production");
    // Explicit: an unset MUNIM_ENV is not "dev" (a deploy that forgot NODE_ENV must not accept local tokens). `make up` sets it.
    if (env.MUNIM_ENV !== "dev") throw new ConfigError(`MUNIM_IDP=local is refused unless MUNIM_ENV is "dev"`);
  }
  return mode;
}
