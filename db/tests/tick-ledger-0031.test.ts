// 0031 gates (T-117: the tick ledger; R56 G-2, plan 06 row T-117). Expected values are typed by hand here; none is read from the
// migration under test. Every refusal is paired with an accept.
//   T1    core.tick_claim as core-worker uses it, on munim_svc's own connection (no tenant context): the first claim of a
//         (job, slot) returns its row, the same claim again returns none (also when the two race: the second waits for the first
//         to commit, then returns none); another slot or another job is a new claim; finish sets finished_at + outcome; the
//         CHECKs refuse an unknown outcome, a half-finished row and a malformed job name (23514)
//   G     munim_svc: SELECT, INSERT, UPDATE of finished_at/outcome only (the key and claimed_at → 42501; DELETE, TRUNCATE → 42501);
//         munim_core, munim_platform, munim_intel_ro: no read, no write (42501); the catalog holds exactly those privileges
//   SHAPE tagged munim:operational, no tenant_id, the primary key on (job, slot_at) read from pg_index
// Red-proofs: db/tests/redproof-0031.sh (each gate red with a non-zero exit).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { openDb, pgError } from "./db.ts";

let db: TestDb;
let svc: pg.Client;
const SLOT = "2026-10-15T01:00:00Z";
const CLAIM = `INSERT INTO core.tick_claim (job, slot_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING job`;

beforeAll(async () => {
  db = await openDb();
  svc = await db.connect("munim_svc");
});
afterAll(async () => {
  await svc?.end();
  await db?.stop();
});

const claim = async (c: pg.Client, job: string, slot = SLOT) => (await c.query(CLAIM, [job, slot])).rowCount;
const as = async (role: "munim_core" | "munim_platform" | "munim_intel_ro" | "munim_svc", sql: string, params: unknown[] = []) => {
  const c = await db.connect(role);
  try {
    return await pgError(() => c.query(sql, params));
  } finally {
    await c.end();
  }
};

describe("T1 claims", () => {
  test("a (job, slot) is claimed once: first → 1 row, again → 0; another slot or job → 1; finish records outcome", async () => {
    const got = [await claim(svc, "fanout-brief"), await claim(svc, "fanout-brief"), await claim(svc, "fanout-brief", "2026-10-16T01:00:00Z"),
      await claim(svc, "outbox-sweep")];
    console.log(`T1 claims (first, again, next slot, other job): ${got.join(",")}`);
    expect(got).toEqual([1, 0, 1, 1]);
    const fin = await svc.query(`UPDATE core.tick_claim SET finished_at = now(), outcome = 'ok' WHERE job = $1 AND slot_at = $2 AND finished_at IS NULL`,
      ["fanout-brief", SLOT]);
    expect(fin.rowCount).toBe(1);
    const rows = (await svc.query<{ job: string; outcome: string | null; done: boolean; claimed: boolean }>(
      `SELECT job, outcome, finished_at IS NOT NULL done, claimed_at IS NOT NULL claimed FROM core.tick_claim ORDER BY job, slot_at`)).rows;
    expect(rows).toEqual([
      { job: "fanout-brief", outcome: "ok", done: true, claimed: true },
      { job: "fanout-brief", outcome: null, done: false, claimed: true },
      { job: "outbox-sweep", outcome: null, done: false, claimed: true },
    ]);
  });

  test("two racing claims of one (job, slot): the second waits for the first to commit, then returns no row", async () => {
    const other = await db.connect("munim_svc");
    try {
      await svc.query("BEGIN");
      expect(await claim(svc, "nightly")).toBe(1);
      let second: number | null | undefined;
      const racing = claim(other, "nightly").then((n) => (second = n));
      await new Promise((r) => setTimeout(r, 300));
      expect(second).toBeUndefined(); // blocked on the first claim's uncommitted key
      await svc.query("COMMIT");
      await racing;
      console.log(`T1 race: first 1, second ${second}`);
      expect(second).toBe(0);
    } finally {
      await svc.query("ROLLBACK").catch(() => {});
      await other.end();
    }
  });

  test("CHECKs: unknown outcome, finished_at without outcome, a malformed job name → 23514; a well-formed finish is accepted", async () => {
    await claim(svc, "imports-parse");
    const codes = [
      await pgError(() => svc.query(`UPDATE core.tick_claim SET finished_at = now(), outcome = 'done' WHERE job = 'imports-parse'`)),
      await pgError(() => svc.query(`UPDATE core.tick_claim SET finished_at = now() WHERE job = 'imports-parse'`)),
      await pgError(() => svc.query(`UPDATE core.tick_claim SET outcome = 'failed' WHERE job = 'imports-parse'`)),
      await pgError(() => svc.query(CLAIM, ["Brief!", SLOT])),
    ].map((e) => e?.code);
    console.log(`T1 CHECK refusals: ${codes.join(",")}`);
    expect(codes).toEqual(["23514", "23514", "23514", "23514"]);
    expect(await pgError(() => svc.query(`UPDATE core.tick_claim SET finished_at = now(), outcome = 'failed' WHERE job = 'imports-parse'`))).toBeNull();
  });
});

