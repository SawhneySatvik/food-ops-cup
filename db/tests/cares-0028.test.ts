// 0028 gates (Munim Cares, ADR-015 §1, §2.3, §8 M-D; migrator lane m-d, fix cycle fx-md). Expected values are hand-typed
// from the ADR and the fixtures built here (never read from the migration or the database under test).
//   BOOK   the nine core tables: munim:book, forced RLS, shoppers see and write nothing; book_scope and transitions as typed.
//   SVC    munim_svc holds no write privilege on the 13 tables; munim_intel_ro none at all (N/N is grants.test.ts).
//   GUARD  an unadmitted book write → MB001; a command that does not list the table → MB008; each row operation belongs
//          to one command (MB004); a listing closes only with a hand-over recorded in the same transaction; actor columns
//          are the signed-in member (MB005); a cooked line is never published through a draft (MB004).
//   ROWS   row rules: donation priced / offer unpriced / offer cooked / pickup_on mismatch / donation hand-over with an
//          allocation → 23514; lines on a non-published listing, a claim created non-requested, a hand-over of a withdrawn
//          or not-yet-allocated listing, an accepted allocation of a withdrawn offer → MB004.
//   SUM    Σ hand-over above the listing line → MB001 (exactly the line → accepted; a void frees it); two concurrent
//          hand-overs whose sum exceeds the line → exactly one commits (the listing row lock); a withdraw committed between
//          a hand-over's header and its line → MB004 (re-read under the lock).
//   VOID   a second void → MB004; an un-void → MB004.
//   REV    the cumulative void binding refuses an over-reversal (MB001); the four kinds pass with their signs (23514
//          else); a hand-over's kg + g movement pair over the line → MB001 (base unit).
//   ALLOC  a second accepted allocation for one offer → 23505; an offer's hand-over needs its accepted allocation.
//   RECV   a real two-tenant flow: received_qty_milli = the handed qty (else MB004), set once (MB004); received needs the
//          accepted allocation (23514 without, MB004 another).
//   DEF    the five definer functions: owner, EXECUTE, read-only; non-party / forged member / no context → 0 rows, the
//          party ≥ 1; staff outside the outlet → 0, inside ≥ 1; the network shows exactly 1 live donation (retired, judge,
//          not enabled, paused, withdrawn, expired, retired recipient, offer → absent); market offers both sides; claim
//          outcome never a status oracle; operator-only impact, never under a tenant context.
//   TPL    only an operator platform.* template may reference a definer; the member templates on hand-typed fixtures.
//   REC    recipient CHECKs: simulated = false → 23514; a name without "(simulated)" → 23514.
//   NET    a network snapshot: operator template only; minted unpublished; published once, by a draft that targets it and
//          is approved in the same transaction; rows immutable. Enablement: likewise per tenant.
// Red-proofs: db/tests/redproof-0028.sh (each gate red with a non-zero exit).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AppContext, setContext, type TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt, intelWriteRefusals } from "./gates.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

const u = uuidv7;
/** Pickups of the hand-over / allocation fixtures: ten years back — never live, never in the 10 Oct 2026 impact window. */
const PAST = -87_600;
let db: TestDb;
/** A: the hand-over / B2B-offerer world. Bu: a buyer in the same city. R, J, N, P: retired, judge, not enabled, paused.
 *  Q: Cares on, b2b off. */
let A: World, Bu: World, R: World, J: World, N: World, P: World, Q: World;
let recipient: string;
let operator: string;
let liveA: string;
let offerA: string;
let offerLineA: string;
let claimBu: string;
let staffOut: string;
let staffOutBu: string;
let managerA: string;
/** Live offers of R, J, N, P, Q (none may reach a buyer). */
const hiddenOffers: Record<string, string> = {};
/** Bu's claims naming listings no buyer may read a status of: A's live donation, J's and Q's live offers. */
const oracleClaims: Record<string, string> = {};

const CORE9 = ["core.cares_profile", "core.cares_outlet", "core.cares_listing", "core.cares_listing_line", "core.cares_handover",
  "core.cares_handover_line", "core.cares_claim", "core.cares_claim_line", "core.cares_allocation"];
const PLAT4 = ["platform.cares_city", "platform.cares_recipient", "platform.cares_enablement", "platform.network_snapshot"];

const own = (w: World, cmd: string, extra: AppContext = {}) => ownerCtx(w, { command_type: cmd, ...extra });
const run = (ctx: AppContext, sql: string, params: unknown[] = []) => db.withContext("munim_core", ctx, (c) => c.query(sql, params));
const derive = (w: World, rule: string, source: string): AppContext => ({ tenant_id: w.tenant, outlet_ids: "*", posting_rule: rule, source_ref: source });
const member = (w: World, id: string, role: string, outlets: "*" | string[] = "*"): AppContext => ({ tenant_id: w.tenant, outlet_ids: outlets, role, member_id: id });
const code = (p: Promise<unknown>) => p.then(() => "accepted", (e: { code?: string }) => e.code ?? "?");
/** One transaction as `role` (committed), its error code or "accepted" — deferred checks surface at COMMIT. */
const tx = (role: Parameters<TestDb["withContext"]>[0], ctx: AppContext, fn: (c: pg.Client) => Promise<unknown>) =>
  code(db.withContext(role, ctx, fn as (c: pg.Client) => Promise<never>));

/** A listing (one raw line of the world's paneer) whose pickup starts `hours` from now. */
async function publish(w: World, kind: "donation" | "offer", hours: number, k: 0 | 1 = 0, qty = 300000, batch: string | null = null, rcpt = recipient) {
  const id = u();
  const line = u();
  await db.withContext("munim_core", own(w, "cares.listing.publish.v1"), async (c) => {
    await c.query(`INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
                   SELECT $1, $2, $3, $4, $5, now() + make_interval(hours => $6), now() + make_interval(hours => $6 + 2),
                          (((now() + make_interval(hours => $6)) AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date, $7
                     FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $3`,
      [w.tenant, id, w.outlets[k], kind, kind === "donation" ? rcpt : null, hours, w.owner]);
    await c.query(`INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, batch_id, qty_milli, unit, unit_price_minor, currency)
                   VALUES ($1, $2, $3, 1, 'raw', $4, $5, $6, 'g', $7, $8)`,
      [w.tenant, line, id, w.ingredient, batch, qty, kind === "offer" ? 25 : null, kind === "offer" ? w.currency : null]);
  });
  return { id, line };
}

const handoverSql = [`INSERT INTO core.cares_handover (tenant_id, id, listing_id, outlet_id, allocation_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)`,
  `INSERT INTO core.cares_handover_line (tenant_id, id, handover_id, listing_line_id, qty_milli) VALUES ($1, $2, $3, $4, $5)`] as const;

async function handover(w: World, listing: string, line: string, qty: number, allocation: string | null = null, k: 0 | 1 = 0) {
  const id = u();
  await db.withContext("munim_core", own(w, "cares.handover.record.v1"), async (c) => {
    await c.query(handoverSql[0], [w.tenant, id, listing, w.outlets[k], allocation, w.owner]);
    await c.query(handoverSql[1], [w.tenant, u(), id, line, qty]);
  });
  return id;
}

/** Accept a claim on an offer, as the offerer's owner, and move the offer to allocated (the decide handler's two writes). */
async function accept(w: World, listing: string, claimTenant: string, claim: string, total = 7500) {
  const id = u();
  await db.withContext("munim_core", own(w, "cares.claim.decide.v1"), async (c) => {
    await c.query(`INSERT INTO core.cares_allocation (tenant_id, id, listing_id, outlet_id, claim_tenant_id, claim_id, buyer_public_name, verdict,
                   total_minor, currency, decided_by) VALUES ($1, $2, $3, $4, $5, $6, 'Synthetic Kitchen', 'accepted', $7, $8, $9)`,
      [w.tenant, id, listing, w.outlets[0], claimTenant, claim, total, w.currency, w.owner]);
    await c.query(`UPDATE core.cares_listing SET status = 'allocated' WHERE tenant_id = $1 AND id = $2`, [w.tenant, listing]);
  });
  return id;
}

/** The buyer's claim on another tenant's offer (one line; ids of the offerer's rows as plain uuids). */
async function claim(buyer: World, offerTenant: string, offerListing: string, offerLine: string, qty = 300000) {
  const id = u();
  const line = u();
  await db.withContext("munim_core", own(buyer, "cares.claim.create.v1"), async (c) => {
    await c.query(`INSERT INTO core.cares_claim (tenant_id, id, outlet_id, offer_tenant_id, offer_listing_id, total_minor, currency, created_by)
                   VALUES ($1, $2, $3, $4, $5, 7500, $6, $7)`, [buyer.tenant, id, buyer.outlets[0], offerTenant, offerListing, buyer.currency, buyer.owner]);
    await c.query(`INSERT INTO core.cares_claim_line (tenant_id, id, claim_id, offer_line_id, ingredient_id, qty_milli, unit, unit_price_minor)
                   VALUES ($1, $2, $3, $4, $5, $6, 'g', 25)`, [buyer.tenant, line, id, offerLine, buyer.ingredient, qty]);
  });
  return { id, line };
}

const movement = (w: World, kind: string, qty: number, refType: string, refId: string, batch: string | null = null, unit = "g") =>
  [`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id)
    VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9)`, [w.tenant, w.outlets[0], w.ingredient, batch, qty, unit, kind, refType, refId]] as [string, unknown[]];

