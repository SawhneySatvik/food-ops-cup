// T-087b gates — specialist desks and track records, through the real app (member token → munim_core under the member's RLS).
//   (1) the list: 8 specialists from the LEDGER F8 hand list (+ the Manager, no Forecast desk)
//   (2) a desk lists its own pack: finance 3 / kitchen 1 findings; drafts by `intel:<id>`; threads by specialist or turn
//   (3) the track record is snapshot refs only (payload scan: planted literal → red); the cells open to the hand values
//   (4) an outlet-A manager sees 0 outlet-B rows on every desk
//   (5) unknown / service / malformed id → 404; kitchen on a store-only scope → 200 applicable:false; staff → no track record
// Expected values are hand counts of the fixture built here, never read back from the code under test.
// Red-proofs (non-zero exit): test/redproof-t087b.sh.
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { SpecialistDesk, SpecialistsResponse, TRACK_RECORD_COUNTS } from "@munim/contracts/specialists";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, TENANT_HEADER, type Deps } from "../src/app.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant; // findings, drafts, threads
let C: Tenant; // a scope with no non-store outlet
let staffSub = "";
let storeSub = "";

// Ledger R45 F8, by hand.
const F8 = ["catalogue", "kitchen", "inventory_purchasing", "finance", "people", "customers", "compliance", "market"];

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const get = async (t: Tenant, sub: string, path: string): Promise<Res> =>
  (await app.request(path, { headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant } })) as Res;
const desk = async (t: Tenant, sub: string, id: string) => {
  const r = await get(t, sub, `/v1/specialists/${id}`);
  expect(r.status).toBe(200);
  return SpecialistDesk.parse(await r.json());
};

