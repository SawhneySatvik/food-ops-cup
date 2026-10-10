// Gates (M-B 0012): claim quote = source substring; supplier quotes simulated only; trace seq gapless and
// NOTIFY munim_trace '<tenant>:<run>:<seq>' (ids only); finding NOTIFY munim_inbox '<tenant>:<id>'; trace
// payloads are short labels; intel_ro views show rows only for the tenant intel set and finding_recent has no
// numeric column; munim_intel_ro cannot write through the views; llm_budget_spent per reader's RLS.
// Each refusal paired with an accepted case; red-proofs on clones.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { FINDING_RECENT_COLUMNS, INTEL_RO_VIEWS } from "./manifest.ts";
import { buildWorld, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db, { country: "AU" });
});
afterAll(async () => db?.stop());

const svc = (w: World) => ({ tenant_id: w.tenant, outlet_ids: "*" as const });

describe("claims", () => {
  const claim = (x: TestDb, w: World, start: number, end: number, quote: string, chunk = w.chunk) =>
    attempt(x, "munim_svc", svc(w), `INSERT INTO intel.claim (tenant_id, id, run_id, chunk_id, span_start, span_end, quote, predicate)
      VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, 'mentions')`, [w.tenant, w.run, chunk, start, end, quote]);

  test("quote = source substring accepted; a changed word, a shifted span, an out-of-range span → MB012", async () => {
    // messageBody: "Paneer from Simulated Dairy arrived at 7 am, two crates short."
    const ok = await claim(db, A, 12, 27, "Simulated Dairy");
    const changed = await claim(db, A, 12, 27, "Simulated Diary");
    const shifted = await claim(db, A, 13, 28, "Simulated Dairy");
    const outside = await claim(db, A, 60, 90, "short.");
    console.log(`claim quote: exact → ${ok ? ok.code : "accepted"}; changed → ${changed?.code}; shifted → ${shifted?.code}; out of range → ${outside?.code}`);
    expect(ok).toBeNull();
    for (const e of [changed, shifted, outside]) expect(e?.code).toBe("MB012");
  });

  test("a source of another tenant is not visible → MB012", async () => {
    expect((await claim(db, A, 0, 6, "Paneer", B.chunk))?.code).toBe("MB012");
  });

  test("RED-PROOF: drop the quote trigger → a mismatched quote is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER quote_matches ON intel.claim");
      const e = await claim(x, A, 12, 27, "Simulated Diary");
      console.log("RED-PROOF claim quote:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("supplier quotes are simulated only", () => {
  let real = "";
  beforeAll(async () => {
    real = randomUUID();
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: "purchasing.supplier.upsert.v1" }, (c) =>
      c.query(`INSERT INTO core.supplier (tenant_id, id, name, kind) VALUES ($1, $2, 'Real Wholesaler', 'real')`, [A.tenant, real]));
  });
  const quote = (x: TestDb, supplier: string, extra = "") => attempt(x, "munim_svc", svc(A), `
    INSERT INTO intel.supplier_quote (tenant_id, id, run_id, supplier_id, ingredient_id, round, qty_milli, unit, unit_price_minor, currency, payment_days${extra ? ", is_simulated" : ""})
    VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, 1000, 'kg', 100, 'INR', 7${extra})`, [A.tenant, A.run, supplier, A.ingredient]);

  test("simulated supplier → accepted; a real supplier → 23503; is_simulated = false → 23514", async () => {
    const ok = await quote(db, A.supplier);
    const realQ = await quote(db, real);
    const flag = await quote(db, A.supplier, ", false");
    console.log(`supplier quote: simulated → ${ok ? ok.code : "accepted"}; real → ${realQ?.code} ${realQ?.message}; is_simulated=false → ${flag?.code}`);
    expect(ok).toBeNull();
    expect(realQ?.code).toBe("23503");
    expect(realQ?.message).toMatch(/supplier_quote_simulated_supplier/);
    expect(flag?.code).toBe("23514");
  });

  test("RED-PROOF: drop the composite FK → a quote from a real supplier is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("ALTER TABLE intel.supplier_quote DROP CONSTRAINT supplier_quote_simulated_supplier");
      const e = await quote(x, real);
      console.log("RED-PROOF supplier quote:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

async function listen(x: TestDb, channel: string): Promise<{ c: pg.Client; got: string[] }> {
  const c = await x.connect("munim_core");
  const got: string[] = [];
  c.on("notification", (n) => {
    if (n.channel === channel) got.push(n.payload ?? "");
  });
  await c.query(`LISTEN ${channel}`);
  return { c, got };
}
const settle = () => new Promise((r) => setTimeout(r, 400));

describe("traces and findings", () => {
  async function newRun(x: TestDb, w: World): Promise<string> {
    const run = randomUUID();
    await x.withContext("munim_svc", svc(w), (c) =>
      c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'ask', 'brief', '{*}', now() + interval '15 minutes')`, [w.tenant, run]));
    return run;
  }
  const batch = (n: number, from = 1) => JSON.stringify([...Array(n).keys()].map((i) => ({ seq: from + i, id: randomUUID() })));
  const insertBatch = (x: TestDb, w: World, run: string, rows: string, payload = '{"tool": "sql.query"}') =>
    attempt(x, "munim_svc", svc(w), `INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, kind, actor, payload, at)
      SELECT $1, $2, b.seq, b.id, 'tool_call', 'inventory', $4::jsonb, now() FROM jsonb_to_recordset($3::jsonb) AS b(seq int, id uuid) ORDER BY b.seq`,
      [w.tenant, run, rows, payload]);

  test("a 500-event batch is gapless and NOTIFYs munim_trace '<tenant>:<run>:<seq>' 500×, ids only; a gap → MB014", async () => {
    const run = await newRun(db, A);
    const { c, got } = await listen(db, "munim_trace");
    try {
      expect(await insertBatch(db, A, run, batch(500))).toBeNull();
      const gap = await insertBatch(db, A, run, batch(1, 502));
      await settle();
      console.log(`NOTIFY munim_trace: ${got.length} received, first ${got[0]}, last ${got.at(-1)}; gap → ${gap?.code}`);
      expect(got.length).toBe(500);
      expect(got[0]).toBe(`${A.tenant}:${run}:1`);
      expect(got.at(-1)).toBe(`${A.tenant}:${run}:500`);
      expect(got.every((p) => /^[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]+$/.test(p))).toBe(true);
      expect(gap?.code).toBe("MB014");
      expect(await insertBatch(db, A, run, batch(1, 501))).toBeNull();
    } finally {
      await c.end();
    }
  });

  test("payload strings are labels (≤ 200 chars, snake_case keys): a 201-char value or a bad key → 23514", async () => {
    const run = await newRun(db, A);
    expect((await insertBatch(db, A, run, batch(1), JSON.stringify({ note: "x".repeat(201) })))?.code).toBe("23514");
    expect((await insertBatch(db, A, run, batch(1), JSON.stringify({ "Bad Key": "x" })))?.code).toBe("23514");
    expect(await insertBatch(db, A, run, batch(1), JSON.stringify({ note: "x".repeat(200) }))).toBeNull();
  });

  test("finding insert and status change → munim_inbox '<tenant>:<id>' (ids only)", async () => {
    const { c, got } = await listen(db, "munim_inbox");
    try {
      const id = randomUUID();
      await db.withContext("munim_svc", svc(A), (t) =>
        t.query(`INSERT INTO intel.finding (tenant_id, id, run_id, pack, type, severity, confidence_bp, envelope, dedupe_key)
                 VALUES ($1, $2, $3, 'finance', 'finance.short_payout', 'medium', 7000, '{}', $4)`, [A.tenant, id, A.run, `k-${id}`]));
      await db.withContext("munim_core", svc(A), (t) => t.query(`UPDATE intel.finding SET status = 'dismissed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]));
      await settle();
      console.log(`NOTIFY munim_inbox (finding): ${got.join(" | ")}`);
      expect(got).toEqual([`${A.tenant}:${id}`, `${A.tenant}:${id}`]);
    } finally {
      await c.end();
    }
  });

  test("RED-PROOF: drop the trace NOTIFY trigger → 0 notifications", async () => {
    const x = await db.clone();
    const { c, got } = await listen(x, "munim_trace");
    try {
      await x.admin("DROP TRIGGER notify_trace ON intel.trace_event");
      const run = await newRun(x, A);
      expect(await insertBatch(x, A, run, batch(3))).toBeNull();
      await settle();
      console.log(`RED-PROOF NOTIFY munim_trace: received ${got.length}`);
      expect(got).toEqual([]);
    } finally {
      await c.end();
      await x.stop();
    }
  });
});