/** A config draft proposed by the test operator; `approve` flips it to applied in the same transaction (platform/drafts.ts). */
const proposeDraft = async (c: pg.Client, target: string) => {
  const id = u();
  await c.query(`INSERT INTO platform.config_draft (id, target, patch, proposed_by) VALUES ($1, $2, '{}', $3)`, [id, target, `operator:${operator}`]);
  return id;
};
const approve = (c: pg.Client, id: string) =>
  c.query(`UPDATE platform.config_draft SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [id, operator]);
/** Sets a tenant's enablement through a config draft for `target` (default its own), approved in the same transaction or not. */
const setEnablement = (w: World, enabled: boolean, opts: { approve?: boolean; target?: string } = {}) =>
  tx("munim_platform", {}, async (c) => {
    const d = await proposeDraft(c, opts.target ?? `cares_enablement:${w.tenant}`);
    await c.query(`UPDATE platform.cares_enablement SET enabled = $2, config_draft_id = $3 WHERE tenant_id = $1`, [w.tenant, enabled, d]);
    if (opts.approve ?? true) await approve(c, d);
  });

/** Named params → $n (the Cares templates hold no literals, comments or dollar quotes with a colon; `::` is a cast). */
function bind(t: string): { sql: string; names: string[] } {
  const names: string[] = [];
  const sql = t.replace(/(?<!:):([a-z_][a-z0-9_]*)/g, (_m, n: string) => {
    if (!names.includes(n)) names.push(n);
    return `$${names.indexOf(n) + 1}`;
  });
  return { sql, names };
}

/** Polls until `pid` waits on a lock or `done()` holds (bounded: a hang is a failure, not a pass). */
async function waitForLockOr(pid: number, done: () => boolean): Promise<"waiting" | "done"> {
  for (let i = 0; i < 200; i++) {
    if (done()) return "done";
    const r = await db.admin<{ w: string | null }>(`SELECT wait_event_type w FROM pg_stat_activity WHERE pid = $1`, [pid]);
    if (r.rows[0]?.w === "Lock") return "waiting";
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`backend ${pid} neither waited on a lock nor finished within 10 s`);
}

beforeAll(async () => {
  db = await openDb();
  [A, Bu, R, J, N, P, Q] = [await buildWorld(db), await buildWorld(db), await buildWorld(db), await buildWorld(db), await buildWorld(db), await buildWorld(db),
    await buildWorld(db)];
  recipient = (await db.admin<{ id: string }>(`SELECT recipient_id id FROM core.cares_listing WHERE tenant_id = $1 AND kind = 'donation' LIMIT 1`, [A.tenant])).rows[0]!.id;
  operator = u();
  await db.withContext("munim_platform", {}, (c) => c.query(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'cares-op@example.test')`, [operator, `sub-${operator}`]));

  // The network: one live donation at A (plus a withdrawn one, an offer, and one whose recipient is then retired); one live
  // donation and one live offer at each of R (then retired), J (gains a judge), N (enablement off), P (profile paused);
  // one live offer at Q (b2b off).
  liveA = (await publish(A, "donation", 2)).id;
  const withdrawn = (await publish(A, "donation", 3)).id;
  await run(own(A, "cares.listing.withdraw.v1"), `UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [A.tenant, withdrawn]);
  const retiring = u();
  await db.withContext("munim_platform", {}, (c) => c.query(`INSERT INTO platform.cares_recipient (id, city_code, name, kind, simulated, accepts_cooked, accepts_raw,
    accepts_packaged, capacity_kg_per_day, capacity_portions_per_day, receiving_from, receiving_to, lat_e6, lng_e6)
    VALUES ($1, 'mumbai', 'Old Mill Pantry (simulated)', 'ngo', true, true, true, true, 50, 100, '16:00', '21:00', 19080000, 72880000)`, [retiring]));
  await publish(A, "donation", 2, 0, 300000, null, retiring);
  await db.withContext("munim_platform", {}, (c) => c.query(`UPDATE platform.cares_recipient SET status = 'retired' WHERE id = $1`, [retiring]));
  for (const w of [R, J, N, P]) await publish(w, "donation", 2);
  for (const w of [R, J, N, P, Q]) hiddenOffers[w.tenant] = (await publish(w, "offer", 2)).id;
  await run(own(R, "tenancy.tenant.update.v1"), `UPDATE core.tenant SET status = 'retired' WHERE tenant_id = $1`, [R.tenant]);
  const judge = u();
  await db.withContext("munim_core", own(J, "tenancy.member.invite.v1"), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email, is_ephemeral_judge) VALUES ($1, $2, 'Judge', 'judge@example.test', true)`, [J.tenant, judge]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'judge')`, [J.tenant, judge]);
  });
  expect(await setEnablement(N, false)).toBe("accepted");
  await run(own(P, "cares.profile.set.v1"), `UPDATE core.cares_profile SET status = 'paused' WHERE tenant_id = $1`, [P.tenant]);
  await run(own(Q, "cares.profile.set.v1"), `UPDATE core.cares_profile SET b2b_enabled = false WHERE tenant_id = $1`, [Q.tenant]);

  // B2B: A offers (live), Bu claims it; A's second staff member works only at outlet 2; A has a manager.
  const offer = await publish(A, "offer", 4);
  offerA = offer.id;
  offerLineA = offer.line;
  claimBu = (await claim(Bu, A.tenant, offerA, offerLineA)).id;
  oracleClaims.donation = (await claim(Bu, A.tenant, liveA, u())).id;
  oracleClaims.judge = (await claim(Bu, J.tenant, hiddenOffers[J.tenant]!, u())).id;
  oracleClaims.nonB2b = (await claim(Bu, Q.tenant, hiddenOffers[Q.tenant]!, u())).id;
  staffOut = u();
  managerA = u();
  await db.withContext("munim_core", own(A, "tenancy.member.invite.v1"), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Staff Two', 'staff2@example.test'), ($1, $3, 'Manager', 'manager@example.test')`,
      [A.tenant, staffOut, managerA]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'staff', $3), ($1, $4, 'manager', $5)`,
      [A.tenant, staffOut, [A.outlets[1]], managerA, [A.outlets[0]]]);
  });
  staffOutBu = u();
  await db.withContext("munim_core", own(Bu, "tenancy.member.invite.v1"), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Staff Two', 'staff2@example.test')`, [Bu.tenant, staffOutBu]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'staff', $3)`, [Bu.tenant, staffOutBu, [Bu.outlets[1]]]);
  });
}, 600_000);
afterAll(async () => db?.stop());

describe("BOOK — the nine core tables", () => {
  test("munim:book, RLS forced, book_scope and status transitions exactly as typed (ADR-015 §1.2)", async () => {
    const r = await db.admin<{ t: string; tag: string; rls: boolean; force: boolean }>(`SELECT t, obj_description(t::regclass, 'pg_class') tag,
      c.relrowsecurity rls, c.relforcerowsecurity force FROM unnest($1::text[]) t JOIN pg_class c ON c.oid = t::regclass`, [CORE9]);
    const bad = r.rows.filter((x) => x.tag !== "munim:book" || !x.rls || !x.force).map((x) => x.t);
    console.log(`BOOK: ${r.rows.length - bad.length}/9 tagged munim:book with forced RLS`);
    expect(r.rows.length).toBe(9);
    expect(bad).toEqual([]);
    const scope = (await db.admin(`SELECT table_name || ':' || outlet_kind || ':' || coalesce(parent_table, '-') s FROM core.book_scope WHERE table_name LIKE 'core.cares%' ORDER BY 1`)).rows.map((x) => x.s);
    expect(scope).toEqual(["core.cares_allocation:column:-", "core.cares_claim:column:-", "core.cares_claim_line:parent:core.cares_claim",
      "core.cares_handover:column:-", "core.cares_handover_line:parent:core.cares_handover", "core.cares_listing:column:-",
      "core.cares_listing_line:parent:core.cares_listing", "core.cares_outlet:column:-", "core.cares_profile:none:-"]);
    const tr = (await db.admin(`SELECT table_name || ':' || from_status || '>' || to_status s FROM core.book_status_transition WHERE table_name LIKE 'core.cares%' ORDER BY 1`)).rows.map((x) => x.s);
    expect(tr).toEqual(["core.cares_claim:requested>cancelled", "core.cares_claim:requested>closed", "core.cares_claim:requested>received",
      "core.cares_handover:recorded>voided", "core.cares_listing:allocated>closed", "core.cares_listing:published>allocated",
      "core.cares_listing:published>closed", "core.cares_listing:published>withdrawn", "core.cares_profile:active>paused", "core.cares_profile:paused>active"]);
  });

  test("shoppers: a customer or guest context sees 0 rows of each, where the owner sees ≥ 1, and writes nothing", async () => {
    const fails: string[] = [];
    for (const t of CORE9) {
      const n = async (ctx: AppContext) => (await run(ctx, `SELECT count(*)::int n FROM ${t}`)).rows[0].n as number;
      const [o, cu, g] = [await n(member(A, A.owner, "owner")), await n({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: u() }),
        await n({ tenant_id: A.tenant, outlet_ids: [], role: "guest", guest_access_hash: "00".repeat(32) })];
      if (o < 1 || cu !== 0 || g !== 0) fails.push(`${t}: owner ${o}, customer ${cu}, guest ${g}`);
    }
    const upd = (ctx: AppContext) => run({ ...ctx, command_type: "cares.profile.set.v1" }, `UPDATE core.cares_profile SET public_name = public_name WHERE tenant_id = $1`, [A.tenant]);
    const [cust, ownr] = [await upd({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: u() }), await upd(member(A, A.owner, "owner"))];
    console.log(`BOOK shoppers: ${9 - fails.length}/9 hidden from customer and guest; customer update → ${cust.rowCount} rows, owner → ${ownr.rowCount}`);
    expect(fails).toEqual([]);
    expect([cust.rowCount, ownr.rowCount]).toEqual([0, 1]);
  });
});

describe("SVC — service and intel privileges on the 13 new tables", () => {
  test("munim_svc: SELECT only (not network_snapshot); munim_intel_ro: nothing; intel writes refused 52/52", async () => {
    const r = await db.admin<{ t: string; w: boolean; s: boolean; i: boolean }>(`SELECT t,
        has_table_privilege('munim_svc', t, 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('munim_svc', t, 'INSERT,UPDATE') w,
        has_table_privilege('munim_svc', t, 'SELECT') s,
        has_table_privilege('munim_intel_ro', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('munim_intel_ro', t, 'SELECT,INSERT,UPDATE') i
      FROM unnest($1::text[]) t`, [[...CORE9, ...PLAT4]]);
    const nonSelect = r.rows.filter((x) => x.w).length;
    console.log(`SVC: munim_svc non-SELECT privileges on ${nonSelect}/13 tables; SELECT on ${r.rows.filter((x) => x.s).length}; intel on ${r.rows.filter((x) => x.i).length}`);
    expect(r.rows.length).toBe(13);
    expect(nonSelect).toBe(0);
    expect(r.rows.filter((x) => x.s).map((x) => x.t).sort()).toEqual([...CORE9, ...PLAT4].filter((t) => t !== "platform.network_snapshot").sort());
    expect(r.rows.filter((x) => x.i)).toEqual([]);
    const intel = await intelWriteRefusals(db, [...CORE9, ...PLAT4]);
    expect(intel.attempts).toBe(52);
    expect(intel.failures).toEqual([]);
  });
});

describe("GUARD — book writes need a person's own command", () => {
  test("no command → MB001; a command that does not list the table → MB008; a manager may withdraw, a staff member may not publish", async () => {
    const sql = `INSERT INTO core.cares_profile (tenant_id, id, public_name) VALUES ($1, gen_random_uuid(), 'Second')`;
    const none = await attempt(db, "munim_core", member(A, A.owner, "owner"), sql, [A.tenant]);
    const wrong = await attempt(db, "munim_core", own(A, "cares.claim.create.v1"), `UPDATE core.cares_listing SET status = 'closed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, liveA]);
    const svc = await attempt(db, "munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, sql, [A.tenant]);
    console.log(`GUARD: no command → ${none?.code}; claim.create writing a listing → ${wrong?.code}; munim_svc → ${svc?.code}`);
    expect(none?.code).toBe("MB001");
    expect(wrong?.code).toBe("MB008");
    expect(svc?.code).toBe("42501");
    const l = (await publish(A, "donation", PAST)).id;
    const withdraw = (ctx: AppContext) => attempt(db, "munim_core", { ...ctx, command_type: "cares.listing.withdraw.v1" },
      `UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [A.tenant, l]);
    const staffPublishes = await attempt(db, "munim_core", { ...member(A, A.staff, "staff", [A.outlets[0]]), command_type: "cares.listing.publish.v1" },
      `UPDATE core.cares_listing SET status = 'closed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, l]);
    const managerWithdraws = await withdraw(member(A, managerA, "manager", [A.outlets[0]]));
    console.log(`GUARD roles: staff under publish → ${staffPublishes?.code}; manager withdraws → ${managerWithdraws?.code ?? "accepted"}`);
    expect(staffPublishes?.code).toBe("MB001");
    expect(managerWithdraws).toBeNull();
    expect((await db.admin(`SELECT status FROM core.cares_listing WHERE tenant_id = $1 AND id = $2`, [A.tenant, l])).rows[0]!.status).toBe("withdrawn");
  });
});

