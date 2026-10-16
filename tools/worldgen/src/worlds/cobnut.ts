// cobnut: Cobnut Bakehouse (synthetic), the demo bakery behind apps/web — two Lucknow outlets, the storefront's menu, four demo people,
// simulated suppliers and simulated Cares recipients. Not an eval world: it has no answer key. The catalogue below is a hand copy of
// apps/web/mock-server/data.ts (the storefront must behave the same on the real backend); test/cobnut.test.ts diffs the seeded storefront
// menu against that file. Every reseed is a fresh tenant (cli.ts picks a fresh seed), so the platform-wide rows it names — the Lucknow city
// and the two simulated recipients — carry ids that do not depend on the seed. All people, businesses and suppliers are invented.
import type { Ctx } from "../ctx.ts";
import { bankFile, shiftFile } from "../files.ts";
import { customers, Plan, type PBill, type Waste } from "../history.ts";
import { idOf } from "../ids.ts";
import * as k from "../kit.ts";
import { addDays, at, businessToday, daysBetween, mondayOf, monthStartBefore } from "../time.ts";

export const meta = { tz: "Asia/Kolkata", currency: "INR", personas: ["owner", "manager", "counter", "kitchen"] } as const;

/** The months the demo runs without a reseed (R59): this one and the next two, for the AI budget and the purchases budget. */
const MONTHS = 3;

/** The IN pack has no bakery class; restaurant_5 is the mock's bakery_5 rate (5%: CGST 2.5% + SGST 2.5%). */
const TAX = "restaurant_5";
const KINDS = ["counter", "own_site"];

interface Option { key: string; name: string; delta: number }
interface Group { key: string; name: string; description: string | null; min: number; max: number; options: Option[] }
interface Variant { key: string; name: string; price: number }
interface Dish {
  key: string; name: string; description: string; diet: k.Display["diet"] | null; category: string; kind: "dish" | "sku" | "combo";
  price: number | null; variants: Variant[]; groups: Group[]; soldOut?: true; prepSec: number;
}

