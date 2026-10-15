// Role-password bootstrap (orchestrator rider, 10 Oct). Sets a fresh random LOGIN password on each runtime
// role of a migrated database and writes them to .run/db-roles.json (git-ignored, mode 0600) for the
// services' config module to read. Migrations never set passwords (0001); the test harness sets its own.
//
//   node db/scripts/bootstrap-roles.ts [--out <path> | --out=<path>]
//
// The target comes ONLY from $MUNIM_DB_URL_SESSION, exported by the caller — this script never reads .env and never
// prints a password. Re-running rotates every
// password. It refuses a database that has not been migrated (the roles must already exist).
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrlFromEnv } from "../migrate.ts";

export const LOGIN_ROLES = ["munim_core", "munim_svc", "munim_intel_ro", "munim_platform"] as const;
export const DEFAULT_OUT = fileURLToPath(new URL("../../.run/db-roles.json", import.meta.url));

/** Parses `--out <path>` and `--out=<path>`; any other argument is refused (gotcha 17). */
export function parseArgs(argv: string[]): { out: string } {
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("bootstrap-roles: --out needs a path");
      out = resolve(v);
    } else if (a.startsWith("--out=")) {
      if (a.length === 6) throw new Error("bootstrap-roles: --out needs a path");
      out = resolve(a.slice(6));
    } else {
      throw new Error(`bootstrap-roles: unknown argument '${a}'`);
    }
  }
  return { out };
}

/** Sets a new password on every login role (one transaction) and returns { role: password }. */
export async function bootstrapRoles(client: pg.Client): Promise<Record<string, string>> {
  const present = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY ($1) AND rolcanlogin", [LOGIN_ROLES]);
  const missing = LOGIN_ROLES.filter((r) => !present.rows.some((x) => x.rolname === r));
  if (missing.length > 0) throw new Error(`bootstrap-roles: login roles missing (${missing.join(", ")}) — run the migrations first`);
  const secrets: Record<string, string> = {};
  await client.query("BEGIN");
  try {
    for (const role of LOGIN_ROLES) {
      // Hex only, so the literal needs no escaping (ALTER ROLE takes no bind parameters).
      const pw = randomBytes(24).toString("hex");
      await client.query(`ALTER ROLE ${role} PASSWORD '${pw}'`);
      secrets[role] = pw;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  return secrets;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { out } = parseArgs(process.argv.slice(2));
    const url = await adminUrlFromEnv("bootstrap-roles");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const secrets = await bootstrapRoles(client);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ written_at: new Date().toISOString(), roles: secrets }, null, 2) + "\n", { mode: 0o600 });
      chmodSync(out, 0o600); // `mode` applies only when the file is created
      console.log(`bootstrap-roles: set passwords for ${Object.keys(secrets).join(", ")}; wrote ${out}`);
    } finally {
      await client.end();
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