describe("GUARD — each Cares row operation belongs to one command", () => {
  test("a staff hand-over closes a listing only with a hand-over recorded in the same transaction; never withdraws or allocates (MB004)", async () => {
    const [l1, l2, l3] = [await publish(A, "donation", PAST), await publish(A, "donation", PAST), await publish(A, "donation", PAST)];
    const staffCtx = { ...member(A, A.staff, "staff", [A.outlets[0]]), command_type: "cares.handover.record.v1" };
    const set = (cmd: string, status: string, id: string, ctx = member(A, A.staff, "staff", [A.outlets[0]])) =>
      attempt(db, "munim_core", { ...ctx, command_type: cmd }, `UPDATE core.cares_listing SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, id, status]);
    const close = `UPDATE core.cares_listing SET status = 'closed' WHERE tenant_id = $1 AND id = $2`;
    // l2: a hand-over recorded in an earlier transaction; l3: recorded and closed in one.
    const h2 = u();
    await db.withContext("munim_core", staffCtx, async (c) => {
      await c.query(handoverSql[0], [A.tenant, h2, l2.id, A.outlets[0], null, A.staff]);
      await c.query(handoverSql[1], [A.tenant, u(), h2, l2.line, 1000]);
    });
    const r = {
      handoverWithdraws: (await set("cares.handover.record.v1", "withdrawn", l1.id))?.code ?? "accepted",
      handoverAllocates: (await set("cares.handover.record.v1", "allocated", l1.id))?.code ?? "accepted",
      withdrawCloses: (await set("cares.listing.withdraw.v1", "closed", l1.id, member(A, A.owner, "owner")))?.code ?? "accepted",
      closesWithoutHandover: (await set("cares.handover.record.v1", "closed", l1.id))?.code ?? "accepted",
      closesOnEarlierHandover: (await set("cares.handover.record.v1", "closed", l2.id))?.code ?? "accepted",
      closesWithItsHandover: await tx("munim_core", staffCtx, async (c) => {
        const h = u();
        await c.query(handoverSql[0], [A.tenant, h, l3.id, A.outlets[0], null, A.staff]);
        await c.query(handoverSql[1], [A.tenant, u(), h, l3.line, 1000]);
        await c.query(close, [A.tenant, l3.id]);
      }),
    };
    console.log("GUARD listing moves:", r);
    expect(r).toEqual({ handoverWithdraws: "MB004", handoverAllocates: "MB004", withdrawCloses: "MB004", closesWithoutHandover: "MB004",
      closesOnEarlierHandover: "MB004", closesWithItsHandover: "accepted" });
  });

  test("inserts and moves under a sibling command → MB004 (staff record inserts a listing / voids; receive cancels or inserts a claim; create sets received)", async () => {
    const staff = (cmd: string): AppContext => ({ ...member(A, A.staff, "staff", [A.outlets[0]]), command_type: cmd });
    const mgr = (cmd: string): AppContext => ({ ...member(A, A.owner, "owner"), command_type: cmd });
    const l = await publish(A, "donation", PAST);
    const h = await handover(A, l.id, l.line, 1000);
    const c = await claim(A, Bu.tenant, u(), u(), 1000);
    // A real accepted, handed-over claim (A offers, Bu claims, A hands over 1000): only the command can refuse its receive.
    const offer = await publish(A, "offer", PAST);
    const bc = await claim(Bu, A.tenant, offer.id, offer.line, 1000);
    await handover(A, offer.id, offer.line, 1000, await accept(A, offer.id, Bu.tenant, bc.id));
    const setReceived = (cmd: string) => attempt(db, "munim_core", own(Bu, cmd),
      `UPDATE core.cares_claim_line SET received_qty_milli = 1000 WHERE tenant_id = $1 AND id = $2`, [Bu.tenant, bc.line]);
    const listingSql = `INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
      SELECT $1, gen_random_uuid(), $2, 'donation', $3, now() - interval '9 days', now() - interval '8 days', ((now() - interval '9 days') AT TIME ZONE ou.tz - ou.business_day_cutoff)::date, $4
        FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $2`;
    const claimSql = `INSERT INTO core.cares_claim (tenant_id, id, outlet_id, offer_tenant_id, offer_listing_id, total_minor, currency, created_by) VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, $5, $6)`;
    const r = {
      recordInsertsListing: (await attempt(db, "munim_core", staff("cares.handover.record.v1"), listingSql, [A.tenant, A.outlets[0], recipient, A.staff]))?.code ?? "accepted",
      recordVoids: (await attempt(db, "munim_core", staff("cares.handover.record.v1"),
        `UPDATE core.cares_handover SET status = 'voided', voided_by = $3, void_reason_code = 'x' WHERE tenant_id = $1 AND id = $2`, [A.tenant, h, A.staff]))?.code ?? "accepted",
      receiveCancels: (await attempt(db, "munim_core", staff("cares.claim.receive.v1"),
        `UPDATE core.cares_claim SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2`, [A.tenant, c.id]))?.code ?? "accepted",
      receiveInsertsClaim: (await attempt(db, "munim_core", staff("cares.claim.receive.v1"), claimSql, [A.tenant, A.outlets[0], Bu.tenant, u(), A.currency, A.staff]))?.code ?? "accepted",
      createSetsReceived: (await setReceived("cares.claim.create.v1"))?.code ?? "accepted",
      // Paired accepts: the owning command.
      voidVoids: (await attempt(db, "munim_core", mgr("cares.handover.void.v1"),
        `UPDATE core.cares_handover SET status = 'voided', voided_by = $3, void_reason_code = 'x' WHERE tenant_id = $1 AND id = $2`, [A.tenant, h, A.owner]))?.code ?? "accepted",
      cancelCancels: (await attempt(db, "munim_core", mgr("cares.claim.cancel.v1"),
        `UPDATE core.cares_claim SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2`, [A.tenant, c.id]))?.code ?? "accepted",
      receiveSetsReceived: (await setReceived("cares.claim.receive.v1"))?.code ?? "accepted",
    };
    console.log("GUARD sibling commands:", r);
    expect(r).toEqual({ recordInsertsListing: "MB004", recordVoids: "MB004", receiveCancels: "MB004", receiveInsertsClaim: "MB004",
      createSetsReceived: "MB004", voidVoids: "accepted", cancelCancels: "accepted", receiveSetsReceived: "accepted" });
  });

  test("an approved publish draft executes as its own command (raw line → accepted); a cooked line only by the owner's own command", async () => {
    const listingSql = `INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
      SELECT $1, $2, $3, 'donation', $4, now() - interval '9 days', now() - interval '8 days', ((now() - interval '9 days') AT TIME ZONE ou.tz - ou.business_day_cutoff)::date, $5
        FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $3`;
    const rawSql = `INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, 1, 'raw', $4, 1000, 'g')`;
    const cookedSql = `INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, item_id, qty_milli, unit) VALUES ($1, $2, $3, 1, 'cooked', $4, 6000, 'portion')`;
    const id = u();
    await approveDraft(db, A, "cares.listing.publish.v1", async (q) => {
      await q(listingSql, [A.tenant, id, A.outlets[0], recipient, A.owner]);
      await q(rawSql, [A.tenant, u(), id, A.ingredient]);
    });
    const o = (await db.admin(`SELECT origin FROM core.cares_listing WHERE tenant_id = $1 AND id = $2`, [A.tenant, id])).rows[0]!.origin;
    const viaDraft = await code(approveDraft(db, A, "cares.listing.publish.v1", async (q) => {
      const l = u();
      await q(listingSql, [A.tenant, l, A.outlets[0], recipient, A.owner]);
      await q(cookedSql, [A.tenant, u(), l, A.item]);
    }));
    const ownCmd = await tx("munim_core", own(A, "cares.listing.publish.v1"), async (c) => {
      const l = u();
      await c.query(listingSql, [A.tenant, l, A.outlets[0], recipient, A.owner]);
      await c.query(cookedSql, [A.tenant, u(), l, A.item]);
    });
    console.log("GUARD decision path: listing origin", o, `; cooked via draft → ${viaDraft}, own command → ${ownCmd}`);
    expect(o.kind).toBe("decision");
    expect([viaDraft, ownCmd]).toEqual(["MB004", "accepted"]);
  });

  test("actor columns are the signed-in member (MB005): published_by, recorded_by, voided_by, created_by, decided_by", async () => {
    const other = A.staff; // a real member of A, but not the one signed in
    const offer = await publish(A, "offer", PAST);
    const l = await publish(A, "donation", PAST);
    const h = await handover(A, l.id, l.line, 1000);
    const r = {
      published_by: (await attempt(db, "munim_core", own(A, "cares.listing.publish.v1"), `INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id,
        pickup_from, pickup_to, pickup_on, published_by) SELECT $1, gen_random_uuid(), $2, 'donation', $3, now() - interval '9 days', now() - interval '8 days',
        ((now() - interval '9 days') AT TIME ZONE ou.tz - ou.business_day_cutoff)::date, $4 FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $2`,
        [A.tenant, A.outlets[0], recipient, other]))?.code,
      recorded_by: (await attempt(db, "munim_core", own(A, "cares.handover.record.v1"), handoverSql[0], [A.tenant, u(), l.id, A.outlets[0], null, other]))?.code,
      voided_by: (await attempt(db, "munim_core", own(A, "cares.handover.void.v1"),
        `UPDATE core.cares_handover SET status = 'voided', voided_by = $3, void_reason_code = 'x' WHERE tenant_id = $1 AND id = $2`, [A.tenant, h, other]))?.code,
      created_by: (await attempt(db, "munim_core", own(A, "cares.claim.create.v1"), `INSERT INTO core.cares_claim (tenant_id, id, outlet_id, offer_tenant_id,
        offer_listing_id, total_minor, currency, created_by) VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, $5, $6)`, [A.tenant, A.outlets[0], Bu.tenant, u(), A.currency, other]))?.code,
      decided_by: (await attempt(db, "munim_core", own(A, "cares.claim.decide.v1"), `INSERT INTO core.cares_allocation (tenant_id, id, listing_id, outlet_id,
        claim_tenant_id, claim_id, buyer_public_name, verdict, total_minor, currency, decided_by) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'B', 'declined', 1, $6, $7)`,
        [A.tenant, offer.id, A.outlets[0], Bu.tenant, u(), A.currency, other]))?.code,
    };
    console.log("GUARD actors:", r);
    expect(r).toEqual({ published_by: "MB005", recorded_by: "MB005", voided_by: "MB005", created_by: "MB005", decided_by: "MB005" });
  });
});

describe("ROWS — row rules", () => {
  test("donation priced, offer unpriced, offer cooked, pickup_on mismatch, donation hand-over with an allocation → 23514; lines on a non-published listing, a claim created non-requested → MB004", async () => {
    const withdrawn = await publish(A, "donation", PAST);
    await run(own(A, "cares.listing.withdraw.v1"), `UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [A.tenant, withdrawn.id]);
    const [don, off] = [await publish(A, "donation", PAST), await publish(A, "offer", PAST)];
    const line = (listing: string, kind: string, subject: string, unit: string, price: number | null) => attempt(db, "munim_core", own(A, "cares.listing.publish.v1"),
      `INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ${kind === "cooked" ? "item_id" : "ingredient_id"}, qty_milli, unit, unit_price_minor, currency)
       VALUES ($1, gen_random_uuid(), $2, 9, $3, $4, 1000, $5, $6, $7)`, [A.tenant, listing, kind, subject, unit, price, price === null ? null : A.currency]);
    const r = {
      donationPriced: (await line(don.id, "raw", A.ingredient, "g", 25))?.code,
      offerUnpriced: (await line(off.id, "raw", A.ingredient, "g", null))?.code,
      offerCooked: (await line(off.id, "cooked", A.item, "portion", 25))?.code,
      lineOnWithdrawn: (await line(withdrawn.id, "raw", A.ingredient, "g", null))?.code,
      pickupOnMismatch: (await attempt(db, "munim_core", own(A, "cares.listing.publish.v1"), `INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind,
        recipient_id, pickup_from, pickup_to, pickup_on, published_by) VALUES ($1, gen_random_uuid(), $2, 'donation', $3, '2026-10-10T12:30:00Z', '2026-10-10T14:30:00Z',
        '2026-10-11', $4)`, [A.tenant, A.outlets[0], recipient, A.owner]))?.code,
      donationHandoverWithAllocation: (await attempt(db, "munim_core", own(A, "cares.handover.record.v1"), handoverSql[0],
        [A.tenant, u(), don.id, A.outlets[0], u(), A.owner]))?.code,
      claimCreatedCancelled: (await attempt(db, "munim_core", own(A, "cares.claim.create.v1"), `INSERT INTO core.cares_claim (tenant_id, id, outlet_id, offer_tenant_id,
        offer_listing_id, status, total_minor, currency, created_by) VALUES ($1, gen_random_uuid(), $2, $3, $4, 'cancelled', 1, $5, $6)`,
        [A.tenant, A.outlets[0], Bu.tenant, u(), A.currency, A.owner]))?.code,
      // Paired accepts: an unpriced donation line, a priced raw offer line.
      donationUnpriced: (await line(don.id, "raw", A.ingredient, "g", null))?.code ?? "accepted",
    };
    console.log("ROWS:", r);
    expect(r).toEqual({ donationPriced: "23514", offerUnpriced: "23514", offerCooked: "23514", lineOnWithdrawn: "MB004", pickupOnMismatch: "23514",
      donationHandoverWithAllocation: "23514", claimCreatedCancelled: "MB004", donationUnpriced: "accepted" });
  });

  test("a hand-over of a withdrawn donation or of a not-yet-allocated offer → MB004; an accepted allocation of a withdrawn offer → MB004", async () => {
    const don = await publish(A, "donation", PAST);
    await run(own(A, "cares.listing.withdraw.v1"), `UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [A.tenant, don.id]);
    const off = await publish(A, "offer", PAST);
    await run(own(A, "cares.listing.withdraw.v1"), `UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [A.tenant, off.id]);
    const pending = await publish(A, "offer", PAST);
    const r = {
      withdrawnDonation: await code(handover(A, don.id, don.line, 1000)),
      publishedOffer: await code(handover(A, pending.id, pending.line, 1000)),
      // The allocation insert alone (accept() would also move the listing, which the transition table refuses anyway).
      acceptWithdrawnOffer: (await attempt(db, "munim_core", own(A, "cares.claim.decide.v1"), `INSERT INTO core.cares_allocation (tenant_id, id, listing_id,
        outlet_id, claim_tenant_id, claim_id, buyer_public_name, verdict, total_minor, currency, decided_by)
        VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'B', 'accepted', 1, $6, $7)`, [A.tenant, off.id, A.outlets[0], Bu.tenant, u(), A.currency, A.owner]))?.code,
    };
    console.log("ROWS hand-over / allocation status:", r);
    expect(r).toEqual({ withdrawnDonation: "MB004", publishedOffer: "MB004", acceptWithdrawnOffer: "MB004" });
  });
});