describe("G privileges", () => {
  test("munim_svc cannot change the key or claimed_at, DELETE or TRUNCATE (42501); it can read", async () => {
    const codes = [
      await as("munim_svc", `UPDATE core.tick_claim SET slot_at = slot_at + interval '1 day'`),
      await as("munim_svc", `UPDATE core.tick_claim SET job = 'other'`),
      await as("munim_svc", `UPDATE core.tick_claim SET claimed_at = now()`),
      await as("munim_svc", `DELETE FROM core.tick_claim`),
      await as("munim_svc", `TRUNCATE core.tick_claim`),
    ].map((e) => e?.code);
    console.log(`G svc refusals: ${codes.join(",")}`);
    expect(codes).toEqual(["42501", "42501", "42501", "42501", "42501"]);
    expect(await as("munim_svc", `SELECT job, slot_at, claimed_at, finished_at, outcome FROM core.tick_claim`)).toBeNull();
  });

  test("munim_core, munim_platform and munim_intel_ro neither read nor write (42501)", async () => {
    const codes: string[] = [];
    for (const r of ["munim_core", "munim_platform", "munim_intel_ro"] as const) {
      codes.push((await as(r, `SELECT job FROM core.tick_claim`))?.code ?? "ok");
      codes.push((await as(r, CLAIM, ["probe", SLOT]))?.code ?? "ok");
    }
    console.log(`G others: ${codes.join(",")}`);
    expect(codes).toEqual(["42501", "42501", "42501", "42501", "42501", "42501"]);
  });

  test("the catalog: munim_svc holds SELECT + INSERT and UPDATE of finished_at, outcome; no other role holds anything", async () => {
    const table = (await db.admin<{ p: string }>(`SELECT x.grantee::regrole::text || ':' || x.privilege_type AS p FROM pg_class c, aclexplode(c.relacl) x
       WHERE c.oid = 'core.tick_claim'::regclass AND x.grantee <> c.relowner ORDER BY 1`)).rows.map((r) => r.p);
    const cols = (await db.admin<{ p: string }>(`SELECT a.attname || ':' || x.grantee::regrole::text || ':' || x.privilege_type AS p FROM pg_attribute a, aclexplode(a.attacl) x
       WHERE a.attrelid = 'core.tick_claim'::regclass AND a.attnum > 0 ORDER BY 1`)).rows.map((r) => r.p);
    console.log(`G catalog: table ${table.join(",")}; columns ${cols.join(",")}`);
    expect(table).toEqual(["munim_svc:INSERT", "munim_svc:SELECT"]);
    expect(cols).toEqual(["finished_at:munim_svc:UPDATE", "outcome:munim_svc:UPDATE"]);
  });
});

describe("SHAPE", () => {
  test("munim:operational, no tenant_id, RLS off, primary key on exactly (job, slot_at)", async () => {
    const r = (await db.admin<{ tag: string; tenant: boolean; rls: boolean; key: string }>(`
      SELECT obj_description(c.oid, 'pg_class') tag,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) tenant,
             c.relrowsecurity rls,
             (SELECT string_agg(a.attname, ',' ORDER BY k.o) FROM pg_index i, unnest(i.indkey) WITH ORDINALITY k(n, o)
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.n WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisunique) key
        FROM pg_class c WHERE c.oid = 'core.tick_claim'::regclass`)).rows[0];
    console.log(`SHAPE: ${JSON.stringify(r)}`);
    expect(r).toEqual({ tag: "munim:operational", tenant: false, rls: false, key: "job,slot_at" });
  });
});
