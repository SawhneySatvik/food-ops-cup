// Gates on stored catalog state (never trust IF NOT EXISTS — assert what Postgres actually holds):
//  - every policy predicate reads back as one of the forms written in 0003–0020, with qual = with-check (0019's
//    book children: with-check = the tenant form), FOR ALL, PERMISSIVE, TO PUBLIC; the form per table matches the
//    manifest; platform.llm_budget's two policies are exactly as written;
//  - no foreign key cascades (a cascade would be a book write that bypasses the guard).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import {
  CUSTOMER_CODE, CUSTOMER_OPEN, CUSTOMER_OWN, CUSTOMER_PUBLIC, CUSTOMER_PUBLISHED, CUSTOMER_VIA_ORDER, OUTLET_NULLABLE, OUTLET_TABLES, PARENT_SCOPED,
  RUN_SCOPED, RUN_SCOPED_CHILDREN, TENANT_TABLES,
} from "./manifest.ts";

let db: TestDb;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => db?.stop());

// Postgres's deparse of the predicates written in 0003 (header) — compared byte for byte.
const TENANT = `(tenant_id = ( SELECT (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid AS "nullif"))`;
const ALL_OUTLETS = `(( SELECT current_setting('app.outlet_ids'::text, true) AS current_setting) = '{*}'::text)`;
const inScope = (col: string) =>
  `(${col} = ANY ((( SELECT NULLIF(NULLIF(current_setting('app.outlet_ids'::text, true), ''::text), '{*}'::text) AS "nullif"))::uuid[]))`;
const FORMS: Record<string, string> = {
  tenant: TENANT,
  // 0014: shoppers (customer, guest) bypass outlet scope; customer_scope / guest_scope govern them.
  outlet: `(${TENANT} AND ((( SELECT current_setting('app.role'::text, true) AS current_setting) = ANY (ARRAY['customer'::text, 'guest'::text])) OR ${ALL_OUTLETS} OR ${inScope("outlet_id")}))`,
  draft_overlap: `(${TENANT} AND (${ALL_OUTLETS} OR (outlet_ids && ( SELECT (NULLIF(NULLIF(current_setting('app.outlet_ids'::text, true), ''::text), '{*}'::text))::uuid[] AS "nullif"))))`,
  transfer_either_end: `(${TENANT} AND (${ALL_OUTLETS} OR ${inScope("from_outlet_id")} OR ${inScope("to_outlet_id")}))`,
  customer_own: `(${TENANT} AND ((( SELECT current_setting('app.role'::text, true) AS current_setting) IS DISTINCT FROM 'customer'::text) OR (id = ( SELECT (NULLIF(current_setting('app.customer_id'::text, true), ''::text))::uuid AS "nullif"))))`,
  customer_own_rows: `(${TENANT} AND ((( SELECT current_setting('app.role'::text, true) AS current_setting) IS DISTINCT FROM 'customer'::text) OR (customer_id = ( SELECT (NULLIF(current_setting('app.customer_id'::text, true), ''::text))::uuid AS "nullif"))))`,
  // #37 (0014): a run is visible when the caller's outlet scope covers it; '{*}' runs to owner/advisor/judge/service.
  run_scope: `(${TENANT} AND
CASE
    WHEN (outlet_scope = '{*}'::text[]) THEN (${ALL_OUTLETS} AND (( SELECT COALESCE(NULLIF(current_setting('app.role'::text, true), ''::text), 'service'::text) AS "coalesce") = ANY (ARRAY['service'::text, 'owner'::text, 'advisor'::text, 'judge'::text])))
    ELSE (${ALL_OUTLETS} OR ((outlet_scope)::uuid[] <@ (( SELECT NULLIF(NULLIF(current_setting('app.outlet_ids'::text, true), ''::text), '{*}'::text) AS "nullif"))::uuid[]))
END)`,
  trace_via_run: `(${TENANT} AND (EXISTS ( SELECT 1
   FROM intel.run r
  WHERE ((r.tenant_id = trace_event.tenant_id) AND (r.id = trace_event.run_id)))))`,
  // 0015 A3: compliance and goal tables — the outlet form plus tenant-wide rows (outlet_id NULL); AMC and
  // maintenance through their asset.
  outlet_or_wide: `(${TENANT} AND ((( SELECT current_setting('app.role'::text, true) AS current_setting) = ANY (ARRAY['customer'::text, 'guest'::text])) OR ${ALL_OUTLETS} OR (outlet_id IS NULL) OR ${inScope("outlet_id")}))`,
  amc_via_asset: viaAsset("amc"),
  maintenance_via_asset: viaAsset("maintenance"),
  // 0019 O2: children read through their parent (WITH CHECK: the tenant form, message excepted — CHECK_VIA_PARENT).
  ...Object.fromEntries(Object.entries(PARENT_SCOPED).map(([t, { parent, fk }]) => [`${t.slice(5)}_via_parent`, viaParent(t, parent, fk)])),
  // 0020: turns and steps through their thread / investigation (which carry run_scope).
  ...Object.fromEntries(Object.entries(RUN_SCOPED_CHILDREN).map(([t, { parent, fk }]) => [`${t.slice(5)}_via_parent`, viaParent(t, parent, fk)])),
};
function viaAsset(t: string): string {
  return `(${TENANT} AND (EXISTS ( SELECT 1
   FROM core.asset a
  WHERE ((a.tenant_id = ${t}.tenant_id) AND (a.id = ${t}.asset_id)))))`;
}
function viaParent(t: string, parent: string, fk: string): string {
  const name = t.slice(5);
  return `(${TENANT} AND (EXISTS ( SELECT 1
   FROM ${parent} x
  WHERE ((x.tenant_id = ${name}.tenant_id) AND (x.id = ${name}.${fk})))))`;
}
// 0015 A3's five, and since 0019 every outlet-scoped table whose outlet_id is nullable.
const OUTLET_OR_WIDE = ["core.asset", ...OUTLET_NULLABLE];
const CHECK_VIA_PARENT = ["core.message", ...Object.keys(RUN_SCOPED_CHILDREN)];