describe("SUM, VOID, REV — hand-overs", () => {
  let listing: { id: string; line: string };
  let h1: string;
  beforeAll(async () => {
    listing = await publish(A, "donation", PAST, 0, 300000, A.batches[0]);
    h1 = await handover(A, listing.id, listing.line, 200000);
  });

  test("Σ above the listing line → MB001; exactly the line → accepted", async () => {
    const over = await handover(A, listing.id, listing.line, 100001).then(() => null, (e: { code: string }) => e.code);
    const exact = await handover(A, listing.id, listing.line, 100000).then(() => "accepted", (e: { code: string }) => e.code);
    console.log(`SUM: 200000 + 100001 of 300000 → ${over}; 200000 + 100000 → ${exact}`);
    expect(over).toBe("MB001");
    expect(exact).toBe("accepted");
  });

  test("two concurrent hand-overs of 200000 against a 300000 line: exactly one commits, the other → MB001 (listing row lock)", async () => {
    const l = await publish(A, "donation", PAST);
    const ctx = own(A, "cares.handover.record.v1");
    const [c1, c2] = [await db.connect("munim_core"), await db.connect("munim_core")];
    try {
      const pid2 = (await c2.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0]!.p;
      for (const c of [c1, c2]) {
        await c.query("BEGIN");
        await setContext(c, ctx);
      }
      const ins = async (c: pg.Client) => {
        const h = u();
        await c.query(handoverSql[0], [A.tenant, h, l.id, A.outlets[0], null, A.owner]);
        await c.query(handoverSql[1], [A.tenant, u(), h, l.line, 200000]);
      };
      await ins(c1);
      let settled = false;
      const second = code(ins(c2)).finally(() => { settled = true; });
      const seen = await waitForLockOr(pid2, () => settled);
      await c1.query("COMMIT");
      const r2 = await second;
      const commit2 = r2 === "accepted" ? await code(c2.query("COMMIT")) : (await c2.query("ROLLBACK"), r2);
      const handed = (await db.admin(`SELECT coalesce(sum(hl.qty_milli), 0)::bigint s FROM core.cares_handover_line hl WHERE hl.listing_line_id = $1`, [l.line])).rows[0]!.s;
      console.log(`SUM concurrent: second hand-over ${seen === "waiting" ? "waited on the lock" : "never waited"} → ${commit2}; Σ handed ${handed} of 300000`);
      expect(commit2).toBe("MB001");
      expect(Number(handed)).toBe(200000);
    } finally {
      await Promise.allSettled([c1.end(), c2.end()]);
    }
  });

  test("a withdraw committed between a hand-over's header and its line → MB004 (status re-read under the lock)", async () => {
    const l = await publish(A, "donation", PAST);
    const c1 = await db.connect("munim_core");
    try {
      await c1.query("BEGIN");
      await setContext(c1, own(A, "cares.handover.record.v1"));
      const h = u();
      await c1.query(handoverSql[0], [A.tenant, h, l.id, A.outlets[0], null, A.owner]);
      await run(own(A, "cares.listing.withdraw.v1"), `UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [A.tenant, l.id]);
      const lineThenCommit = await code((async () => {
        await c1.query(handoverSql[1], [A.tenant, u(), h, l.line, 1000]);
        await c1.query("COMMIT");
      })());
      if (lineThenCommit !== "accepted") await c1.query("ROLLBACK");
      console.log(`SUM withdrawn mid-hand-over: line → ${lineThenCommit}`);
      expect(lineThenCommit).toBe("MB004");
    } finally {
      await c1.end();
    }
  });

  test("REV: donation out (−), void, reversal (+) within the out → accepted; one more → MB001; wrong sign → 23514", async () => {
    const out = movement(A, "donation", -200000, "core.cares_handover", h1, A.batches[0]);
    expect(await attempt(db, "munim_core", derive(A, "inventory.cares_handover", `core.cares_handover:${h1}`), ...out)).toBeNull();
    const plus = movement(A, "donation", 1000, "core.cares_handover", h1, A.batches[0]);
    expect((await attempt(db, "munim_core", derive(A, "inventory.cares_handover", `core.cares_handover:${h1}`), ...plus))?.code).toBe("23514");
    const early = await attempt(db, "munim_core", derive(A, "inventory.cares_handover_void", `core.cares_handover:${h1}`),
      ...movement(A, "cares_reversal", 1000, "core.cares_handover", h1, A.batches[0]));
    expect(early?.code).toBe("MB001"); // not voided yet: the void rule's source state
    await run(own(A, "cares.handover.void.v1"), `UPDATE core.cares_handover SET status = 'voided', voided_by = $3, void_reason_code = 'recorded_twice'
      WHERE tenant_id = $1 AND id = $2`, [A.tenant, h1, A.owner]);
    const ctx = derive(A, "inventory.cares_handover_void", `core.cares_handover:${h1}`);
    const first = await attempt(db, "munim_core", ctx, ...movement(A, "cares_reversal", 150000, "core.cares_handover", h1, A.batches[0]));
    const rest = await attempt(db, "munim_core", ctx, ...movement(A, "cares_reversal", 50000, "core.cares_handover", h1, A.batches[0]));
    const over = await attempt(db, "munim_core", ctx, ...movement(A, "cares_reversal", 1, "core.cares_handover", h1, A.batches[0]));
    const neg = await attempt(db, "munim_core", ctx, ...movement(A, "cares_reversal", -1, "core.cares_handover", h1, A.batches[0]));
    console.log(`REV: reversal 150000 → ${first?.code ?? "ok"}, +50000 → ${rest?.code ?? "ok"}, +1 over → ${over?.code}, −1 → ${neg?.code}`);
    expect([first, rest]).toEqual([null, null]);
    expect(over?.code).toBe("MB001");
    expect(neg?.code).toBe("23514");
    // The void freed 200000 of the line: a new hand-over of 200000 fits again.
    expect(await handover(A, listing.id, listing.line, 200000).then(() => "accepted", (e: { code: string }) => e.code)).toBe("accepted");
  });

  test("REV units: a 200 g hand-over's movements are in the base unit — 0.2 kg + 199.8 g in one statement → MB001; 200000 g → accepted", async () => {
    const l = await publish(A, "donation", PAST, 0, 200000);
    const h = await handover(A, l.id, l.line, 200000);
    const ctx = derive(A, "inventory.cares_handover", `core.cares_handover:${h}`);
    const row = (qty: number, unit: string) => [qty, unit];
    const pair = (rows: unknown[][]) => attempt(db, "munim_core", ctx, `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
      SELECT $1, gen_random_uuid(), $2, $3, (x ->> 0)::bigint, x ->> 1, 'donation', 'core.cares_handover', $4 FROM jsonb_array_elements($5::jsonb) WITH ORDINALITY t(x, n) ORDER BY n`,
      [A.tenant, A.outlets[0], A.ingredient, h, JSON.stringify(rows)]);
    const mixed = await pair([row(-200, "kg"), row(-199800, "g")]);
    const base = await pair([row(-200000, "g")]);
    console.log(`REV units: kg + g pair → ${mixed?.code ?? "accepted"}; 200000 g → ${base?.code ?? "accepted"}`);
    expect(mixed?.code).toBe("MB001");
    expect(base).toBeNull();
  });

  test("VOID: a second void → MB004; an un-void → MB004", async () => {
    const again = await attempt(db, "munim_core", own(A, "cares.handover.void.v1"),
      `UPDATE core.cares_handover SET status = 'voided', void_reason_code = 'again' WHERE tenant_id = $1 AND id = $2`, [A.tenant, h1]);
    const unvoid = await attempt(db, "munim_core", own(A, "cares.handover.void.v1"),
      `UPDATE core.cares_handover SET status = 'recorded', voided_by = NULL, void_reason_code = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, h1]);
    console.log(`VOID: second void → ${again?.code}; un-void → ${unvoid?.code}`);
    expect(again?.code).toBe("MB004");
    expect(unvoid?.code).toBe("MB004");
  });

  test("stock CHECKs replaced by name: the 12 kinds and their signs, as typed", async () => {
    const r = await db.admin(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'core.stock_movement'::regclass
      AND conname IN ('stock_movement_kind_check', 'stock_movement_sign_check', 'stock_movement_check') ORDER BY 1`);
    expect(r.rows.map((x) => x.conname)).toEqual(["stock_movement_kind_check", "stock_movement_sign_check"]);
    for (const k of ["donation", "surplus_out", "surplus_in", "cares_reversal"]) expect(r.rows[0]!.d).toContain(`'${k}'::text`);
    expect(r.rows[1]!.d).toMatch(/'surplus_in'::text, 'cares_reversal'::text\]\)\) THEN \(qty_milli > 0\)/);
    expect(r.rows[1]!.d).toMatch(/'donation'::text, 'surplus_out'::text\]\)\) THEN \(qty_milli < 0\)/);
  });
});

describe("ALLOC, RECV — B2B", () => {
  test("ALLOC: one accepted claim per offer (23505); a declined one beside it; an offer's hand-over needs its accepted allocation", async () => {
    const offer = await publish(A, "offer", PAST);
    const alloc = (verdict: string) => {
      const id = u();
      return attempt(db, "munim_core", own(A, "cares.claim.decide.v1"), `INSERT INTO core.cares_allocation (tenant_id, id, listing_id, outlet_id, claim_tenant_id, claim_id,
        buyer_public_name, verdict, total_minor, currency, decided_by) VALUES ($1, $2, $3, $4, $5, $6, 'Buyer', $7, 7500, $8, $9) RETURNING id`,
        [A.tenant, id, offer.id, A.outlets[0], Bu.tenant, u(), verdict, A.currency, A.owner]).then((e) => ({ e, id }));
    };
    const first = await alloc("accepted");
    const second = await alloc("accepted");
    const declined = await alloc("declined");
    console.log(`ALLOC: first accepted → ${first.e?.code ?? "ok"}, second accepted → ${second.e?.code}, declined → ${declined.e?.code ?? "ok"}`);
    expect(first.e).toBeNull();
    expect(second.e?.code).toBe("23505");
    expect(declined.e).toBeNull();
    await run(own(A, "cares.claim.decide.v1"), `UPDATE core.cares_listing SET status = 'allocated' WHERE tenant_id = $1 AND id = $2`, [A.tenant, offer.id]);
    const without = await handover(A, offer.id, offer.line, 1000).then(() => null, (e: { code: string }) => e.code);
    const withDeclined = await handover(A, offer.id, offer.line, 1000, declined.id).then(() => null, (e: { code: string }) => e.code);
    const h = await handover(A, offer.id, offer.line, 300000, first.id);
    const out = await attempt(db, "munim_core", derive(A, "inventory.cares_handover", `core.cares_handover:${h}`),
      ...movement(A, "surplus_out", -300000, "core.cares_handover", h));
    const asDonation = await attempt(db, "munim_core", derive(A, "inventory.cares_handover", `core.cares_handover:${h}`),
      ...movement(A, "donation", -1, "core.cares_handover", h));
    console.log(`ALLOC hand-over: no allocation → ${without}, declined → ${withDeclined}; surplus_out −300000 → ${out?.code ?? "ok"}; as donation → ${asDonation?.code}`);
    expect([without, withDeclined]).toEqual(["23514", "23514"]);
    expect(out).toBeNull();
    expect(asDonation?.code).toBe("MB001");
  });

  test("RECV (A offers, Bu claims, A accepts and hands over 300000): received = handed (else MB004), set once; received needs the accepted allocation", async () => {
    const offer = await publish(A, "offer", PAST);
    const c = await claim(Bu, A.tenant, offer.id, offer.line);
    const alloc = await accept(A, offer.id, Bu.tenant, c.id);
    await handover(A, offer.id, offer.line, 300000, alloc);
    const recv = own(Bu, "cares.claim.receive.v1");
    const setQty = (q: number) => attempt(db, "munim_core", recv, `UPDATE core.cares_claim_line SET received_qty_milli = $3 WHERE tenant_id = $1 AND id = $2`, [Bu.tenant, c.line, q]);
    const setClaim = (allocation: string | null) => attempt(db, "munim_core", recv,
      `UPDATE core.cares_claim SET status = 'received', allocation_id = $3 WHERE tenant_id = $1 AND id = $2`, [Bu.tenant, c.id, allocation]);
    const r = {
      notHanded: (await setQty(299999))?.code,
      handed: (await setQty(300000))?.code ?? "accepted",
      again: (await setQty(300000 - 1))?.code,
      noAllocation: (await setClaim(null))?.code,
      otherAllocation: (await setClaim(u()))?.code,
      accepted: (await setClaim(alloc))?.code ?? "accepted",
    };
    console.log("RECV:", r);
    expect(r).toEqual({ notHanded: "MB004", handed: "accepted", again: "MB004", noAllocation: "23514", otherAllocation: "MB004", accepted: "accepted" });
    const ctx = derive(Bu, "inventory.cares_claim_receive", `core.cares_claim:${c.id}`);
    expect(await attempt(db, "munim_core", ctx, ...movement(Bu, "surplus_in", 300000, "core.cares_claim", c.id))).toBeNull();
    expect((await attempt(db, "munim_core", ctx, ...movement(Bu, "surplus_in", 300000, "core.cares_claim", c.id)))?.code).toBe("MB001");
  });
});

describe("DEF — the five definer functions", () => {
  const defs = ["core.cares_network_listings(text,uuid,uuid,uuid,integer)", "core.cares_market_offers(uuid)", "core.cares_inbound_claims(uuid)",
    "core.cares_claim_outcome(uuid)", "core.cares_network_impact(date,date,text)"];

  test("owner munim_crosstenant, SECURITY DEFINER, STABLE, EXECUTE munim_core only, body read-only", async () => {
    const r = await db.admin(`SELECT p.oid::regprocedure::text f, pg_get_userbyid(p.proowner) o, p.prosecdef d, p.provolatile v,
        has_function_privilege('munim_core', p.oid, 'EXECUTE') core, has_function_privilege('munim_svc', p.oid, 'EXECUTE') svc,
        has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE') intel, has_function_privilege('munim_platform', p.oid, 'EXECUTE') plat,
        p.prosrc ~* '\\m(insert|update|delete|merge|truncate|copy|set_config|nextval)\\M' writes
      FROM unnest($1::text[]) x JOIN pg_proc p ON p.oid = x::regprocedure ORDER BY 1`, [defs]);
    console.log(`DEF: ${r.rows.length} functions`, r.rows.map((x) => `${x.f}:${x.o}`).join(", "));
    expect(r.rows.map((x) => [x.o, x.d, x.v, x.core, x.svc, x.intel, x.plat, x.writes]))
      .toEqual(Array(5).fill(["munim_crosstenant", true, "s", true, false, false, false, false]));
  });

  test("munim_crosstenant: exactly the §1.5 columns of the 12 Cares tables (SELECT only); no cost or price column anywhere", async () => {
    // ADR-015 §1.5 column table, typed by hand (66 = profile 4, outlet 4, listing 9, listing_line 12, handover 6, handover_line 4,
    // claim 7, claim_line 5, allocation 7, recipient 4, city 2, enablement 2).
    const want = [
      "cares_allocation.claim_id", "cares_allocation.claim_tenant_id", "cares_allocation.created_at", "cares_allocation.id", "cares_allocation.listing_id",
      "cares_allocation.tenant_id", "cares_allocation.verdict",
      "cares_city.code", "cares_city.status",
      "cares_claim.created_at", "cares_claim.id", "cares_claim.offer_listing_id", "cares_claim.offer_tenant_id", "cares_claim.outlet_id", "cares_claim.status",
      "cares_claim.tenant_id",
      "cares_claim_line.claim_id", "cares_claim_line.offer_line_id", "cares_claim_line.qty_milli", "cares_claim_line.tenant_id", "cares_claim_line.unit_price_minor",
      "cares_enablement.enabled", "cares_enablement.tenant_id",
      "cares_handover.allocation_id", "cares_handover.handed_at", "cares_handover.id", "cares_handover.listing_id", "cares_handover.status", "cares_handover.tenant_id",
      "cares_handover_line.handover_id", "cares_handover_line.listing_line_id", "cares_handover_line.qty_milli", "cares_handover_line.tenant_id",
      "cares_listing.id", "cares_listing.kind", "cares_listing.outlet_id", "cares_listing.pickup_from", "cares_listing.pickup_on", "cares_listing.pickup_to",
      "cares_listing.recipient_id", "cares_listing.status", "cares_listing.tenant_id",
      "cares_listing_line.currency", "cares_listing_line.expires_on", "cares_listing_line.food_kind", "cares_listing_line.id", "cares_listing_line.ingredient_id",
      "cares_listing_line.item_id", "cares_listing_line.line_no", "cares_listing_line.listing_id", "cares_listing_line.qty_milli", "cares_listing_line.tenant_id",
      "cares_listing_line.unit", "cares_listing_line.unit_price_minor",
      "cares_outlet.active", "cares_outlet.city_code", "cares_outlet.outlet_id", "cares_outlet.tenant_id",
      "cares_profile.b2b_enabled", "cares_profile.public_name", "cares_profile.status", "cares_profile.tenant_id",
      "cares_recipient.id", "cares_recipient.name", "cares_recipient.simulated", "cares_recipient.status",
    ];
    const r = await db.admin<{ c: string; p: string }>(`SELECT c.relname || '.' || a.attname c, x.privilege_type p
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
      WHERE a.attrelid = ANY ($1::regclass[]) AND x.grantee = 'munim_crosstenant'::regrole ORDER BY 1, 2`,
      [[...CORE9, "platform.cares_recipient", "platform.cares_city", "platform.cares_enablement"]]);
    const cost = await db.admin<{ c: string; p: boolean }>(`SELECT c, has_column_privilege('munim_crosstenant', split_part(c, ':', 1), split_part(c, ':', 2), 'SELECT') p
      FROM unnest($1::text[]) c`, [["core.stock_movement:unit_cost_minor", "core.stock_movement:unit_cost_per_1000_minor", "core.batch:mrp_minor",
      "core.price:amount_minor", "core.staff:wage_rate_minor", "core.staff:monthly_salary_minor", "core.cares_claim:total_minor",
      "core.cares_allocation:total_minor", "core.cares_listing_line:batch_id", "platform.operator:email"]]);
    console.log(`DEF crosstenant columns: ${r.rows.length} grants (want ${want.length} SELECT); cost/price readable: ${cost.rows.filter((x) => x.p).map((x) => x.c).join(", ") || "none"}`);
    expect(want.length).toBe(66);
    expect(r.rows.map((x) => `${x.c}:${x.p}`)).toEqual([...want].sort().map((c) => `${c}:SELECT`));
    expect(cost.rows.filter((x) => x.p)).toEqual([]);
  });

  test("munim_crosstenant on core.outlet: exactly tenant_id, id, name (0028) + tz (0029, G-14: the network listing's outlet_tz)", async () => {
    const r = await db.admin<{ c: string }>(`SELECT a.attname || ':' || x.privilege_type c FROM pg_attribute a, aclexplode(a.attacl) x
      WHERE a.attrelid = 'core.outlet'::regclass AND x.grantee = 'munim_crosstenant'::regrole ORDER BY 1`);
    expect(r.rows.map((x) => x.c)).toEqual(["id:SELECT", "name:SELECT", "tenant_id:SELECT", "tz:SELECT"]);
  });

  test("network listings: exactly the 1 live donation (retired, judge, not enabled, paused, withdrawn, expired, retired recipient, offer absent)", async () => {
    const ids = (await run({}, `SELECT listing_id, recipient_simulated, lines FROM core.cares_network_listings(NULL, NULL, NULL, NULL, 50)`)).rows;
    console.log(`DEF network: ${ids.length} live listing(s)`);
    expect(ids.map((x) => x.listing_id)).toEqual([liveA]);
    expect(ids[0].recipient_simulated).toBe(true);
    expect(ids[0].lines).toEqual([{ line_no: 1, food_kind: "raw", label_key: null, label: "Paneer", qty_milli: 300000, unit: "g", expires_on: null }]);
    // 0029 (G-14): the listing outlet's zone rides as the last column.
    expect((await run({}, `SELECT outlet_tz FROM core.cares_network_listings(NULL, NULL, NULL, NULL, 50)`)).rows).toEqual([{ outlet_tz: "Asia/Kolkata" }]);
    // Storefront form: the tenant's own (1) and another tenant's (0); a city with none (0).
    expect((await run({}, `SELECT count(*)::int n FROM core.cares_network_listings(NULL, $1, NULL, NULL, 50)`, [A.tenant])).rows[0].n).toBe(1);
    expect((await run({}, `SELECT count(*)::int n FROM core.cares_network_listings(NULL, $1, NULL, NULL, 50)`, [P.tenant])).rows[0].n).toBe(0);
    expect((await run({}, `SELECT count(*)::int n FROM core.cares_network_listings('melbourne', NULL, NULL, NULL, 50)`)).rows[0].n).toBe(0);
  });

  test("market offers: the buyer owner sees exactly A's live offer (R retired, J judge, N not enabled, P paused, Q not b2b → absent); callers not enabled / not b2b / paused, forged, none, the offerer → 0", async () => {
    const ids = async (ctx: AppContext) => (await run(ctx, `SELECT listing_id FROM core.cares_market_offers(NULL) ORDER BY listing_id`)).rows.map((x) => x.listing_id as string);
    const r = {
      buyer: await ids(member(Bu, Bu.owner, "owner")),
      notEnabled: await ids(member(N, N.owner, "owner")), notB2b: await ids(member(Q, Q.owner, "owner")), paused: await ids(member(P, P.owner, "owner")),
      forged: await ids(member(Bu, u(), "owner")), none: await ids({}), offerer: await ids(member(A, A.owner, "owner")),
    };
    console.log("DEF market:", Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.length])));
    expect(Object.keys(hiddenOffers).length).toBe(5);
    expect(r).toEqual({ buyer: [offerA], notEnabled: [], notB2b: [], paused: [], forged: [], none: [], offerer: [] });
  });

  test("inbound claims: the offerer ≥ 1 (owner; staff of the outlet); non-party, forged, no context, staff of another outlet → 0", async () => {
    const n = async (ctx: AppContext) => (await run(ctx, `SELECT count(*)::int n FROM core.cares_inbound_claims($1)`, [offerA])).rows[0].n as number;
    const r = {
      owner: await n(member(A, A.owner, "owner")), staffIn: await n(member(A, A.staff, "staff", [A.outlets[0]])),
      staffOut: await n(member(A, staffOut, "staff", [A.outlets[1]])), nonParty: await n(member(Bu, Bu.owner, "owner")),
      forged: await n(member(A, u(), "owner")), none: await n({}),
    };
    console.log("DEF inbound:", r);
    expect(r).toEqual({ owner: 1, staffIn: 1, staffOut: 0, nonParty: 0, forged: 0, none: 0 });
  });

  test("claim outcome: 'none' before a verdict, 'accepted' after (lines handed 0); 'declined' for a claim naming a donation, a judge's or a non-b2b offer; non-party, forged, no context, staff elsewhere → 0", async () => {
    const out = (ctx: AppContext, c = claimBu) => run(ctx, `SELECT verdict, allocation_id, lines FROM core.cares_claim_outcome($1)`, [c]).then((r) => r.rows);
    expect((await out(member(Bu, Bu.owner, "owner")))[0]?.verdict).toBe("none");
    const oracle: Record<string, string> = {};
    for (const [k, c] of Object.entries(oracleClaims)) oracle[k] = (await out(member(Bu, Bu.owner, "owner"), c))[0]?.verdict;
    const alloc = u();
    await run(own(A, "cares.claim.decide.v1"), `INSERT INTO core.cares_allocation (tenant_id, id, listing_id, outlet_id, claim_tenant_id, claim_id, buyer_public_name,
      verdict, total_minor, currency, decided_by) VALUES ($1, $2, $3, $4, $5, $6, 'Synthetic Kitchen', 'accepted', 7500, $7, $8)`,
      [A.tenant, alloc, offerA, A.outlets[0], Bu.tenant, claimBu, A.currency, A.owner]);
    const party = await out(member(Bu, Bu.owner, "owner"));
    const r = { party: party.length, staffIn: (await out(member(Bu, Bu.staff, "staff", [Bu.outlets[0]]))).length,
      staffOut: (await out(member(Bu, staffOutBu, "staff", [Bu.outlets[1]]))).length, nonParty: (await out(member(A, A.owner, "owner"))).length,
      forged: (await out(member(Bu, u(), "owner"))).length, none: (await out({})).length };
    console.log("DEF outcome:", party[0], r, "oracle claims:", oracle);
    expect(oracle).toEqual({ donation: "declined", judge: "declined", nonB2b: "declined" });
    expect(party[0]).toEqual({ verdict: "accepted", allocation_id: alloc, lines: [{ offer_line_id: offerLineA, handed_qty_milli: 0 }] });
    expect(r).toEqual({ party: 1, staffIn: 1, staffOut: 0, nonParty: 0, forged: 0, none: 0 });
  });

  test("network impact: operator only, never under a tenant (member, forged operator, operator with a tenant, no context → 0 rows); Σ then Mumbai, hand-typed", async () => {
    const q = (ctx: AppContext) => run(ctx, `SELECT * FROM core.cares_network_impact('2026-10-10', '2026-10-10', NULL)`).then((r) => r.rows);
    const op = await q({ role: "operator", operator_id: operator });
    const [m, forged, tenant, none] = [await q(member(A, A.owner, "owner")), await q({ role: "operator", operator_id: u() }),
      await q({ role: "operator", operator_id: operator, tenant_id: A.tenant, outlet_ids: "*" }), await q({})];
    console.log("DEF impact:", op, `member ${m.length}, forged ${forged.length}, operator under a tenant ${tenant.length}, none ${none.length}`);
    expect([m.length, forged.length, tenant.length, none.length]).toEqual([0, 0, 0, 0]);
    // Shown tenants with the world's two past donation hand-overs (200 g each, 10 Oct): A, Bu, Q → 3 businesses, 6 donations,
    // 1200 g; R, J, N, P are not shown. No world tenant is a demo tenant.
    const sigma = { businesses: "3", donations: "6", meals_portions_milli: "0", weight_g: "1200", volume_ml: "0", all_synthetic: false };
    expect(op).toEqual([{ city_code: null, ...sigma }, { city_code: "mumbai", ...sigma }]);
  });
});

describe("TPL — templates", () => {
  test("only an operator platform.* template may reference a definer function (23514 otherwise)", async () => {
    const ins = (id: string, role: string, fn: string) => attempt(db, "admin", {}, `INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
      VALUES ($1, 1, $2, '{}', '[{"name": "n", "type": "text"}]', $3)`, [id, `SELECT listing_id::text AS n FROM core.${fn}`, role]);
    const r = [await ins("cares.leak", "manager", "cares_market_offers(NULL)"), await ins("platform.leak", "owner", "cares_inbound_claims(NULL)"),
      await ins("intel.leak", "operator", "cares_network_listings(NULL, NULL, NULL, NULL, 1)"), await ins("cares.shout", "manager", "CARES_MARKET_OFFERS(NULL)"),
      await ins("platform.ok_probe", "operator", "cares_network_listings(NULL, NULL, NULL, NULL, 1)")];
    console.log("TPL definer refs:", r.map((x) => x?.code ?? "accepted"));
    expect(r.map((x) => x?.code ?? "accepted")).toEqual(["23514", "23514", "23514", "23514", "accepted"]);
  });

  test("cares.recipient_match: 1 eligible recipient (raw-only and other-city traps out); expiry before pickup + 1 day → 0; no pack cares block → 0", async () => {
    const x = await db.clone();
    try {
      const mint = (ctx: AppContext, p: Record<string, unknown>) => x.withContext("munim_core", ctx, async (c: pg.Client) => {
        const t = (await c.query(`SELECT sql FROM evidence.snapshot_template WHERE id = 'cares.recipient_match' AND version = 1`)).rows[0].sql as string;
        const { sql, names } = bind(t);
        return (await c.query(`SELECT * FROM (${sql}) t`, names.map((n) => p[n]))).rows;
      });
      const p = { outlet_id: A.outlets[0], needs_cooked: false, needs_raw: false, needs_packaged: true, qty_milli: 40000, unit: "portion", expires_on: null };
      const ctx = member(A, A.owner, "owner");
      // The latest active IN pack carries a cares block (T-095c's v4); if this database has none yet, the fixture adds one.
      const latest = async (c: pg.Client) => (await c.query(`SELECT version, doc FROM platform.country_pack WHERE code = 'IN' AND status = 'active' ORDER BY version DESC LIMIT 1`)).rows[0];
      await x.withContext("munim_platform", {}, async (c) => {
        const v = await latest(c);
        if (!v.doc.cares) {
          const doc = { ...v.doc, version: v.version + 1, cares: { food_kinds: ["cooked", "raw", "packaged"], offers_enabled: true, cooked_max_hold_min: 120, min_days_left_at_pickup: 1 } };
          await c.query(`INSERT INTO platform.country_pack (code, version, effective_from, doc) VALUES ('IN', $1, '2026-10-12', $2)`, [v.version + 1, doc]);
        }
      });
      // ST-CA1's shape: the worlds' all-kinds recipients retired; A packaged (fits), B raw only and nearer (trap), C packaged
      // in another city (trap).
      const [ra, rb] = [u(), u()];
      await x.withContext("munim_platform", {}, async (c) => {
        await c.query(`UPDATE platform.cares_recipient SET status = 'retired' WHERE city_code = 'mumbai'`);
        await c.query(`INSERT INTO platform.cares_city (code, country_code, name) VALUES ('pune', 'IN', 'Pune') ON CONFLICT DO NOTHING`);
        const rec = `INSERT INTO platform.cares_recipient (id, city_code, name, kind, simulated, accepts_cooked, accepts_raw, accepts_packaged, capacity_kg_per_day,
          capacity_portions_per_day, receiving_from, receiving_to, lat_e6, lng_e6) VALUES ($1, $2, $3, 'ngo', true, false, $4, $5, 50, 100, '16:00', '19:00', $6, $7)`;
        await c.query(rec, [ra, "mumbai", "Harbour Lane Pantry (simulated)", false, true, 19090000, 72877700]);
        await c.query(rec, [rb, "mumbai", "Mill Road Kitchen (simulated)", true, false, 19077000, 72877700]);
        await c.query(rec, [u(), "pune", "Pune Pantry (simulated)", false, true, 19076000, 72877700]);
      });
      const rows = await mint(ctx, p);
      console.log("TPL recipient_match:", rows.map((r) => [r.name, r.distance_m, r.capacity_fit, r.overlap_min]));
      // A at (19.0900, 72.8777) from outlet 1 at (19.0760, 72.8777): Δφ = 0.014° ≈ 1557 m; overlap 17:00–19:00 = 120 min.
      expect(rows.map((r) => [r.recipient_id, r.simulated, r.capacity_fit, Number(r.overlap_min)])).toEqual([[ra, true, true, 120]]);
      expect(Math.abs(Number(rows[0].distance_m) - 1557)).toBeLessThan(5);
      // 40 portions fit 100/day; 101 portions do not (still returned, ranked by fit).
      expect((await mint(ctx, { ...p, qty_milli: 101000 }))[0].capacity_fit).toBe(false);
      // An expiry on the pickup day leaves less than the pack's 1 day: excluded; one day later: included.
      const on = new Date(rows[0].pickup_on);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      expect(await mint(ctx, { ...p, expires_on: iso(on) })).toEqual([]);
      expect((await mint(ctx, { ...p, expires_on: iso(new Date(on.getTime() + 86_400_000)) })).length).toBe(1);
      // A newer pack with no cares block: Cares is off → 0 rows.
      await x.withContext("munim_platform", {}, async (c) => {
        const v = await latest(c);
        const { cares: _off, ...doc } = v.doc;
        await c.query(`INSERT INTO platform.country_pack (code, version, effective_from, doc) VALUES ('IN', $1, '2026-10-12', $2)`, [v.version + 1, { ...doc, version: v.version + 1 }]);
      });
      expect(await mint(ctx, p)).toEqual([]);
    } finally {
      await x.stop();
    }
  });

  test("cares.listings weekday / slot and cares.impact Σ, hand-typed from the fixtures", async () => {
    const mint = (id: string, ctx: AppContext, p: Record<string, unknown>) => db.withContext("munim_core", ctx, async (c: pg.Client) => {
      const t = (await c.query(`SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = 1`, [id])).rows[0].sql as string;
      const { sql, names } = bind(t);
      return (await c.query(`SELECT * FROM (${sql}) t`, names.map((n) => p[n]))).rows;
    });
    // Bu's listings are untouched by the other tests: its outlet-1 donation, pickup 10 Oct 12:30 UTC = 18:00 IST (a Saturday).
    const l = await mint("cares.listings", member(Bu, Bu.owner, "owner"), { outlet_id: Bu.outlets[0], status: "published" });
    const don = l.filter((r) => r.kind === "donation");
    expect(don.map((r) => [r.pickup_weekday, r.pickup_slot_start, Number(r.lines)])).toEqual([["sat", "18:00", 1]]);
    // Bu outlet 1, October: one donation hand-over of 200 g, no movements (value 0); Σ row labelled 'total'.
    const imp = await mint("cares.impact", member(Bu, Bu.owner, "owner"), { outlet_id: Bu.outlets[0], from: "2026-10-01", to: "2026-10-31" });
    expect(imp.map((r) => [r.kind, ...["handovers", "portions_milli", "weight_g", "volume_ml", "units_milli", "value_at_cost_minor"].map((k) => Number(r[k]))]))
      .toEqual([["total", 1, 0, 200, 0, 0, 0], ["donation", 1, 0, 200, 0, 0, 0], ["offer", 0, 0, 0, 0, 0, 0]]);
  });
});

describe("REC — recipients are simulated only", () => {
  test("simulated = false → 23514; a name without \"(simulated)\" → 23514; a simulated, labelled one → accepted", async () => {
    const ins = (name: string, simulated: boolean) => attempt(db, "munim_platform", {}, `INSERT INTO platform.cares_recipient (id, city_code, name, kind, simulated,
      accepts_cooked, accepts_raw, accepts_packaged, capacity_kg_per_day, capacity_portions_per_day, receiving_from, receiving_to, lat_e6, lng_e6)
      VALUES ($1, 'mumbai', $2, 'ngo', $3, true, true, true, 1, 1, '10:00', '12:00', 0, 0)`, [randomUUID(), name, simulated]);
    const r = [await ins("Real Looking Trust (simulated)", false), await ins("Real Looking Trust", true), await ins("Banyan Court Pantry (simulated)", true)];
    console.log("REC:", r.map((x) => (x ? `${x.code} ${x.message}` : "accepted")));
    expect(r.map((x) => x?.code ?? "accepted")).toEqual(["23514", "23514", "accepted"]);
    expect(r[0]!.message).toMatch(/cares_recipient_simulated_check/);
    expect(r[1]!.message).toMatch(/cares_recipient_name_simulated_check/);
  });
});

describe("NET — network snapshots and enablement", () => {
  test("snapshot: operator template only; minted unpublished; published once by a draft targeting it and approved in the same transaction; rows immutable", async () => {
    const snap = (template: string, published = false) => {
      const id = u();
      return attempt(db, "munim_core", { role: "operator", operator_id: operator }, `INSERT INTO platform.network_snapshot (id, template_id, template_version, rows, row_count,
        sha256, minted_by_operator_id, published_at, publish_draft_id) VALUES ($1, $2, 1, '[]', 0, repeat('0', 64), $3, $4, $5)`,
        [id, template, operator, published ? new Date() : null, published ? u() : null]).then((e) => ({ e, id }));
    };
    const memberTpl = await snap("cares.impact");
    const mintedPublished = await snap("platform.cares_network_impact", true);
    const ok = await snap("platform.cares_network_impact");
    expect(ok.e).toBeNull();
    const publish = (target: string, approved: boolean) => tx("munim_platform", {}, async (c) => {
      const d = await proposeDraft(c, target);
      await c.query(`UPDATE platform.network_snapshot SET published_at = now(), publish_draft_id = $2 WHERE id = $1`, [ok.id, d]);
      if (approved) await approve(c, d);
    });
    const r = {
      memberTemplate: memberTpl.e?.code, mintedPublished: mintedPublished.e?.code,
      wrongTarget: await publish(`cares_public_impact:${u()}`, true),
      half: (await attempt(db, "munim_platform", {}, `UPDATE platform.network_snapshot SET published_at = now() WHERE id = $1`, [ok.id]))?.code,
      proposedOnly: await publish(`cares_public_impact:${ok.id}`, false),
      approved: await publish(`cares_public_impact:${ok.id}`, true),
      again: await publish(`cares_public_impact:${ok.id}`, true),
      rowsByPlatform: (await attempt(db, "munim_platform", {}, `UPDATE platform.network_snapshot SET rows = '[{"x": 1}]', row_count = 1 WHERE id = $1`, [ok.id]))?.code,
      rowsByOwner: (await attempt(db, "admin", {}, `UPDATE platform.network_snapshot SET rows = '[{"x": 1}]', row_count = 1 WHERE id = $1`, [ok.id]))?.code,
    };
    console.log("NET snapshot:", r);
    // The half-publish (no draft) stops at the trigger (MB004) before the published-pair CHECK (its backstop).
    expect(r).toEqual({ memberTemplate: "23514", mintedPublished: "MB004", wrongTarget: "MB004", half: "MB004", proposedOnly: "MB004", approved: "accepted",
      again: "MB004", rowsByPlatform: "42501", rowsByOwner: "MB004" });
  });

  test("enablement: written only with a draft for this tenant approved in the same transaction (proposed, an old applied draft, another tenant's → MB004)", async () => {
    const before = (await db.admin(`SELECT enabled, config_draft_id FROM platform.cares_enablement WHERE tenant_id = $1`, [R.tenant])).rows[0]!;
    const r = {
      proposedOnly: await setEnablement(R, false, { approve: false }),
      oldDraft: await tx("munim_platform", {}, (c) => c.query(`UPDATE platform.cares_enablement SET enabled = false WHERE tenant_id = $1`, [R.tenant])),
      otherTenant: await setEnablement(R, false, { target: `cares_enablement:${A.tenant}` }),
      approved: await setEnablement(R, true),
    };
    const after = (await db.admin(`SELECT enabled, config_draft_id FROM platform.cares_enablement WHERE tenant_id = $1`, [R.tenant])).rows[0]!;
    console.log("NET enablement:", r);
    expect(r).toEqual({ proposedOnly: "MB004", oldDraft: "MB004", otherTenant: "MB004", approved: "accepted" });
    expect(after.enabled).toBe(true);
    expect(after.config_draft_id).not.toBe(before.config_draft_id);
  });
});
