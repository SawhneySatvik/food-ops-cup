// The Cobnut world (lane B1, R54) on the real app (embedded Postgres 18, the intel stub, no .env): seeded twice through the SDK, as
// `make seed WORLD=cobnut` does on every reseed (a fresh seed, so a fresh tenant). Expected values come from apps/web/mock-server/data.ts
// (the storefront mock the site was built on) and interface.md (the people), never from the seed's output.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createMunimClient } from "../../../packages/sdk/src/index.ts";
import type { Api } from "../src/api.ts";
import { makeCtx } from "../src/ctx.ts";
import { operatorApprove } from "../src/kit.ts";
import { runWorld } from "../src/run.ts";
import { businessToday, monthStartBefore } from "../src/time.ts";
import { startStack, type Stack } from "./stack.ts";

// The mock's data, loaded by path: apps/web is not an ES-module package to tsc, so this file types the parts it reads.
interface MockItem { slug: string; name: string; description: string; diet: string | null; category: string; kind: string; price: number | null; soldOut?: boolean;
  variants: Array<{ name: string; price: number }>; groups: Array<{ name: string; description: string | null; min: number; max: number; options: Array<{ name: string; delta: number }> }> }
const MOCK = join(import.meta.dirname, "../../../apps/web/mock-server/data.ts");
const { COUPONS, ITEMS, OUTLETS } = (await import(MOCK)) as { COUPONS: Array<{ code: string }>; ITEMS: MockItem[]; OUTLETS: Array<{ name: string; soldOut: string[] }> };

const AS_OF_DAYS = 70;
/** Any URL serves (nothing here calls the simulator); the cards must be on it, by the brief's paths (T-127). */
const SIM = "http://127.0.0.1:4423";
let stack: Stack;
const seeded: Array<{ tenantId: string; storefrontKey: string; aiPricing: unknown; api: Api; seed: string; hazelLeft: number[] }> = [];

before(async () => {
  stack = await startStack();
  for (const seed of ["cobnut-gate-1", "cobnut-gate-2"]) {
    const r = await runWorld({ world: "cobnut", seed, asOf: businessToday(new Date(), "Asia/Kolkata"), days: AS_OF_DAYS, baseUrl: stack.baseUrl, token: stack.token("cobnut"), operator: true, simUrl: SIM });
    seeded.push({ tenantId: r.api.tenantId!, storefrontKey: String(r.state.storefrontKey), aiPricing: r.state.aiPricing, api: r.api, seed, hazelLeft: r.state.hazelnutsLeftMilli as number[] });
  }
});
after(async () => {
  await stack?.stop();
});

type MenuItem = {
  display_name: string | null; description: string | null; diet: string | null; category: string; kind: string; available: boolean; price_minor: number | null;
  variants: Array<{ display_name: string | null; price_minor: number }>;
  option_groups: Array<{ display_name: string | null; description: string | null; min_select: number; max_select: number; required: boolean; options: Array<{ display_name: string | null; price_delta_minor: number }> }>;
};

/** Every difference between a storefront menu and the mock's ITEMS at one outlet (names, kinds, prices, sizes, options, sold-out state),
 *  in the mock's order (T-115, 0030): items within each category, sizes, option groups and options in data.ts array order. The site
 *  orders the categories itself (apps/web/lib/site.ts categoryOrder), so their order is not compared. */
function menuDiff(items: MenuItem[], outletName: string): string[] {
  const mock = OUTLETS.find((o) => o.name === outletName);
  if (!mock) return [`no mock outlet ${outletName}`];
  const out: string[] = [];
  if (items.length !== ITEMS.length) out.push(`${outletName}: ${items.length} items, mock has ${ITEMS.length}`);
  for (const c of new Set(ITEMS.map((m) => m.category))) {
    const want = ITEMS.filter((m) => m.category === c).map((m) => m.name);
    const got = items.filter((i) => i.category === c).map((i) => i.display_name);
    if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`${outletName} ${c} order: mock ${JSON.stringify(want)}, seeded ${JSON.stringify(got)}`);
  }
  for (const m of ITEMS) {
    const it = items.find((x) => x.display_name === m.name);
    if (!it) { out.push(`${outletName}: missing ${m.name}`); continue; }
    const want = {
      description: m.description, diet: m.diet, category: m.category, kind: m.kind, price: m.price, available: !(m.soldOut || mock.soldOut.includes(m.slug)),
      variants: m.variants.map((v) => [v.name, v.price]), groups: m.groups.map((g) => [g.name, g.description, g.min, g.max, g.min > 0, g.options.map((o) => [o.name, o.delta])]),
    };
    const got = {
      description: it.description, diet: it.diet, category: it.category, kind: it.kind, price: it.price_minor, available: it.available,
      variants: it.variants.map((v) => [v.display_name, v.price_minor]), groups: it.option_groups.map((g) => [g.display_name, g.description, g.min_select, g.max_select, g.required, g.options.map((o) => [o.display_name, o.price_delta_minor])]),
    };
    for (const k of Object.keys(want) as Array<keyof typeof want>) {
      if (JSON.stringify(want[k]) !== JSON.stringify(got[k])) out.push(`${outletName} ${m.name} ${k}: mock ${JSON.stringify(want[k])}, seeded ${JSON.stringify(got[k])}`);
    }
  }
  return out;
}