/** Every leaf of the track record must be a string: the snapshot id (uuid) or a ⟨snap:…⟩ cell ref. A bare number,
 *  or any other string, is a violation (clause 2). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CELL = /^⟨snap:[0-9a-f-]{36}·0·[a-z_]+⟩$/u;
function violations(v: unknown, path = "track_record"): string[] {
  if (v === null) return [];
  if (typeof v === "string") return UUID.test(v) || CELL.test(v) ? [] : [`${path}: ${v}`];
  if (typeof v !== "object") return [`${path}: ${String(v)}`];
  return Object.entries(v).flatMap(([k, x]) => violations(x, `${path}.${k}`));
}

const envelope = (id: string) => ({ finding_id: id, segments: [], impact_ref: null, abstained: true, reason_code: "count_missing" });

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  C = await buildTenant(db, "c");
  const o0 = A.outlets[0]!;
  const o1 = A.outlets[1]!;
  const svc = { tenant_id: A.tenant, outlet_ids: "*" as const };
  const finding = (c: pg.Client, pack: string, outlet: string, status = "open") => {
    const id = uuidv7();
    return c.query(
      `INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, confidence_bp, envelope, dedupe_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'high', 8000, $7, $8, $9)`,
      [A.tenant, id, A.run, [outlet], pack, `${pack}.fixture`, JSON.stringify(envelope(id)), `${pack}:${id}`, status]);
  };
  // Finance: 3 open (outlet 1, outlet 1, outlet 2) + 1 dismissed (never listed). Kitchen: 1 open at outlet 1. People at outlet 2 (never on finance).
  const draft = (c: pg.Client, source: string, outlet: string) => {
    const id = uuidv7();
    return c.query(
      `INSERT INTO core.draft (tenant_id, id, outlet_ids, source, run_id, command_type, command_payload)
       VALUES ($1, $2, $3, $4, $5, 'inventory.reorder_level.set.v1', $6)`,
      [A.tenant, id, [outlet], source, A.run, JSON.stringify({ outlet_id: outlet, ingredient_id: A.ingredient,
        min_qty_milli: snapRef(A.snapshot, 0, "min_qty_milli"), par_qty_milli: snapRef(A.snapshot, 0, "par_qty_milli") })]).then(() => id);
  };
  const fin: string[] = [];
  await db.withContext("munim_svc", svc, async (c) => {
    for (const [pack, o, st] of [["finance", o0, "open"], ["finance", o0, "open"], ["finance", o1, "open"], ["finance", o0, "dismissed"],
      ["kitchen", o0, "open"], ["people", o1, "open"]] as const) await finding(c, pack, o, st);
    // Finance drafts: 3 approved, 1 edited, 2 rejected, 1 stale (all outlet 1), 1 proposed outlet 1, 1 proposed outlet 2 → proposed 9.
    for (let i = 0; i < 8; i++) fin.push(await draft(c, "intel:finance", o0));
    fin.push(await draft(c, "intel:finance", o1));
    await draft(c, "intel:kitchen", o0);
    await draft(c, "member", o0); // not a specialist's
    let seq = 2;
    for (const actor of ["specialist:finance", "specialist:finance", "branch:finance", "specialist:kitchen"]) {
      await c.query(`INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, kind, actor, payload, at) VALUES ($1, $2, $3, $4, 'abstain', $5, '{}', now())`,
        [A.tenant, A.run, seq++, uuidv7(), actor]);
    }
  });
  await db.withContext("munim_core", ownerCtx(A, { command_type: "drafts.approve.v1" }), async (c) => {
    for (const [d, verdict] of [[fin[0]!, "approved"], [fin[1]!, "approved"], [fin[2]!, "approved"], [fin[3]!, "edited"]] as const) {
      await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE tenant_id = $1 AND id = $2`, [A.tenant, d]);
      await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, $4, '{}', $5)`, [A.tenant, uuidv7(), d, verdict, A.owner]);
      await c.query(`UPDATE core.draft SET status = 'executed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, d]);
    }
    for (const d of [fin[4]!, fin[5]!]) {
      await c.query(`UPDATE core.draft SET status = 'rejected' WHERE tenant_id = $1 AND id = $2`, [A.tenant, d]);
      await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, reason, decided_by) VALUES ($1, $2, $3, 'rejected', 'no', $4)`, [A.tenant, uuidv7(), d, A.owner]);
    }
    await c.query(`UPDATE core.draft SET status = 'stale' WHERE tenant_id = $1 AND id = $2`, [A.tenant, fin[6]]);
  });
  // fin[7] stays proposed at outlet 1, fin[8] proposed at outlet 2.
  // Threads (the world already has a '{*}' finance thread, which an outlet manager must not see): t1 is the finance thread (outlet 1), t2 is a general thread with a finance-addressed
  // turn (outlet 1), t3 is a finance thread at outlet 2, t4 is a kitchen thread.
  const th = { t1: uuidv7(), t2: uuidv7(), t3: uuidv7(), t4: uuidv7() };
  await db.withContext("munim_core", ownerCtx(A, { command_type: "ai.thread.create.v1" }), async (c) => {
    for (const [id, sp, o] of [[th.t1, "finance", o0], [th.t2, null, o0], [th.t3, "finance", o1], [th.t4, "kitchen", o0]] as const) {
      await c.query(`INSERT INTO core.ai_thread (tenant_id, id, specialist, created_by, outlet_scope) VALUES ($1, $2, $3, $4, $5)`, [A.tenant, id, sp, A.owner, [o]]);
    }
    await c.query(`INSERT INTO core.ai_thread_turn (tenant_id, thread_id, turn_no, id, member_id, addressed_to) VALUES ($1, $2, 1, $3, $4, 'finance')`, [A.tenant, th.t2, uuidv7(), A.owner]);
  });
  Object.assign(globalThis, { __t087b: th });
  // C: a store outlet and a manager scoped to it alone (no non-store outlet in scope).
  const store = uuidv7();
  const storeMgr = uuidv7();
  storeSub = `storemgr-${uuidv7()}`;
  await db.withContext("munim_core", ownerCtx(C, { command_type: "tenancy.outlet.create.v1" }), (c) =>
    c.query(`INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address) VALUES ($1, $2, 'Synthetic store', 'store', 'Asia/Kolkata', 'Synthetic address')`, [C.tenant, store]));
  await db.withContext("munim_core", ownerCtx(C, { command_type: "tenancy.member.invite.v1" }), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Store manager', 'store@example.test')`, [C.tenant, storeMgr, storeSub]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [C.tenant, storeMgr, [store]]);
  });
  // A staff member at outlet 1 of A.
  staffSub = `staff-${uuidv7()}`;
  await db.withContext("munim_core", ownerCtx(A, { command_type: "tenancy.member.invite.v1" }), (c) =>
    c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.staff, staffSub]));
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
});
afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("(1) the team", () => {
  it("8 specialists (the ledger F8 hand list) + the Manager; no Forecast desk; each entry carries name, desk, aliases, owned lists", async () => {
    const r = await get(A, A.ownerSub, "/v1/specialists");
    expect(r.status).toBe(200);
    const body = SpecialistsResponse.parse(await r.json());
    expect(body.items.filter((s) => s.kind === "specialist").map((s) => s.id).sort()).toEqual([...F8].sort());
    expect(body.items.filter((s) => s.kind === "manager").map((s) => s.id)).toEqual(["manager"]);
    expect(body.items.length).toBe(9);
    const fin = body.items.find((s) => s.id === "finance")!;
    expect([fin.name_key, fin.desk_key, fin.aliases.includes("accounts")]).toEqual(["specialist.finance.name", "desk.finance", true]);
    expect(fin.detectors).toContain("finance.short_payout");
    expect(fin.templates).toContain("finance.pnl");
    expect(fin.draftables).toContain("finance.period.close.v1");
  });
});

describe("(2) a desk lists its own pack", () => {
  it("owner: finance 3 open findings, kitchen 1, manager 0; drafts by source; threads by specialist or turn", async () => {
    const fin = await desk(A, A.ownerSub, "finance");
    const kit = await desk(A, A.ownerSub, "kitchen");
    const mgr = await desk(A, A.ownerSub, "manager");
    console.log("owner desks: finance findings", fin.findings.length, "kitchen", kit.findings.length, "manager", mgr.findings.length);
    expect([fin.findings.length, kit.findings.length, mgr.findings.length]).toEqual([3, 1, 0]);
    expect(fin.findings.every((f) => f.pack === "finance" && f.status === "open")).toBe(true);
    // Hand: 2 finance drafts still proposed (fin[7] outlet 1, fin[8] outlet 2); 1 kitchen.
    expect([fin.drafts.length, kit.drafts.length]).toEqual([2, 1]);
    expect(fin.drafts.every((d) => d.source === "intel:finance" && d.status === "proposed")).toBe(true);
    // Hand: finance threads: the world's own '{*}' finance thread + t1, t2 (addressed turn), t3; kitchen t4.
    const th = (globalThis as unknown as { __t087b: Record<string, string> }).__t087b;
    expect(fin.threads.map((t) => t.thread_id).sort()).toEqual([A.thread, th.t1, th.t2, th.t3].sort());
    expect(kit.threads.map((t) => t.thread_id)).toEqual([th.t4]);
    expect(mgr.track_record).toBeNull();
    expect(fin.applicable).toBe(true);
  });
});

describe("(3) track record: snapshot refs only", () => {
  it("owner: the response has no count, only the snapshot id + 6 cell refs; the cells open to the hand values", async () => {
    const fin = await desk(A, A.ownerSub, "finance");
    const tr = fin.track_record!;
    const raw = (await (await get(A, A.ownerSub, "/v1/specialists/finance")).json()) as { track_record: unknown };
    expect(violations(raw.track_record)).toEqual([]);
    expect(Object.keys(tr.cells!)).toEqual([...TRACK_RECORD_COUNTS]);
    // Open the minted snapshot as the owner would (GET /v1/snapshots/{id}): hand values from the fixture above.
    const snap = Snapshot.parse(await (await get(A, A.ownerSub, `/v1/snapshots/${tr.snapshot_id}`)).json());
    console.log("owner finance snapshot row:", JSON.stringify(snap.rows[0]));
    expect(snap.template_id).toBe("intel.agent_track_record");
    expect(snap.rows.map((r) => ({ ...r }))).toEqual([{ specialist: "finance", proposed: 9, approved: 3, edited: 1, rejected: 2, stale: 1, abstained: 2 }]);
    for (const k of TRACK_RECORD_COUNTS) expect(tr.cells![k]).toBe(`⟨snap:${tr.snapshot_id}·0·${k}⟩`);
  });

  it("the scanner itself: a planted literal, a stringified count and a stray field are all violations; the clean shape is none", () => {
    const id = uuidv7();
    const clean = { snapshot_id: id, cells: { proposed: `⟨snap:${id}·0·proposed⟩` } };
    expect(violations(clean)).toEqual([]);
    expect(violations({ ...clean, proposed: 9 }).length).toBe(1);
    expect(violations({ ...clean, cells: { proposed: "9" } }).length).toBe(1);
    expect(violations({ ...clean, row_count: 1 }).length).toBe(1);
  });

  it("a specialist with no activity: snapshot id + cells null (0 rows); staff: track_record null (template needs manager)", async () => {
    const people = await desk(A, A.ownerSub, "people");
    expect(people.track_record!.cells).toBeNull();
    const staff = await desk(A, staffSub, "finance");
    expect(staff.track_record).toBeNull();
  });
});

describe("(4) outlet scope", () => {
  it("an outlet-1 manager: 0 findings, drafts, threads of outlet 2 on every desk; finance 2 / draft 1 / threads 2; track record counts that scope", async () => {
    const o1 = A.outlets[1] as string;
    const hidden = new Set((await db.admin(`SELECT id FROM intel.finding WHERE tenant_id = $1 AND outlet_ids = ARRAY[$2]::uuid[]`, [A.tenant, o1])).rows.map((r) => r.id));
    expect(hidden.size).toBe(2); // hand: the finance and people findings at outlet 2
    for (const id of F8) {
      const d = await desk(A, A.managerSub, id);
      expect(d.findings.filter((f) => hidden.has(f.finding_id)).length).toBe(0);
      expect(d.drafts.filter((x) => x.outlet_ids.includes(o1)).length).toBe(0);
    }
    const fin = await desk(A, A.managerSub, "finance");
    const th = (globalThis as unknown as { __t087b: Record<string, string> }).__t087b;
    expect(fin.findings.length).toBe(2); // hand: outlet-1 finance findings (the third is outlet 2)
    expect(fin.drafts.length).toBe(1);
    expect(fin.threads.map((t) => t.thread_id).sort()).toEqual([th.t1, th.t2].sort());
    const snap = Snapshot.parse(await (await get(A, A.managerSub, `/v1/snapshots/${fin.track_record!.snapshot_id}`)).json());
    console.log("manager finance snapshot row:", JSON.stringify(snap.rows[0]));
    // Hand: the outlet-2 proposed draft is not visible; abstains are run-scoped traces with no outlet.
    expect(snap.rows[0]).toMatchObject({ specialist: "finance", proposed: 8, approved: 3, edited: 1, rejected: 2, stale: 1 });
    const p = await desk(A, A.managerSub, "people"); // the people finding is at outlet 2 only
    expect(p.findings.length).toBe(0);
  });
});

describe("(5) ids and applicability", () => {
  it("unknown, the Forecast service, a UUID and a mixed-case id → 404 (same body); a good id is 200", async () => {
    const bodies = [];
    for (const id of ["nope", "forecast", uuidv7(), "Finance", "finance%20", "catalogue-x"]) {
      const r = await get(A, A.ownerSub, `/v1/specialists/${id}`);
      expect(r.status).toBe(404);
      bodies.push(JSON.stringify(await r.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await get(A, A.ownerSub, "/v1/specialists/finance")).status).toBe(200);
    expect((await app.request("/v1/specialists/finance")).status).toBe(401);
  });

  it("kitchen on a store-only scope → 200 applicable:false, empty lists; the owner of the same tenant (restaurant outlets in scope) → applicable", async () => {
    const k = await desk(C, storeSub, "kitchen");
    expect([k.applicable, k.findings.length, k.drafts.length, k.threads.length, k.track_record]).toEqual([false, 0, 0, 0, null]);
    expect((await desk(C, C.ownerSub, "kitchen")).applicable).toBe(true);
    expect((await desk(C, storeSub, "finance")).applicable).toBe(true);
  });
});