/** Rows per intel_ro view as munim_intel_ro with ctx, and the counts the base tables hold for that tenant (admin). */
async function viewCounts(x: TestDb, tenant: string | null): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await x.withContext("munim_intel_ro", tenant ? { tenant_id: tenant, outlet_ids: "*" } : {}, async (c) => {
    for (const v of INTEL_RO_VIEWS) out[v] = (await c.query(`SELECT count(*)::int n FROM ${v}`)).rows[0].n;
  });
  return out;
}
async function expectedCounts(x: TestDb, tenant: string): Promise<Record<string, number>> {
  const q = async (sql: string) => (await x.admin(sql, [tenant])).rows[0]!.n as number;
  return {
    "intel_ro.chunk_search": await q("SELECT count(*)::int n FROM intel.chunk WHERE tenant_id = $1"),
    "intel_ro.claim_search": await q("SELECT count(*)::int n FROM intel.claim WHERE tenant_id = $1"),
    "intel_ro.entity_alias": await q("SELECT count(*)::int n FROM intel.entity e LEFT JOIN intel.alias a ON a.tenant_id = e.tenant_id AND a.entity_id = e.id WHERE e.tenant_id = $1"),
    "intel_ro.finding_recent": await q("SELECT count(*)::int n FROM intel.finding WHERE tenant_id = $1 AND updated_at > now() - interval '30 days'"),
    "intel_ro.ingredient_names": await q("SELECT count(*)::int n FROM core.ingredient WHERE tenant_id = $1"),
    "intel_ro.investigation_current": await q("SELECT count(*)::int n FROM core.investigation WHERE tenant_id = $1"),
    "intel_ro.item_names": await q("SELECT count(*)::int n FROM core.item WHERE tenant_id = $1"),
    "intel_ro.outlet_names": await q("SELECT count(*)::int n FROM core.outlet WHERE tenant_id = $1"),
    "intel_ro.supplier_names": await q("SELECT count(*)::int n FROM core.supplier WHERE tenant_id = $1"),
    "intel_ro.trace_recent": await q("SELECT count(*)::int n FROM intel.trace_event WHERE tenant_id = $1 AND at > now() - interval '7 days'"),
    "intel_ro.wiki_current": await q("SELECT count(*)::int n FROM intel.wiki_page p JOIN intel.wiki_version v ON v.tenant_id = p.tenant_id AND v.page_id = p.id AND v.version = p.current_version WHERE p.tenant_id = $1"),
  };
}