// Prices in paise before GST, exactly the mock's (apps/web/mock-server/data.ts ITEMS).
const DISHES: Dish[] = [
  { key: "hazelnut_croissant", name: "Hazelnut Croissant", description: "Laminated butter dough rolled around roasted hazelnut cream, finished with a crackly praline glaze.", diet: "egg", category: "pastries", kind: "dish", price: 18000, variants: [], groups: [], prepSec: 300 },
  { key: "pain_au_chocolat", name: "Pain au Chocolat", description: "Two batons of dark chocolate tucked into flaky, buttery layers.", diet: "egg", category: "pastries", kind: "dish", price: 17000, variants: [], groups: [], prepSec: 300 },
  { key: "cardamom_knot", name: "Cardamom Knot", description: "A soft, twisted bun brushed with cardamom sugar syrup. Made without eggs.", diet: "veg", category: "pastries", kind: "dish", price: 14000, variants: [], groups: [], prepSec: 300 },
  { key: "pistachio_danish", name: "Pistachio Danish", description: "Pistachio frangipane and a glossy apricot glaze on a crisp pastry pinwheel.", diet: "egg", category: "pastries", kind: "dish", price: 21000, variants: [], groups: [], soldOut: true, prepSec: 300 },
  {
    key: "praline_celebration_cake", name: "Hazelnut Praline Cake", description: "Layers of sponge, hazelnut praline cream and a whisper of dark chocolate ganache. Add a message for the top.", diet: null, category: "cakes", kind: "dish", price: null,
    variants: [{ key: "half_kg", name: "½ kg (serves 4–6)", price: 75000 }, { key: "one_kg", name: "1 kg (serves 8–10)", price: 140000 }],
    groups: [{ key: "sponge", name: "Sponge", description: null, min: 1, max: 1, options: [{ key: "classic", name: "Classic (contains egg)", delta: 0 }, { key: "eggless", name: "Eggless", delta: 8000 }] }],
    prepSec: 1800,
  },
  { key: "gianduja_mousse", name: "Gianduja Mousse Cup", description: "Silky milk-chocolate hazelnut mousse over a cocoa crumb.", diet: "egg", category: "cakes", kind: "dish", price: 26000, variants: [], groups: [], prepSec: 240 },
  { key: "rose_tres_leches", name: "Rose Pistachio Tres Leches", description: "A milk-soaked slice scented with rose, topped with chopped pistachio.", diet: "egg", category: "cakes", kind: "dish", price: 24000, variants: [], groups: [], prepSec: 240 },
  { key: "brown_butter_cookie", name: "Brown Butter Hazelnut Cookie", description: "Chewy middle, crisp edge, toasted hazelnuts all the way through.", diet: "egg", category: "cookies", kind: "dish", price: 9000, variants: [], groups: [], prepSec: 120 },
  { key: "eggless_choc_chip", name: "Eggless Choc-Chip Cookie", description: "Our classic chocolate chip cookie, made without eggs.", diet: "veg", category: "cookies", kind: "dish", price: 8000, variants: [], groups: [], prepSec: 120 },
  { key: "oat_jaggery_cookie", name: "Oat & Jaggery Cookie", description: "Rolled oats, jaggery and coconut oil. No dairy, no eggs.", diet: "vegan", category: "cookies", kind: "dish", price: 8500, variants: [], groups: [], prepSec: 120 },
  {
    key: "build_a_box", name: "Build-a-Box", description: "Pick a box size and two to four flavours of our bite-sized truffle cookies. Boxed and ribboned to give.", diet: null, category: "gift_boxes", kind: "combo", price: null,
    variants: [{ key: "box_06", name: "Box of 6", price: 54000 }, { key: "box_09", name: "Box of 9", price: 78000 }, { key: "box_12", name: "Box of 12", price: 102000 }],
    groups: [
      {
        key: "flavours", name: "Flavours", description: "Choose 2 to 4.", min: 2, max: 4,
        options: [
          { key: "hazelnut_praline", name: "Hazelnut praline", delta: 0 }, { key: "dark_chocolate", name: "Dark chocolate", delta: 0 },
          { key: "salted_caramel", name: "Salted caramel", delta: 0 }, { key: "rose_pistachio", name: "Rose pistachio", delta: 0 },
          { key: "coffee_walnut", name: "Coffee walnut", delta: 0 }, { key: "kesar_badam", name: "Kesar badam", delta: 6000 },
        ],
      },
      { key: "gift_wrap", name: "Gift wrap", description: null, min: 0, max: 1, options: [{ key: "ribbon_card", name: "Ribbon and gift card", delta: 5000 }] },
    ],
    prepSec: 600,
  },
  { key: "truffle_tin", name: "Truffle Tin", description: "Sixteen hand-rolled hazelnut and cocoa truffles in a keepsake tin. Made without eggs.", diet: "veg", category: "gift_boxes", kind: "sku", price: 65000, variants: [], groups: [], prepSec: 60 },
  {
    key: "hazelnut_hot_chocolate", name: "Hazelnut Hot Chocolate", description: "Steamed milk, melted dark chocolate and roasted hazelnut paste.", diet: "veg", category: "drinks", kind: "dish", price: null,
    variants: [{ key: "regular", name: "Regular", price: 16000 }, { key: "large", name: "Large", price: 21000 }], groups: [], prepSec: 180,
  },
  {
    key: "cold_coffee", name: "Cold Coffee", description: "Strong brew shaken with milk and a little jaggery syrup.", diet: "veg", category: "drinks", kind: "dish", price: 15000, variants: [],
    groups: [{ key: "milk", name: "Milk", description: null, min: 1, max: 1, options: [{ key: "dairy", name: "Dairy", delta: 0 }, { key: "oat", name: "Oat", delta: 4000 }] }],
    prepSec: 180,
  },
];