// F4 (0014): the RESTRICTIVE customer_scope policy, (qual, with check) per class.
const NC = `(( SELECT current_setting('app.role'::text, true) AS current_setting) IS DISTINCT FROM 'customer'::text)`;
const CUST = `( SELECT (NULLIF(current_setting('app.customer_id'::text, true), ''::text))::uuid AS "nullif")`;
const viaOrder = (t: string) => `(${NC} OR (EXISTS ( SELECT 1
   FROM core."order" o
  WHERE ((o.tenant_id = ${t}.tenant_id) AND (o.id = ${t}.order_id)))))`;
// Guests (0014 rider): order-scoped, read-only.
const NG = `(( SELECT current_setting('app.role'::text, true) AS current_setting) IS DISTINCT FROM 'guest'::text)`;
const GUEST_HASH = `( SELECT decode(NULLIF(current_setting('app.guest_access_hash'::text, true), ''::text), 'hex'::text) AS decode)`;
function guestForm(t: string): string {
  if (t === "core.order") return `(${NG} OR (guest_access_hash = ${GUEST_HASH}))`;
  const name = t.split(".")[1]!;
  if (["core.order_line", "core.order_event", "core.tender", "core.kitchen_ticket"].includes(t)) return `(${NG} OR (EXISTS ( SELECT 1
   FROM core."order" o
  WHERE ((o.tenant_id = ${name}.tenant_id) AND (o.id = ${name}.order_id)))))`;
  return NG;
}
function customerForm(t: string): [string, string] | null {
  if (CUSTOMER_OPEN.includes(t)) return null;
  if (t === "core.customer") return [`(${NC} OR (id = ${CUST}))`, `(${NC} OR (id = ${CUST}))`];
  if (t === "core.order") {
    const q = `(${NC} OR (customer_id = ${CUST}) OR (guest_access_hash = ( SELECT decode(NULLIF(current_setting('app.guest_access_hash'::text, true), ''::text), 'hex'::text) AS decode)))`;
    return [q, q];
  }
  if (CUSTOMER_OWN.includes(t)) return [`(${NC} OR (customer_id = ${CUST}))`, `(${NC} OR (customer_id = ${CUST}))`];
  if (CUSTOMER_VIA_ORDER.includes(t)) return [viaOrder(t.split(".")[1]!), viaOrder(t.split(".")[1]!)];
  if (CUSTOMER_PUBLIC.includes(t)) return ["true", NC];
  if (CUSTOMER_CODE.includes(t)) return [`(${NC} OR (code = ANY ((( SELECT NULLIF(current_setting('app.coupon_codes'::text, true), ''::text) AS "nullif"))::text[])))`, NC];
  if (CUSTOMER_PUBLISHED.includes(t)) return [`(${NC} OR (EXISTS ( SELECT 1
   FROM core.storefront_page_publish p
  WHERE ((p.tenant_id = storefront_page_version.tenant_id) AND (p.page_id = storefront_page_version.id)))))`, NC];
  return [NC, NC];
}

interface Pol { t: string; name: string; cmd: string; permissive: boolean; roles: string[]; qual: string | null; chk: string | null }

async function policies(x: TestDb): Promise<Pol[]> {
  const r = await x.admin<Pol>(`
    SELECT s.nspname || '.' || c.relname AS t, p.polname AS name, p.polcmd AS cmd, p.polpermissive AS permissive,
           ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1)::text[] AS roles,
           pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace s ON s.oid = c.relnamespace
     ORDER BY 1, 2`);
  return r.rows;
}