describe("cobnut", () => {
  test("two outlets, four people, demo tenant, Cares on, simulated suppliers", async () => {
    for (const { tenantId } of seeded) {
      const q = async (sql: string) => (await stack.admin(sql.replaceAll("$T", `'${tenantId}'`))).rows;
      assert.deepEqual(await q(`SELECT name, is_demo, onboarded_at IS NOT NULL onboarded FROM core.tenant WHERE tenant_id = $T`), [{ name: "Cobnut Bakehouse (synthetic)", is_demo: true, onboarded: true }]);
      assert.deepEqual(await q(`SELECT name, kind, tz, tax_ids FROM core.outlet WHERE tenant_id = $T ORDER BY name`), [
        { name: "Cobnut Gomti Nagar", kind: "restaurant", tz: "Asia/Kolkata", tax_ids: {} },
        { name: "Cobnut Hazratganj", kind: "restaurant", tz: "Asia/Kolkata", tax_ids: { GSTIN: "09AAAAA0001A1Z5", FSSAI: "20000000000001" } },
      ]);
      // interface.md's people table: role and outlets (owner '*'), each bound to <key>@cobnut-demo.invalid.
      assert.deepEqual(await q(`SELECT m.name, m.email, ms.role, CASE WHEN ms.outlet_ids = '{}' THEN '*' ELSE (SELECT string_agg(o.name, ',') FROM core.outlet o WHERE o.tenant_id = m.tenant_id AND o.id = ANY (ms.outlet_ids)) END outlets,
          m.idp_sub IS NOT NULL bound FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id WHERE m.tenant_id = $T ORDER BY m.email`), [
        { name: "Imran Siddiqui", email: "counter@cobnut-demo.invalid", role: "staff", outlets: "Cobnut Hazratganj", bound: true },
        { name: "Kavya Tandon", email: "kitchen@cobnut-demo.invalid", role: "staff", outlets: "Cobnut Hazratganj", bound: true },
        { name: "Farah Qureshi", email: "manager@cobnut-demo.invalid", role: "manager", outlets: "Cobnut Gomti Nagar", bound: true },
        { name: "Nandini Mehrotra", email: "owner@cobnut-demo.invalid", role: "owner", outlets: "*", bound: true },
      ]);
      assert.deepEqual(await q(`SELECT e.enabled, d.status FROM platform.cares_enablement e JOIN platform.config_draft d ON d.id = e.config_draft_id WHERE e.tenant_id = $T`), [{ enabled: true, status: "applied" }]);
      assert.deepEqual(await q(`SELECT name, kind, a2a_card_url FROM core.supplier WHERE tenant_id = $T ORDER BY name`), [
        { name: "Bargain Bulk Traders (simulated)", kind: "simulated", a2a_card_url: `${SIM}/discounter/.well-known/agent-card.json` },
        { name: "Lalbagh Nut & Spice (simulated)", kind: "simulated", a2a_card_url: null },
        { name: "Premium Provisions (simulated)", kind: "simulated", a2a_card_url: `${SIM}/premium/.well-known/agent-card.json` },
        { name: "Riverbank Dairy (simulated)", kind: "simulated", a2a_card_url: null },
        { name: "Steady Wholesale (simulated)", kind: "simulated", a2a_card_url: `${SIM}/steady/.well-known/agent-card.json` },
      ]);
      // T-127: core hands intel the carded suppliers in id order (Supplier A, B, C of the recorded negotiation): steady, discounter, premium.
      assert.deepEqual((await q(`SELECT name FROM core.supplier WHERE tenant_id = $T AND a2a_card_url IS NOT NULL ORDER BY id`)).map((r) => r.name),
        ["Steady Wholesale (simulated)", "Bargain Bulk Traders (simulated)", "Premium Provisions (simulated)"]);
      // T-127: this month's purchases budget for the whole business, ₹50,000, the owner's own command (the deal review reads it).
      // R59: this month and the next two (the demo runs through the quarter without a reseed). Months counted from now in Kolkata, by hand.
      const offset = (col: string) => `(extract(year FROM ${col}) * 12 + extract(month FROM ${col}) - extract(year FROM now() AT TIME ZONE 'Asia/Kolkata') * 12
        - extract(month FROM now() AT TIME ZONE 'Asia/Kolkata'))::int`;
      assert.deepEqual(await q(`SELECT b.category, b.outlet_id, b.amount_minor::int AS amount, b.currency, ${offset("b.period_month")} AS month,
          b.origin ->> 'kind' AS origin, m.name FROM core.budget b JOIN core.member m ON m.id = (b.origin ->> 'principal_id')::uuid WHERE b.tenant_id = $T ORDER BY b.period_month`),
        [0, 1, 2].map((month) => ({ category: "purchases", outlet_id: null, amount: 5_000_000, currency: "INR", month, origin: "command", name: "Nandini Mehrotra" })));
      // R59 (R47 D2): a nominal ₹100 operator AI budget row for the same three months.
      assert.deepEqual(await q(`SELECT ${offset("month")} AS month, limit_minor::int AS limit, currency FROM platform.llm_budget WHERE tenant_id = $T ORDER BY month`),
        [0, 1, 2].map((month) => ({ month, limit: 10_000, currency: "INR" })));
    }
    assert.notEqual(seeded[0]!.tenantId, seeded[1]!.tenantId, "a reseed is a fresh tenant");
    // R59 (R47 D1): the four live roles priced at 0 INR per 1M tokens in and out, by an applied operator draft each; the reseed into the
    // same database found them priced and proposed nothing (a price already set is never overwritten).
    assert.deepEqual((await stack.admin(`SELECT role, input_price_per_mtok_minor::int AS i, output_price_per_mtok_minor::int AS o, price_currency AS cur
        FROM platform.model_role WHERE role IN ('router', 'reason', 'narrate', 'extract') ORDER BY role`)).rows,
      ["extract", "narrate", "reason", "router"].map((role) => ({ role, i: 0, o: 0, cur: "INR" })));
    assert.equal(Number((await stack.admin(`SELECT count(*) n FROM platform.config_draft WHERE target LIKE 'model_role:%' AND status = 'applied'`)).rows[0]!.n), 4);
    assert.deepEqual(seeded.map((s) => (s.aiPricing as { priced: string[] }).priced), [["router", "reason", "narrate", "extract"], []]);
    assert.deepEqual((seeded[1]!.aiPricing as { kept: string[] }).kept, ["router (0/0 INR)", "reason (0/0 INR)", "narrate (0/0 INR)", "extract (0/0 INR)"]);
    // Platform-wide rows do not multiply on a reseed: one Lucknow, the two simulated recipients once.
    assert.deepEqual((await stack.admin(`SELECT name, simulated FROM platform.cares_recipient WHERE city_code = 'lucknow' ORDER BY name`)).rows,
      [{ name: "Old Town Community Kitchen (simulated)", simulated: true }, { name: "Riverside Night Shelter (simulated)", simulated: true }]);
  });

  test("R59: a reseed of the same world finds its operator drafts applied — approving one again is done, a draft not applied is refused", async () => {
    // The same seed proposes the same draft ids (core replays the proposal) and core answers the approval 409 already_decided.
    const { api, seed, tenantId } = seeded[0]!;
    const c = makeCtx({ api, world: "cobnut", seed, asOf: businessToday(new Date(), "Asia/Kolkata"), days: AS_OF_DAYS });
    const applied = [`config_draft:llm_budget:${tenantId}`, `config_draft:llm_budget:${tenantId}:+1`, `config_draft:llm_budget:${tenantId}:+2`,
      ...["router", "reason", "narrate", "extract"].map((r) => `config_draft:model_role:${r}`)].map((k) => api.id(k));
    for (const id of applied) await operatorApprove(c, id); // each resolves: already applied
    const proposed = api.id(`config_draft:t127b-proposed:${tenantId}`);
    await api.post("operator", "/platform/v1/config-drafts", { draft_id: proposed, target: `llm_budget:${tenantId}`, patch: { month: "2030-01-01", limit_minor: 1, currency: "INR" } }, { noTenant: true });
    await api.post("operator", "/platform/v1/config-drafts/{id}:reject", { reason: "red-proof: not applied" }, { params: { id: proposed }, noTenant: true });
    await assert.rejects(operatorApprove(c, proposed), /is rejected, not applied/);
  });

  test("go-live B-2: hazelnuts end the history at the planned two days per outlet, so a request for quotes finds a shortfall with no stock count", async () => {
    for (const { tenantId, hazelLeft } of seeded) {
      // From core's own stock movements: the history (before today in Lucknow), today's counter orders, the last 28 days' sales draw.
      const rows = (await stack.admin(`WITH today AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS t)
        SELECT o.name, sum(m.qty_milli) FILTER (WHERE m.at < t)::int AS closed, sum(m.qty_milli)::int AS on_hand,
               (-sum(m.qty_milli) FILTER (WHERE m.kind = 'sale_consumption' AND m.at >= t - interval '28 days' AND m.at < t))::int AS drew_28d
          FROM core.stock_movement m CROSS JOIN today JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
          JOIN core.ingredient i ON i.tenant_id = m.tenant_id AND i.id = m.ingredient_id
         WHERE m.tenant_id = '${tenantId}' AND i.name = 'Roasted hazelnuts (synthetic)' GROUP BY o.name ORDER BY o.name`)).rows as
        Array<{ name: string; closed: number; on_hand: number; drew_28d: number }>;
      // core's consumption of the history equals the seed's own count of it (Plan.draw): each outlet closes yesterday at its planned remainder.
      assert.deepEqual(rows.map((r) => [r.name, r.closed]), [["Cobnut Gomti Nagar", hazelLeft[1]], ["Cobnut Hazratganj", hazelLeft[0]]]);
      // Today's counter orders never take an outlet below zero…
      for (const r of rows) assert.ok(r.on_hand >= 0 && r.on_hand <= r.closed, `${r.name}: ${r.on_hand} on hand of ${r.closed}`);
      // …and both outlets together hold under three days of their recent draw, so a six-day need (the RFQ's shortfall) is over it.
      const [held, drew] = [rows.reduce((a, r) => a + r.on_hand, 0), rows.reduce((a, r) => a + r.drew_28d, 0)];
      assert.ok(held > 0 && held * 28 < 3 * drew, `${held} on hand against ${drew} drawn in 28 days`);
    }
  });

  test("the storefront menu equals apps/web/mock-server/data.ts at both outlets, in its order", async () => {
    for (const { storefrontKey } of seeded) {
      const sf = createMunimClient({ baseUrl: stack.baseUrl, storefrontKey }) as unknown as { GET(p: string, i?: unknown): Promise<{ data?: Record<string, unknown> }> };
      const outlets = ((await sf.GET("/v1/storefront/outlets")).data!.outlets as Array<{ outlet_id: string; name: string }>);
      // In the mock's order (Hazratganj first): the storefront lists outlets in the order they were opened (T-115).
      assert.deepEqual(outlets.map((o) => o.name), OUTLETS.map((o) => o.name));
      for (const o of outlets) {
        const menu = (await sf.GET("/v1/storefront/outlets/{outlet_id}/menu", { params: { path: { outlet_id: o.outlet_id } } })).data!;
        assert.deepEqual(menuDiff(menu.items as MenuItem[], o.name), []);
      }
    }
  });

  test("R67: six regulars stopped coming to Hazratganj — its churn segment counts them at risk, enough for the watcher to fire", async () => {
    // Hand count from the seed's plant: 6 named regulars, each with ≥ 3 orders in 90 days and the last 36 days back; the watcher
    // fires on at_risk × 10,000 ≥ 1,000 × regular_count (packs/customers-growth.md §4, 10% of regulars).
    for (const { api, tenantId } of seeded) {
      const hzg = (await stack.admin(`SELECT id FROM core.outlet WHERE tenant_id = $1 AND name = 'Cobnut Hazratganj'`, [tenantId])).rows[0]!.id as string;
      const snap = await api.post("owner", "/v1/snapshots", { template_id: "customers.churn_segments", params: { outlet_id: hzg, as_of: businessToday(new Date(), "Asia/Kolkata") } });
      const sigma = (snap.rows as Array<Record<string, unknown>>).find((r) => r.customer_id === null)!;
      const [atRisk, regular] = [Number(sigma.at_risk_count), Number(sigma.regular_count)];
      assert.equal(atRisk, 6);
      assert.ok(atRisk * 10_000 >= 1_000 * regular, `${atRisk} at risk of ${regular} regulars`);
    }
  });

  test("R67 W-4: on a Cobnut long enough to hold last month and the one before, a margin-fall plan runs to done", { timeout: 900_000 }, async () => {
    // Its own seed: 110 days reach the first of the month before last. Hand expectations: the tills, bank lines and (no) payouts are
    // complete for both months (data_complete), and the plant's ₹16,800 of extra discount in the later month is far over a tenth of
    // the margin it lost (deals); the plan then judges every item in one step.
    const today = businessToday(new Date(), "Asia/Kolkata");
    const r = await runWorld({ world: "cobnut", seed: "cobnut-gate-mf", asOf: today, days: 110, baseUrl: stack.baseUrl, token: stack.token("cobnut"), operator: true, simUrl: SIM });
    const id = r.api.id("t128:investigation");
    const params = { period_month: monthStartBefore(today, 1), compare_month: monthStartBefore(today, 2) };
    const opened = await r.api.post("owner", "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params, mode: "plan" });
    assert.deepEqual([opened.mode, opened.status], ["plan", "open"]);
    const v = await r.api.post("owner", "/v1/investigations/{id}:approve-plan", {}, { params: { id } });
    const status = Object.fromEntries((v.checklist as Array<{ item_id: string; status: string }>).map((c) => [c.item_id, c.status]));
    console.log(`margin_fall on cobnut: ${v.status} after ${v.steps_done} step(s), ${JSON.stringify(status)}`);
    assert.equal(v.status, "done");
    assert.equal(status.data_complete, "supported");
    assert.equal(status.deals, "supported");
  });

  test("the mock's coupons behave the same", async () => {
    // Expected outcomes from data.ts COUPONS: COBNUT10 needs ₹500, GANJ5 is Hazratganj only, DIWALI25 has ended, FIRST50 is at its cap.
    assert.deepEqual(COUPONS.map((c) => c.code), ["COBNUT10", "GANJ5", "DIWALI25", "FIRST50"]);
    const { storefrontKey } = seeded[0]!;
    const sf = createMunimClient({ baseUrl: stack.baseUrl, storefrontKey }) as unknown as {
      GET(p: string, i?: unknown): Promise<{ data?: Record<string, unknown> }>; POST(p: string, i: unknown): Promise<{ data?: Record<string, unknown>; error?: unknown }>;
    };
    const outlets = ((await sf.GET("/v1/storefront/outlets")).data!.outlets as Array<{ outlet_id: string; name: string }>);
    const preview = async (outletName: string, code: string, qty: number) => {
      const o = outlets.find((x) => x.name === outletName)!;
      const menu = (await sf.GET("/v1/storefront/outlets/{outlet_id}/menu", { params: { path: { outlet_id: o.outlet_id } } })).data!;
      const tin = (menu.items as Array<{ item_id: string; display_name: string; brand_id: string | null }>).find((i) => i.display_name === "Truffle Tin")!;
      const r = await sf.POST("/v1/storefront/orders:preview", { body: {
        outlet_id: o.outlet_id, channel_id: menu.channel_id, brand_id: tin.brand_id, kind: "pickup", pickup_window_id: null, promised_at: null, coupon_codes: [code], loyalty_redeem_points: 0,
        lines: [{ item_id: tin.item_id, variant_id: null, option_ids: [], qty_milli: qty * 1000, barcode: null }],
      } });
      if (!r.data) throw new Error(`preview ${code}: ${JSON.stringify(r.error)}`);
      const d = (r.data ?? {}) as { discount_minor?: number; refusals?: Array<{ reason_code: string }> };
      return { discount: d.discount_minor ?? null, refused: (d.refusals ?? []).map((x) => x.reason_code) };
    };
    // One Truffle Tin is ₹650 (65,000 paise): COBNUT10 takes 10% = 6,500; GANJ5 5% = 3,250 at Hazratganj.
    assert.deepEqual(await preview("Cobnut Hazratganj", "COBNUT10", 1), { discount: 6500, refused: [] });
    assert.deepEqual(await preview("Cobnut Hazratganj", "GANJ5", 1), { discount: 3250, refused: [] });
    for (const [outlet, code] of [["Cobnut Gomti Nagar", "GANJ5"], ["Cobnut Hazratganj", "DIWALI25"], ["Cobnut Hazratganj", "FIRST50"]] as const) {
      const r = await preview(outlet, code, 1);
      assert.equal(r.refused.length, 1, `${code} at ${outlet} is refused`);
    }
  });
});