export async function build(c: Ctx): Promise<void> {
  // A demo tenant (hard rule 5: the "Sample data" badge) with Cares: both need the operator, so there is no self-serve fallback.
  if (!c.api.hasOperator) throw new Error('cobnut is provisioned by the platform operator (is_demo, Cares): add "operator" to MUNIM_SEED_TOKENS');
  // Its simulated suppliers' agent cards live on the suppliers simulator (cli.ts refuses before writing anything without the URL).
  if (!c.simUrl) throw new Error("cobnut's simulated suppliers need the suppliers simulator's public URL (SUPPLIERS_SIM_PUBLIC_URL)");
  const { asOf: A } = c;
  const D = (n: number) => addDays(A, -n);
  const biz = await k.onboard(c, {
    kind: "restaurant", country: "IN", business: "Cobnut Bakehouse (synthetic)", ownerName: "Nandini Mehrotra",
    outlet: { name: "Cobnut Hazratganj", address: "14 Synthetic Arcade, Hazratganj, Lucknow (synthetic)", taxIds: { GSTIN: "09AAAAA0001A1Z5", FSSAI: "20000000000001" } },
    // No tax ids: Gomti Nagar's receipts show the tax_id_missing state.
    more: [{ name: "Cobnut Gomti Nagar", address: "7 Synthetic Market, Gomti Nagar, Lucknow (synthetic)", kind: "restaurant", taxIds: {} }],
    // R59: a nominal ₹100 AI budget row for this month and the next two, so the live demo runs through the quarter without a reseed.
    aiBudget: { limitMinor: 10_000, months: MONTHS },
  });
  // R59: the live roles priced at ₹0 on the free-tier key (any real price already set is kept, and reported by cli.ts).
  c.s.aiPricing = await k.aiRolePrices(c, biz.currency);
  c.s.currency = biz.currency;
  const [hzg, gmt] = biz.outlets as [k.OutletInfo, k.OutletInfo];
  const tz = hzg.tz;
  const histFrom = D(c.days + 2);
  const stockAt = at(D(c.days + 1), "06:00", tz);
  // The real business day (dates the books and the watchers judge against "now": pickup windows, use-by dates), logged under aliases so the
  // request log does not depend on the day the seed runs.
  const live = businessToday(new Date(), tz);
  const day = (name: string, date: string) => c.api.alias(date, name);

  await k.person(c, "manager", "Farah Qureshi", "manager", [gmt.id]);
  await k.person(c, "counter", "Imran Siddiqui", "staff", [hzg.id]);
  await k.person(c, "kitchen", "Kavya Tandon", "staff", [hzg.id]);
  await k.outletSettings(c, "hzg", hzg, { phone: "+919000000201" });
  // Gomti Nagar is busy (+10 min), as the mock shows it.
  await k.outletSettings(c, "gmt", gmt, { accepting_orders: "busy", busy_extra_min: 10 });
  await k.device(c, "kds:2", gmt.id, "kds");
  // Hazratganj's FSSAI licence is on file and current; Gomti Nagar has none (no tax ids at all), which the compliance watcher reports.
  await k.licence(c, "fssai:hzg", hzg.id, "fssai", "20000000000001", "Synthetic Food Authority", D(200), addDays(A, 500));

  // ---- stock records ----
  const butter = await k.ingredient(c, "butter", "Butter (synthetic)", "kg", { shelfDays: 20 });
  const hazelnuts = await k.ingredient(c, "hazelnuts", "Roasted hazelnuts (synthetic)", "kg", { shelfDays: 90 });
  const flour = await k.ingredient(c, "flour", "Bread flour (synthetic)", "kg", { shelfDays: 180 });
  const cream = await k.ingredient(c, "cream", "Fresh cream (synthetic)", "l", { shelfDays: 5 });
  const chocolate = await k.ingredient(c, "chocolate", "Dark chocolate (synthetic)", "kg", { shelfDays: 180 });
  const milk = await k.ingredient(c, "milk", "Milk (synthetic)", "l", { shelfDays: 3 });
  const tin = await k.ingredient(c, "truffle_tin", "Truffle Tin (boxed, synthetic)", "pc", { shelfDays: 60 });
  const sourdough = await k.ingredient(c, "sourdough", "Sliced sourdough loaf (synthetic)", "pc", { shelfDays: 3, batch: true });
  const rolls = await k.ingredient(c, "rolls", "Day-old bread rolls (synthetic)", "pc", { shelfDays: 2, batch: true });
  // Grams per portion (milli-units of the base unit): the cost the margin reads, and what history sales draw from stock.
  const RECIPES: Record<string, Array<[k.Ingredient, number]>> = {
    hazelnut_croissant: [[butter, 40], [flour, 60], [hazelnuts, 15]], pain_au_chocolat: [[butter, 40], [flour, 60], [chocolate, 15]],
    cardamom_knot: [[butter, 20], [flour, 70]], pistachio_danish: [[butter, 35], [flour, 55]],
    praline_celebration_cake: [[butter, 150], [flour, 200], [hazelnuts, 120], [cream, 250], [chocolate, 60]],
    gianduja_mousse: [[cream, 90], [chocolate, 40], [hazelnuts, 20]], rose_tres_leches: [[milk, 120], [cream, 40], [flour, 40]],
    brown_butter_cookie: [[butter, 25], [flour, 35], [hazelnuts, 10]], eggless_choc_chip: [[butter, 20], [flour, 35], [chocolate, 10]],
    oat_jaggery_cookie: [[flour, 40]], build_a_box: [[chocolate, 60], [hazelnuts, 40], [cream, 30]], truffle_tin: [[tin, 1000]],
    hazelnut_hot_chocolate: [[milk, 250], [chocolate, 30], [hazelnuts, 10]], cold_coffee: [[milk, 200]],
  };

  // ---- the menu: items, variants, option groups, a price per (sellable, outlet, channel), prep times and stations, availability ----
  const items: Record<string, k.Item> = {};
  for (const d of DISHES) {
    const it = await k.item(c, d.key, {
      category: d.category, kind: d.kind, ...(d.kind === "sku" ? { stock: tin } : {}),
      display: { name: d.name, description: d.description, ...(d.diet ? { diet: d.diet } : {}) },
      variants: d.variants.map((v) => ({ key: v.key, name: v.name })),
      groups: d.groups.map((g) => ({ ...g, options: g.options.map((o) => ({ key: o.key, name: o.name, deltaMinor: o.delta })) })),
    });
    items[d.key] = it;
    if (d.kind !== "sku") await k.recipe(c, it, histFrom, RECIPES[d.key]!.map(([ing, qtyMilli]) => ({ ing, qtyMilli })));
    for (const o of biz.outlets) {
      for (const kind of KINDS) {
        if (d.variants.length === 0) await k.price(c, it, o.id, kind, d.price!, TAX, histFrom);
        for (const v of d.variants) await k.price(c, it, o.id, kind, v.price, TAX, histFrom, { variant: v.key });
      }
      // Stations: drinks at the bar, everything else in the kitchen (the mock's split).
      await k.prepTime(c, it, o.id, d.category === "drinks" ? "bar" : "kitchen", d.prepSec, histFrom);
    }
  }
  for (const o of biz.outlets) await k.availability(c, items.pistachio_danish!, o.id, false);
  await k.availability(c, items.rose_tres_leches!, gmt.id, false);
  // The morning bake: 20% off knots and croissants, Monday to Saturday 08:00-11:00 outlet time, both outlets.
  await k.deal(c, "morning_bake", { bp: 2000, itemIds: [items.cardamom_knot!.id, items.hazelnut_croissant!.id], windows: [{ days: [1, 2, 3, 4, 5, 6], from: "08:00", to: "11:00" }], from: "2026-01-01" });
  // Coupons: COBNUT10 (10% over ₹500), GANJ5 (5%, Hazratganj only), DIWALI25 (ended), FIRST50 (one use in all, used below).
  await k.coupon(c, "cobnut10", "COBNUT10", { bp: 1000, from: histFrom, minSpendMinor: 50000 });
  await k.coupon(c, "ganj5", "GANJ5", { bp: 500, from: histFrom, outletIds: [hzg.id] });
  await k.coupon(c, "diwali25", "DIWALI25", { bp: 2500, from: histFrom, to: D(30) });
  await k.coupon(c, "first50", "FIRST50", { bp: 5000, from: histFrom, cap: 1 });

  // ---- dated history (R44b): bills and waste through the approved-import path ----
  // Six named regulars (T-128, R67) besides the pool the baseline bills draw from: see the lapse plant below.
  const people = await customers(c, "IN", 20, 6);
  // Butter waste at Hazratganj: three logs a week of 0.9 kg (₹504 a log at ₹560/kg) in every week of the timeline before yesterday's ISO week, then
  // three of 2.9 kg in that week: ₹4,872 against a usual ₹1,512, so inventory.waste_spike fires for that week only (≥ 1.5× the median of the 8 weeks
  // before it and ≥ ₹1,500 over it; every earlier week has the usual waste, so none of them does).
  const plantedWaste: Waste[] = [];
  const spikeWeek = mondayOf(D(1));
  for (let w = 1; addDays(spikeWeek, 6 - 7 * w) >= addDays(A, -c.days); w++) {
    for (const off of [1, 3, 5]) {
      const d = addDays(spikeWeek, off - 7 * w);
      if (d >= addDays(A, -c.days)) plantedWaste.push({ date: d, time: "20:30", outlet: 0, ing: butter, qtyMilli: 900, reason: "expired" });
    }
  }
  const spikeDays = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(spikeWeek, n)).filter((d) => d <= D(1));
  for (let i = 0; i < 3; i++) plantedWaste.push({ date: spikeDays[i % spikeDays.length]!, time: `20:${10 + 10 * i}`, outlet: 0, ing: butter, qtyMilli: 2900, reason: "expired" });
  const simple = DISHES.filter((d) => d.variants.length === 0 && d.groups.length === 0);
  // Every planted bill below sells only cardamom knots (butter and flour, no hazelnuts), so the hazelnut draw the RFQ demo depends on
  // is untouched, and at 16:30 (outside the morning bake's 08:00-11:00 window).
  const knots = (no: string, date: string, o: Partial<PBill> = {}): PBill =>
    ({ no, date, time: "16:30", outlet: 0, channel: "counter", type: "takeaway", lines: [{ item: "cardamom_knot", qty: 2 }], tender: "upi", ...o });
  const planted: PBill[] = [];
  // R67 (customers.regulars_lapsing → the win-back campaign draft): the six regulars bought every five days from up to 80 days back and
  // stopped 36 days back. churn_segments then counts them at_risk (≥ 3 orders in 90 days; 36 days since the last > max(2 × the 5-day
  // gap, 14)) beside the 20 pool customers, who buy almost daily: 6 of 26 regulars is over the pack's 10% (detector fires on
  // at_risk × 10,000 ≥ 1,000 × regular_count).
  for (const [i, phone] of people.regulars.entries()) {
    for (let n = Math.min(80, c.days - 1); n >= 36; n -= 5) planted.push(knots(`CB-REG-${i + 1}-${n}`, D(n), { phone }));
  }
  // R67 W-4 (T-128): a margin-fall investigation that completes. The month pair is the calendar month before as-of's month (pm0)
  // against the one before it (cm0), planted only when the history reaches cm0's first day. Hazratganj sells the same 120 bills of
  // two knots (₹280 each before tax) in both months; in pm0 every one carries a 50% discount (a staff-run "half-price knots"
  // fortnight): ₹16,800 of discount the compare month does not have. Shifts and bank lines for both months follow the bills below.
  const cm0 = monthStartBefore(A, 2);
  const pm0 = monthStartBefore(A, 1);
  const margin = daysBetween(cm0, A) <= c.days;
  if (margin) {
    for (const [tag, m0] of [["A", cm0], ["S", pm0]] as const) {
      for (let i = 0; i < 120; i++) {
        planted.push(knots(`CB-MF-${tag}-${String(i + 1).padStart(3, "0")}`, addDays(m0, 2 + (i % 14)), tag === "S" ? { lines: [{ item: "cardamom_knot", qty: 2, discBp: 5000 }] } : {}));
      }
    }
  }
  const plan = new Plan(c, {
    prefix: "CB", inclusive: false, phones: people.pool, planted, plantedWaste, hours: [8, 20],
    outlets: [{ outlet: hzg, perDay: [16, 24] }, { outlet: gmt, perDay: [9, 15] }],
    channels: [{ kind: "counter", w: 70, types: ["takeaway", "dine_in"] }, { kind: "own_site", w: 30, types: ["pickup"] }],
    items: simple.map((d) => ({ key: d.key, priceMinor: d.price!, taxClass: TAX, w: d.category === "pastries" ? 5 : 3, recipe: RECIPES[d.key]! })),
    waste: [{ outlet: 1, ing: cream, qtyMilli: [200, 600] }, { outlet: 1, ing: milk, qtyMilli: [500, 1500] }],
  });
  const cost: Array<[k.Ingredient, number]> = [[butter, 56000], [hazelnuts, 148000], [flour, 4200], [cream, 21000], [chocolate, 62000], [milk, 6000], [tin, 30000]];
  // Hazelnuts open at each outlet at exactly what the history draws there (plan.draw: core's own waste gross-up and rounding) plus two days of that
  // draw, so the seed day ends with about two days on hand (less today's counter orders below): together far under the six days of need a request
  // for quotes reads (inventory.shortfall at the negotiation's LEAD_DAYS), so it finds a shortfall with no stock count (go-live B-2), and Hazratganj
  // is under its reorder minimum (inventory.below_reorder on the owner home). Everything else opens 10 kg over the history's draw (with a margin).
  const hazelDraw = biz.outlets.map((_, oi) => plan.draw(oi, hazelnuts, k.RECIPE_WASTE_BP));
  const hazelLeft = hazelDraw.map((d) => Math.ceil((2 * d) / c.days));
  for (const [oi, o] of biz.outlets.entries()) {
    await k.openingStock(c, `open:${oi + 1}`, o.id, stockAt, cost.map(([ing, costMinor]) =>
      ({ ing, qtyMilli: ing === hazelnuts ? hazelDraw[oi]! + hazelLeft[oi]! : 10000 + plan.need(oi, ing), costMinor })));
  }
  c.s.hazelnutsLeftMilli = hazelLeft;
  plan.queue();
  await k.flushImports(c);
  if (margin) {
    // finance.close_status for both months (the investigation's data_complete item): every trading day of each outlet has a closed
    // drawer session (one 04:00 → 03:59 shift per business date, the default cutoff; its Cash Tenders is core's own figure, so the
    // log is uploaded after the bills are committed), and the bank lines reach each month's last day (one UPI credit per outlet and
    // day: what the day's bills took by UPI, so the tender-vs-bank reconciliation finds no gap). Cobnut has no aggregator channel,
    // so there are no payouts to import.
    const last = addDays(monthStartBefore(A, 0), -1);
    const inPair = (d: string) => d >= cm0 && d <= last;
    const shifts = biz.outlets.flatMap((o, oi) => plan.tradingDays(oi).filter(inPair).map((d) => ({
      no: `CB-SH-${oi + 1}-${d.replaceAll("-", "")}`, date: d, outlet: o.name, opened: "04:00", closed: "03:59", by: "Nandini Mehrotra",
      floatMinor: 200_000, cashMinor: plan.cashIn(oi, d),
    })));
    const credits = biz.outlets.flatMap((o, oi) => plan.tradingDays(oi).filter((d) => d <= last).flatMap((d) => {
      const minor = plan.upiTendered(oi, d);
      return minor > 0 ? [{ date: d, ref: `CB-UPI-${oi + 1}-${d}`, outlet: o.name, minor, narration: "UPI settlement (synthetic)" }] : [];
    }));
    k.importFile(c, "history:shifts:CB", "shift_log", "CB-shifts.csv", shiftFile(shifts), "Synthetic dated history");
    k.importFile(c, "history:bank:CB", "bank_statement", "CB-upi-credits.csv", bankFile("SB-SYN-COBNUT", credits, biz.currency), "Synthetic dated history");
    await k.flushImports(c);
  }

  // ---- simulated suppliers (hard rule 5), with their price lists; last week's butter order, received ----
  const observed = at(D(3), "10:00", tz);
  const dairy = await k.supplier(c, "dairy", "Riverbank Dairy (simulated)", 0, [{ key: "butter", ing: butter, priceMinor: 56000, at: observed }]);
  await k.supplier(c, "nuts", "Lalbagh Nut & Spice (simulated)", 7, [{ key: "hazelnuts", ing: hazelnuts, priceMinor: 148000, at: observed }]);
  const po = await k.purchaseOrder(c, "butter", dairy, hzg.id, D(5), [{ ing: butter, qtyMilli: 10000, priceMinor: 56000 }]);
  await k.goodsReceived(c, "butter", dairy, hzg.id, po.id, at(D(5), "07:30", tz), [{ ing: butter, qtyMilli: 10000, costMinor: null, poLine: po.lines[0]! }]);
  // The simulated suppliers' agents a request for quotes (POST /v1/rfq-requests) asks: their agent cards on the suppliers simulator at
  // c.simUrl (intel refuses a card anywhere else). Core hands intel the carded suppliers in id order and the recorded negotiation calls
  // them Supplier A, B and C in that order, so the three ids are their keys' ids sorted: steady < discounter < premium.
  const agents = [["steady", "Steady Wholesale (simulated)", 15], ["discounter", "Bargain Bulk Traders (simulated)", 7],
    ["premium", "Premium Provisions (simulated)", 30]] as const;
  const agentIds = agents.map(([key]) => c.api.id(`supplier:${key}`)).sort();
  for (const [i, [key, name, days]] of agents.entries()) {
    await k.supplier(c, key, name, days, [], { id: agentIds[i]!, cardUrl: `${c.simUrl}/${key}/.well-known/agent-card.json` });
  }
  // The purchases budget for the whole business, this month and the next two, the owner's own command: the deal review reads it
  // (budget_left_minor); with none every quote is budget_missing ("cannot verify") and no PO draft can pass. ₹50,000 a month. The months
  // follow the outlets' business month now (not aliased in the request log: as a date it would also rename every other line that names
  // the 1st of that month).
  for (let i = 0; i < MONTHS; i++) {
    await k.budget(c, i === 0 ? "purchases" : `purchases:+${i}`, { month: k.monthAfter(live, i), category: "purchases", amountMinor: 5_000_000 });
  }
  // A week of Hazratganj's average draw: above the two days it opens the seed day with.
  const hazelMin = Math.ceil((7 * hazelDraw[0]!) / c.days);
  await k.reorderLevel(c, hzg.id, hazelnuts, hazelMin, hazelMin + 8000);
  await k.reorderLevel(c, hzg.id, butter, 4000, 10000);

  // ---- labour: four staff, rostered and clocked 07:30-15:30 for the live-command reach (people.labour_pct on the owner home) ----
  const crew = [
    [hzg, await k.staff(c, "imran", "Imran Siddiqui", hzg.id, "counter", 11000, "2025-04-01")],
    [hzg, await k.staff(c, "kavya", "Kavya Tandon", hzg.id, "baker", 13000, "2025-04-01")],
    [gmt, await k.staff(c, "rehan", "Rehan Ansari (synthetic)", gmt.id, "counter", 11000, "2025-06-01")],
    [gmt, await k.staff(c, "meher", "Meher Kapoor (synthetic)", gmt.id, "baker", 13000, "2025-06-01")],
  ] as const;
  const from = D(c.liveDays);
  for (const o of biz.outlets) {
    const here = crew.filter(([oo]) => oo === o).map(([, s]) => s);
    for (let w = mondayOf(from); w <= D(1); w = addDays(w, 7)) {
      const shifts = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(w, i);
        if (d >= from && d <= D(1)) for (const s of here) shifts.push({ staff: s, date: d, start: "07:30", end: "15:30", role: s.key === "kavya" || s.key === "meher" ? "baker" : "counter" });
      }
      if (shifts.length) await k.roster(c, `${o.id.slice(0, 8)}:${w}`, o, w, shifts, (d, t) => at(d, t, tz));
    }
    for (const s of here) for (let d = from; d <= D(1); d = addDays(d, 1)) await k.attend(c, o, s, d, at(d, "07:30", tz), at(d, "15:30", tz));
  }

  // ---- today: pickup windows (today and tomorrow, 30 min, 6 orders each), counter sales, open kitchen tickets, storefront orders ----
  for (const o of biz.outlets) {
    for (const [name, date] of [["today", live], ["tomorrow", addDays(live, 1)]] as const) {
      await k.pickupWindows(c, `${o.id.slice(0, 8)}:${name}`, o.id, day(`windows_${name}`, date), "08:00", "21:00", 30, 6);
    }
  }
  const line = (key: string, qty = 1, variant?: string, options: string[] = []): k.OrderLine => ({
    item: items[key]!, qtyMilli: qty * 1000, ...(variant ? { variant } : {}), options,
  });
  const counterOrders: Array<[k.OutletInfo, k.OrderLine[]]> = [
    [hzg, [line("hazelnut_croissant", 2), line("hazelnut_hot_chocolate", 1, "regular")]],
    [hzg, [line("pain_au_chocolat"), line("cold_coffee", 1, undefined, ["milk:oat"])]],
    [hzg, [line("brown_butter_cookie", 3)]],
    [hzg, [line("gianduja_mousse", 2)]],
    [hzg, [line("praline_celebration_cake", 1, "one_kg", ["sponge:eggless"])]],
    [gmt, [line("oat_jaggery_cookie", 4)]],
    [gmt, [line("build_a_box", 1, "box_09", ["flavours:hazelnut_praline", "flavours:salted_caramel", "flavours:kesar_badam", "gift_wrap:ribbon_card"])]],
    [gmt, [line("hazelnut_hot_chocolate", 2, "large")]],
  ];
  for (const [i, [o, lines]] of counterOrders.entries()) {
    const key = `ord:counter:${i}`;
    await k.placeOrder(c, key, biz, o, "counter", "takeaway", lines);
    // The first three of each outlet's are paid at the till; the rest wait for payment.
    if (i < 3 || i === 5) await k.tenderUpiFull(c, `tender:${i}`, key);
  }
  // Kavya at Hazratganj's KDS: the first ticket is ready for pickup, the next two are being made; the rest wait.
  await k.advanceTickets(c, "hzg", hzg, "kitchen", [["preparing", "ready"], ["preparing"], ["preparing"]]);
  const sf = await k.storefrontKey(c, biz, []);
  c.s.storefrontKey = sf;
  for (let i = 0; i < 2; i++) await k.storefrontOrder(c, sf, `ord:sf:${i}`, biz, hzg, items.cardamom_knot!, { name: `Guest ${i + 1} (synthetic)`, phone: `+9190000003${i}0` });
  // FIRST50 is capped at one use in all; this guest used it, so the storefront refuses it from now on (coupon cap reached).
  await k.storefrontOrder(c, sf, "ord:sf:first50", biz, hzg, items.truffle_tin!, { name: "Guest F (synthetic)", phone: "+919000000350" }, ["FIRST50"]);

  // ---- Munim Cares (ADR-015): Lucknow, two simulated recipients, both outlets enrolled; near-expiry sourdough for the expiry_risk draft ----
  const recipients = await k.caresOperator(c, { code: "lucknow", country: "IN", name: "Lucknow" }, [
    { key: "shelter", id: idOf("cobnut-platform", "cobnut", "cares:recipient:shelter"), name: "Riverside Night Shelter (simulated)", kind: "ngo", cooked: true, raw: false, packaged: true, kg: 40, portions: 120, from: "20:30", to: "23:00", lat: 26_848_000, lng: 80_950_000 },
    { key: "kitchen", id: idOf("cobnut-platform", "cobnut", "cares:recipient:kitchen"), name: "Old Town Community Kitchen (simulated)", kind: "food_bank", cooked: false, raw: true, packaged: true, kg: 150, portions: 0, from: "09:00", to: "22:00", lat: 26_870_000, lng: 80_910_000 },
  ]);
  await k.caresProfile(c, "Cobnut Bakehouse (synthetic)", false, [
    { outlet: hzg, city: "lucknow", lat: 26_850_000, lng: 80_946_000, from: "21:00", to: "22:30" },
    { outlet: gmt, city: "lucknow", lat: 26_852_000, lng: 81_000_000, from: "21:00", to: "22:30" },
  ]);
  // Hazratganj's sliced sourdough falls due in two days: 20 loaves at ₹55 = ₹1,100 at risk (pack floor ₹500, horizon 3 days), drawn by no dish,
  // so the expiry watcher finds it and drafts a donation to the top-ranked simulated recipient.
  const sourdoughExp = day("sourdough_expiry", addDays(live, 2));
  const rollsExp = day("rolls_expiry", addDays(live, 2));
  await k.openingStock(c, "cares:hzg", hzg.id, stockAt, [
    { ing: sourdough, qtyMilli: 20000, costMinor: 5500, batch: { code: "SOURDOUGH-HZG-1", expires: sourdoughExp, mrpMinor: null } },
    // 24 rolls at ₹20 (₹480, under the floor: no finding): half go to the community kitchen tomorrow and are handed over (one recorded
    // donation for the impact report), the rest are listed for the same evening.
    { ing: rolls, qtyMilli: 24000, costMinor: 2000, batch: { code: "ROLLS-HZG-1", expires: rollsExp, mrpMinor: null } },
  ]);
  const when = (name: string, date: string, hhmm: string) => c.api.alias(at(date, hhmm, tz), name);
  const tomorrow = addDays(live, 1);
  // The handed-over donation is picked up tonight when tonight's window is still ahead (cares.impact counts by pickup day, so the owner home's
  // month-to-date total shows it), else tomorrow; the books refuse a pickup that has passed.
  const handDay = Date.parse(at(live, "21:00", tz)) - Date.now() > 30 * 60_000 ? live : tomorrow;
  const gift = await k.caresListing(c, "rolls_a", hzg, { recipient: recipients.kitchen!, pickupFrom: when("cares_pickup_a_from", handDay, "21:00"), pickupTo: when("cares_pickup_a_to", handDay, "22:00"),
    lines: [{ key: "rolls", ing: rolls, batch: "ROLLS-HZG-1", qtyMilli: 12000, expires: rollsExp }] });
  await k.caresHandover(c, "rolls_a", gift.id, [{ lineId: gift.lineIds[0]!, qtyMilli: 12000 }]);
  await k.caresListing(c, "rolls_b", hzg, { recipient: recipients.kitchen!, pickupFrom: when("cares_pickup_b_from", tomorrow, "21:00"), pickupTo: when("cares_pickup_b_to", tomorrow, "22:00"),
    lines: [{ key: "rolls", ing: rolls, batch: "ROLLS-HZG-1", qtyMilli: 12000, expires: rollsExp }] });
  await k.caresNetworkImpact(c, addDays(A, -c.days), c.api.alias(addDays(live, 1), "cares_impact_to"));

  // R59: read back from core that a live AI run of this business has what it needs (every live role priced in its currency, an AI
  // budget row for each month); a gap fails the seed by name rather than leaving the demo answering "model_blocked".
  if (!c.api.lenient) {
    const missing = await k.aiReadiness(c, biz.currency, Array.from({ length: MONTHS }, (_, i) => k.monthAfter(A, i)));
    if (missing.length) throw new Error(`cobnut: live AI is not ready: ${missing.join("; ")}`);
  }
}