/** Expected form per tenant table in core/evidence/intel, from the manifest (independent of the catalog). */
function expectedForm(t: string): string {
  if (t === "core.draft" || t === "intel.finding") return "draft_overlap";
  if (t === "core.transfer") return "transfer_either_end";
  if (t === "core.customer") return "customer_own";
  if (t === "core.loyalty_entry") return "customer_own_rows";
  if (RUN_SCOPED.includes(t)) return "run_scope";
  if (t in RUN_SCOPED_CHILDREN) return `${t.slice(5)}_via_parent`;
  if (t === "intel.trace_event") return "trace_via_run";
  if (OUTLET_OR_WIDE.includes(t)) return "outlet_or_wide";
  if (t === "core.amc" || t === "core.maintenance") return `${t.slice(5)}_via_asset`;
  if (t in PARENT_SCOPED) return `${t.slice(5)}_via_parent`;
  return OUTLET_TABLES.includes(t) ? "outlet" : "tenant";
}
/** Extra policies written on purpose (each pinned exactly in its own test). */
const EXTRA_POLICIES: Record<string, string> = { "intel.intel_spend": "operator_read" };

async function policyFailures(x: TestDb): Promise<{ checked: number; failures: string[] }> {
  const all = await policies(x);
  const failures: string[] = [];
  const tables = TENANT_TABLES.filter((t) => !t.startsWith("platform."));
  for (const t of tables) {
    const guest = all.filter((p) => p.t === t && !p.permissive && p.name === "guest_scope");
    const gq = guestForm(t);
    if (guest.length !== 1 || guest[0]!.qual !== gq || guest[0]!.chk !== NG || guest[0]!.cmd !== "*" || guest[0]!.roles.join() !== "public") {
      failures.push(`${t}: guest_scope missing or not in its form`);
    }
    const restrictive = all.filter((p) => p.t === t && !p.permissive && p.name !== "guest_scope");
    const want = customerForm(t);
    if (!want) {
      if (restrictive.length !== 0) failures.push(`${t}: ${restrictive.length} restrictive policies (expected none: open to placement)`);
    } else if (restrictive.length !== 1 || restrictive[0]!.name !== "customer_scope") {
      failures.push(`${t}: ${restrictive.length} restrictive policies (expected customer_scope)`);
    } else if (restrictive[0]!.qual !== want[0] || restrictive[0]!.chk !== want[1] || restrictive[0]!.cmd !== "*" || restrictive[0]!.roles.join() !== "public") {
      failures.push(`${t}: customer_scope not in its class form`);
    }
    const ps = all.filter((p) => p.t === t && p.permissive && p.name !== EXTRA_POLICIES[t]);
    if (ps.length !== 1) {
      failures.push(`${t}: ${ps.length} policies (expected 1)`);
      continue;
    }
    const p = ps[0]!;
    const form = Object.entries(FORMS).find(([, f]) => f === p.qual)?.[0] ?? "UNKNOWN";
    if (form !== expectedForm(t)) failures.push(`${t}: form ${form}, expected ${expectedForm(t)}`);
    // 0019 O2: the book children check new rows by tenant only (written with their parent in one statement).
    const wantChk = t in PARENT_SCOPED && !CHECK_VIA_PARENT.includes(t) ? TENANT : p.qual;
    if (p.chk !== wantChk) failures.push(`${t}: WITH CHECK not as written`);
    if (p.cmd !== "*" || !p.permissive || p.roles.join() !== "public") failures.push(`${t}: cmd=${p.cmd} permissive=${p.permissive} roles=${p.roles}`);
  }
  // 0028: platform.cares_enablement carries llm_budget's policies (pinned in its own test below).
  const stray = all.filter((p) => !tables.includes(p.t) && p.t !== "platform.llm_budget" && p.t !== "platform.cares_enablement");
  const budgetCustomer = all.filter((p) => p.t === "platform.llm_budget" && !p.permissive && p.name === "customer_scope");
  if (all.filter((p) => p.t === "platform.llm_budget" && p.name === "guest_scope" && p.qual === NG).length !== 1) failures.push("platform.llm_budget: guest_scope missing");
  if (budgetCustomer.length !== 1 || budgetCustomer[0]!.qual !== NC || budgetCustomer[0]!.chk !== NC) failures.push("platform.llm_budget: customer_scope missing or not deny");
  for (const [t, name] of Object.entries(EXTRA_POLICIES)) {
    if (all.filter((p) => p.t === t && p.name === name).length !== 1) failures.push(`${t}: expected policy ${name}`);
  }
  for (const p of stray) failures.push(`${p.t}: unexpected policy ${p.name}`);
  return { checked: tables.length, failures };
}