describe("intel_ro views (02-schema §5)", () => {
  test(`as munim_intel_ro: each of the ${INTEL_RO_VIEWS.length} views shows exactly the set tenant's rows (≥ 1), and 0 with no context`, async () => {
    const gotA = await viewCounts(db, A.tenant);
    const gotB = await viewCounts(db, B.tenant);
    const none = await viewCounts(db, null);
    const wantA = await expectedCounts(db, A.tenant);
    const wantB = await expectedCounts(db, B.tenant);
    console.log("intel_ro rows as A:", gotA);
    expect(Object.keys(gotA).sort()).toEqual([...INTEL_RO_VIEWS].sort());
    expect(gotA).toEqual(wantA);
    expect(gotB).toEqual(wantB);
    expect(Object.values(wantA).every((n) => n >= 1)).toBe(true);
    expect(Object.values(none).every((n) => n === 0)).toBe(true);
  });

  test("owned by munim_view_owner; munim_intel_ro has no privilege beyond SELECT on them (INSERT → 42501)", async () => {
    const r = await db.admin(`SELECT c.oid::regclass::text AS v, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'intel_ro' ORDER BY 1`);
    expect(r.rows.map((x) => x.v)).toEqual([...INTEL_RO_VIEWS].sort());
    expect(new Set(r.rows.map((x) => x.owner))).toEqual(new Set(["munim_view_owner"]));
    const e = await attempt(db, "munim_intel_ro", svc(A), "INSERT INTO intel_ro.outlet_names (id, name) VALUES (gen_random_uuid(), 'x')");
    expect(e?.code).toBe("42501");
  });

  test(`finding_recent has exactly ${FINDING_RECENT_COLUMNS.join(", ")} and no numeric column`, async () => {
    const cols = await findingRecentColumns(db);
    console.log("finding_recent columns:", cols);
    expect(cols.map((c) => c.name)).toEqual(FINDING_RECENT_COLUMNS);
    expect(cols.filter((c) => c.numeric)).toEqual([]);
  });

  test("RED-PROOF: a view owned by the superuser bypasses RLS → tenant A sees B's outlets", async () => {
    const x = await db.clone();
    try {
      await x.admin("ALTER VIEW intel_ro.outlet_names OWNER TO postgres");
      const got = await viewCounts(x, A.tenant);
      console.log(`RED-PROOF intel_ro owner: outlet_names as A → ${got["intel_ro.outlet_names"]} (A has ${(await expectedCounts(x, A.tenant))["intel_ro.outlet_names"]})`);
      expect(got).not.toEqual(await expectedCounts(x, A.tenant));
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: confidence_bp added to finding_recent → numeric column found", async () => {
    const x = await db.clone();
    try {
      await x.admin(`GRANT SELECT (confidence_bp) ON intel.finding TO munim_view_owner;
        CREATE OR REPLACE VIEW intel_ro.finding_recent AS SELECT f.id, f.pack, f.type, f.severity, f.status, f.dedupe_key, f.confidence_bp
          FROM intel.finding f WHERE f.updated_at > now() - interval '30 days'`);
      const cols = await findingRecentColumns(x);
      console.log("RED-PROOF finding_recent:", cols.filter((c) => c.numeric));
      expect(cols.filter((c) => c.numeric).map((c) => c.name)).toEqual(["confidence_bp"]);
    } finally {
      await x.stop();
    }
  });
});

async function findingRecentColumns(x: TestDb): Promise<{ name: string; numeric: boolean }[]> {
  const r = await x.admin<{ name: string; numeric: boolean }>(`SELECT a.attname AS name, t.typcategory = 'N' AS numeric FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = 'intel_ro.finding_recent'::regclass AND a.attnum > 0 ORDER BY a.attnum`);
  return r.rows;
}

describe("platform.llm_budget_spent", () => {
  test("a tenant context reads its own budget with spend summed from intel_spend; the operator reads every tenant", async () => {
    const own = await db.withContext("munim_core", svc(A), (c) => c.query("SELECT tenant_id, limit_minor, spent_minor FROM platform.llm_budget_spent"));
    expect(own.rows).toEqual([{ tenant_id: A.tenant, limit_minor: "500000", spent_minor: "15" }]);
    const op = await db.withContext("munim_platform", {}, (c) =>
      c.query("SELECT tenant_id, spent_minor FROM platform.llm_budget_spent WHERE tenant_id = ANY ($1) ORDER BY tenant_id", [[A.tenant, B.tenant]]));
    expect(op.rows.length).toBe(2);
    expect(op.rows.every((r) => r.spent_minor === "15")).toBe(true);
    // the operator reads spend, never writes it, and reads no other intel table
    expect((await attempt(db, "munim_platform", {}, "INSERT INTO intel.intel_spend DEFAULT VALUES"))?.code).toBe("42501");
    expect((await attempt(db, "munim_platform", {}, "SELECT 1 FROM intel.finding"))?.code).toBe("42501");
  });
});
