// The Cobnut world (lane B1, R54) on the real app (embedded Postgres 18, the intel stub, no .env): seeded twice through the SDK, as
// `make seed WORLD=cobnut` does on every reseed (a fresh seed, so a fresh tenant). Expected values come from apps/web/mock-server/data.ts
// (the storefront mock the site was built on) and interface.md (the people), never from the seed's output.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createMunimClient } from "../../../packages/sdk/src/index.ts";
import { runWorld } from "../src/run.ts";
import { businessToday } from "../src/time.ts";
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
const seeded: Array<{ tenantId: string; storefrontKey: string }> = [];

before(async () => {
  stack = await startStack();
  for (const seed of ["cobnut-gate-1", "cobnut-gate-2"]) {
    const r = await runWorld({ world: "cobnut", seed, asOf: businessToday(new Date(), "Asia/Kolkata"), days: AS_OF_DAYS, baseUrl: stack.baseUrl, token: stack.token("cobnut"), operator: true, simUrl: SIM });
    seeded.push({ tenantId: r.api.tenantId!, storefrontKey: String(r.state.storefrontKey) });
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
      assert.deepEqual(await q(`SELECT b.category, b.outlet_id, b.amount_minor::int AS amount, b.currency, b.period_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))::date AS this_month,
          b.origin ->> 'kind' AS origin, m.name FROM core.budget b JOIN core.member m ON m.id = (b.origin ->> 'principal_id')::uuid WHERE b.tenant_id = $T`),
        [{ category: "purchases", outlet_id: null, amount: 5_000_000, currency: "INR", this_month: true, origin: "command", name: "Nandini Mehrotra" }]);
    }
    assert.notEqual(seeded[0]!.tenantId, seeded[1]!.tenantId, "a reseed is a fresh tenant");
    // Platform-wide rows do not multiply on a reseed: one Lucknow, the two simulated recipients once.
    assert.deepEqual((await stack.admin(`SELECT name, simulated FROM platform.cares_recipient WHERE city_code = 'lucknow' ORDER BY name`)).rows,
      [{ name: "Old Town Community Kitchen (simulated)", simulated: true }, { name: "Riverside Night Shelter (simulated)", simulated: true }]);
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