describe("policy predicates read back as written", () => {
  test("every core/evidence/intel tenant table: one FOR ALL policy in its manifest form, qual = with-check", async () => {
    const r = await policyFailures(db);
    const forms = (await policies(db)).reduce<Record<string, number>>((acc, p) => {
      const f = Object.entries(FORMS).find(([, x]) => x === p.qual)?.[0] ?? `other(${p.t}.${p.name})`;
      acc[f] = (acc[f] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`policies: ${r.checked - r.failures.length}/${r.checked} tables in their written form; forms:`, forms);
    expect(r.failures).toEqual([]);
    expect(r.checked).toBe(TENANT_TABLES.length - 2); // the two platform tenant tables (llm_budget, cares_enablement) are pinned below
  });

  test("intel.intel_spend: operators read spend across tenants (budgets), nothing else", async () => {
    const ps = (await policies(db)).filter((p) => p.t === "intel.intel_spend" && p.name === "operator_read");
    expect(ps).toEqual([{ t: "intel.intel_spend", name: "operator_read", cmd: "r", permissive: true, roles: ["munim_platform"], qual: "true", chk: null }]);
  });

  test("platform.llm_budget: operator sees all, core/svc read own tenant only", async () => {
    const ps = (await policies(db)).filter((p) => p.t === "platform.llm_budget" && p.permissive);
    expect(ps).toEqual([
      { t: "platform.llm_budget", name: "operator_all", cmd: "*", permissive: true, roles: ["munim_platform"], qual: "true", chk: "true" },
      { t: "platform.llm_budget", name: "tenant_read", cmd: "r", permissive: true, roles: ["munim_core", "munim_svc"], qual: TENANT, chk: null },
    ]);
  });

  test("0028 platform.cares_enablement: as llm_budget — operator sees all, core/svc read own tenant only, shoppers denied", async () => {
    const ps = (await policies(db)).filter((p) => p.t === "platform.cares_enablement");
    expect(ps).toEqual([
      { t: "platform.cares_enablement", name: "customer_scope", cmd: "*", permissive: false, roles: ["public"], qual: NC, chk: NC },
      { t: "platform.cares_enablement", name: "guest_scope", cmd: "*", permissive: false, roles: ["public"], qual: NG, chk: NG },
      { t: "platform.cares_enablement", name: "operator_all", cmd: "*", permissive: true, roles: ["munim_platform"], qual: "true", chk: "true" },
      { t: "platform.cares_enablement", name: "tenant_read", cmd: "r", permissive: true, roles: ["munim_core", "munim_svc"], qual: TENANT, chk: null },
    ]);
  });

  test("RED-PROOF: an extra USING (true) policy on core.price → red", async () => {
    const x = await db.clone();
    try {
      await x.admin("CREATE POLICY leak ON core.price USING (true)");
      const r = await policyFailures(x);
      console.log("RED-PROOF policy read-back:", r.failures);
      expect(r.failures).toEqual(["core.price: 2 policies (expected 1)"]);
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: a policy rewritten without nullif → red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`DROP POLICY tenant_isolation ON core.deal;
        CREATE POLICY tenant_isolation ON core.deal USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`);
      const r = await policyFailures(x);
      console.log("RED-PROOF policy form:", r.failures);
      expect(r.failures).toEqual(["core.deal: form UNKNOWN, expected tenant"]);
    } finally {
      await x.stop();
    }
  });
});

async function cascadingFks(x: TestDb): Promise<string[]> {
  const r = await x.admin<{ c: string }>(`
    SELECT c.conrelid::regclass::text || '.' || c.conname AS c FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace s ON s.oid = t.relnamespace
     WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')
       AND (c.confdeltype <> 'a' OR c.confupdtype <> 'a') ORDER BY 1`);
  return r.rows.map((x) => x.c);
}

describe("no cascading foreign keys", () => {
  test("every FK is NO ACTION on delete and update (count of FKs printed)", async () => {
    const n = await db.admin(`SELECT count(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace s ON s.oid = t.relnamespace WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')`);
    const bad = await cascadingFks(db);
    console.log(`foreign keys: ${n.rows[0]!.n} checked, ${bad.length} cascading`);
    expect(n.rows[0]!.n).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  test("RED-PROOF: an ON DELETE CASCADE FK → red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`ALTER TABLE core.void ADD CONSTRAINT redproof_cascade FOREIGN KEY (tenant_id, order_line_id)
                     REFERENCES core.order_line (tenant_id, id) ON DELETE CASCADE`);
      const bad = await cascadingFks(x);
      console.log("RED-PROOF cascade:", bad);
      expect(bad).toEqual(["core.void.redproof_cascade"]);
    } finally {
      await x.stop();
    }
  });
});
