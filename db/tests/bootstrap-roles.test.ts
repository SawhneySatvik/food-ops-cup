// Gate: db/scripts/bootstrap-roles.ts (orchestrator rider). Runs against a SEPARATE embedded cluster (role
// passwords are cluster-global; rotating the shared test cluster's would break parallel files). The CLI
// takes its target only from the environment, refuses without it, rotates all four login passwords, writes
// them (mode 0600) to --out, and the written passwords log in while the old ones no longer do.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { LOGIN_ROLES, parseArgs } from "../scripts/bootstrap-roles.ts";
import { startTestDb, type TestDb } from "../src/harness.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/bootstrap-roles.ts", import.meta.url));
let own: TestDb;
const dir = mkdtempSync(join(tmpdir(), "munim-roles-"));

beforeAll(async () => {
  own = await startTestDb({ seedPacks: false });
});
afterAll(async () => {
  await own?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// Only PATH from this process: a database URL in the caller's own environment (under any name) never reaches the script.
const run = (env: Record<string, string>, args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
const login = async (role: string, password: string) => {
  const c = new pg.Client({ host: "127.0.0.1", port: own.port, user: role, password, database: own.database });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
};

test("argument parsing: --out <p> and --out=<p> both work; unknown flags and a missing path are refused", () => {
  expect(parseArgs(["--out", "/tmp/a.json"]).out).toBe("/tmp/a.json");
  expect(parseArgs(["--out=/tmp/b.json"]).out).toBe("/tmp/b.json");
  expect(() => parseArgs(["--outfile=/x"])).toThrow(/unknown argument/);
  expect(() => parseArgs(["--out"])).toThrow(/needs a path/);
});

test("no connection string in the environment → exit 1 with the reason, nothing written", () => {
  const r = run({}, ["--out", join(dir, "none.json")]);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/bootstrap-roles: FAIL — MUNIM_DB_URL_SESSION( \(or [A-Z_]+\))? is not set in the environment/);
});

test("rotates all four login passwords, writes them 0600, new passwords log in and the old ones do not", async () => {
  const out = join(dir, "db-roles.json");
  const url = `postgres://postgres:${own.password}@127.0.0.1:${own.port}/${own.database}`;
  expect(await login("munim_core", own.password)).toBe(true); // the harness password, before
  const r = run({ MUNIM_DB_URL_SESSION: url }, [`--out=${out}`]);
  console.log(`bootstrap-roles: exit ${r.status}; ${r.stdout.trim().replace(dir, "<tmp>")}`);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toMatch(/[0-9a-f]{48}/); // never prints a password
  const doc = JSON.parse(readFileSync(out, "utf8")) as { roles: Record<string, string> };
  expect(Object.keys(doc.roles).sort()).toEqual([...LOGIN_ROLES].sort());
  expect(statSync(out).mode & 0o777).toBe(0o600);
  for (const role of LOGIN_ROLES) {
    expect(await login(role, doc.roles[role]!)).toBe(true);
    expect(await login(role, own.password)).toBe(false);
  }
});
