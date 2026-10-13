// T-061: the POS builds requests and reads responses; it never does money arithmetic (rule 9, R25/R26).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addToCart, classify, entryName, createIntents, firstUnmet, groupByCategory, placePayload, previewBody, stepQty, type MenuEntry } from "../lib/pos/logic.ts";

const entry = (id: string, over: Partial<MenuEntry> = {}): MenuEntry => ({
  item_id: id, variant_id: null, kind: "dish", name_key: `item_${id}`, variant_name_key: null, category: "mains", brand_id: null,
  display_name: `Item ${id}`, description: null, diet: null, variant_display_name: null, variant_description: null, barcode: null,
  price_id: "p", price_minor: 1000, currency: "INR", tax_class: "restaurant_5", mrp_minor: null, available: true, option_groups: [], deals: [], ...over,
}) as MenuEntry;
const where = { outletId: "o", channelId: "c", kind: "takeaway" as const };

test("the same item and options raise the quantity; the line id is minted once and kept", () => {
  const a = addToCart([], entry("a"), []);
  const b = addToCart(a, entry("a"), []);
  expect(b).toHaveLength(1);
  expect(b[0]!.qtyMilli).toBe(2000);
  expect(b[0]!.lineId).toBe(a[0]!.lineId);
  expect(addToCart(b, entry("a"), ["opt1"])).toHaveLength(2);
  expect(stepQty(b, b[0]!.lineId, -1)[0]!.qtyMilli).toBe(1000);
  expect(stepQty(stepQty(b, b[0]!.lineId, -1), b[0]!.lineId, -1)).toEqual([]);
});

test("placement carries the previewed total core returned, line ids and no client price", () => {
  const cart = addToCart([], entry("a"), []);
  const p = placePayload(cart, { ...where, orderId: "ord", deviceId: "dev", table: " T4 ", previewTotalMinor: 75600 });
  expect(p.preview_total_minor).toBe(75600);
  expect(p.client_totals).toBeNull();
  expect(p.device_id).toBe("dev");
  expect(p.lines[0]).toMatchObject({ line_id: cart[0]!.lineId, item_id: "a", qty_milli: 1000, option_ids: [] });
  expect(JSON.stringify(p)).not.toContain("price_minor");
  expect(p.table_ref).toBeNull(); // takeaway: no table
  expect(placePayload(cart, { ...where, kind: "dine_in", orderId: "o", deviceId: "d", table: " T4 ", previewTotalMinor: 1 }).table_ref).toBe("T4");
  expect(JSON.stringify(previewBody(cart, where))).not.toContain("line_id");
});

test("one envelope per intent: the same intent resends the same ids, a changed one gets new ids", () => {
  const i = createIntents();
  const a = i.get("cart-1");
  expect(i.get("cart-1")).toEqual(a);
  const b = i.get("cart-2");
  expect(b.idempotency_key).not.toBe(a.idempotency_key);
  expect(b.entity_id).not.toBe(a.entity_id);
  i.clear();
  expect(i.get("cart-2").idempotency_key).not.toBe(b.idempotency_key);
});

const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  ({ response: new Response(null, { status, headers }), ...(status >= 400 ? { error: body } : {}) });
const err = (code: string, reason: string | null) => ({ error: { code, message: "composed by core", reason_code: reason } });

test("responses map to the cashier's states; core's own words are never shown", () => {
  expect(classify(res(201, undefined, { "X-Munim-Replayed": "true" }))).toEqual({ kind: "ok", replayed: true });
  expect(classify(res(201))).toEqual({ kind: "ok", replayed: false });
  expect(classify({})).toEqual({ kind: "off" });
  expect(classify(res(403, err("forbidden", null)))).toEqual({ kind: "deny" });
  expect(classify(res(422, err("invalid_payload", "price_above_mrp")))).toMatchObject({ kind: "refused", copyKey: "pos.refuse.price_above_mrp" });
  expect(classify(res(409, err("conflict", "order_tendered")))).toMatchObject({ copyKey: "pos.refuse.order_tendered" });
  expect(classify(res(422, err("invalid_payload", null)), { overAmountIsInvalid: true })).toMatchObject({ copyKey: "pos.refuse.over_amount" });
  expect(classify(res(422, err("invalid_payload", null)))).toMatchObject({ copyKey: "pos.refuse.generic" });
  expect(classify(res(422, err("invalid_payload", "some_new_code")))).toMatchObject({ copyKey: "pos.refuse.generic" });
  expect(classify(res(500, err("internal", null)))).toEqual({ kind: "err" });
});

test("option groups: required needs a pick, a single-choice group takes one", () => {
  const group = (o: Partial<MenuEntry["option_groups"][number]>) => ({ option_group_id: "g", name_key: "g", display_name: null, description: null, min_select: 0, max_select: 1, required: false, options: [], ...o }) as MenuEntry["option_groups"][number];
  expect(firstUnmet([group({ required: true })], {})?.option_group_id).toBe("g");
  expect(firstUnmet([group({ required: true })], { g: ["x"] })).toBeNull();
  expect(firstUnmet([group({})], {})).toBeNull();
  expect(firstUnmet([group({ min_select: 2, max_select: 3 })], { g: ["x"] })).not.toBeNull();
  expect(firstUnmet([group({ max_select: 1 })], { g: ["x", "y"] })).not.toBeNull();
});

test("menu grouping filters by search and keeps categories", () => {
  const menu = [entry("a"), entry("b", { category: "drinks", display_name: "Lassi" })];
  expect(groupByCategory(menu, "").map((g) => g.category)).toEqual(["mains", "drinks"]);
  expect(groupByCategory(menu, "lass").flatMap((g) => g.entries.map((e) => e.item_id))).toEqual(["b"]);
});

// Guarantee gate: no operator touches an amount. Amount fields are rendered or passed through, never added, subtracted,
// multiplied or divided. Scans every POS source file; the expected count of amount references is positive so an empty
// scan cannot pass.
export function moneyArithmetic(src: string): string[] {
  const hits: string[] = [];
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/"[^"]*"|`[^`]*`/g, '""');
    if (/_minor\s*[-+*/%]\s*[\w(]|[\w)]\s*[-+*/%]\s*[\w.]*_minor\b|\bamount\b\s*[-+*/]\s*\d|\bparseMinor\([^)]*\)\s*[*/]/.test(code)) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

function posSources(): { file: string; src: string }[] {
  const root = join(import.meta.dirname, "..");
  const out: { file: string; src: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) out.push({ file: p, src: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, "app/pos"));
  walk(join(root, "lib/pos"));
  return out;
}

test("no POS source does arithmetic on an amount (rule 9: totals are core's)", () => {
  const files = posSources();
  expect(files.length).toBeGreaterThanOrEqual(8);
  expect(files.reduce((n, f) => n + (f.src.match(/_minor/g)?.length ?? 0), 0)).toBeGreaterThan(30);
  for (const f of files) expect(moneyArithmetic(f.src), f.file).toEqual([]);
});

test("the scanner catches arithmetic (red proof)", () => {
  expect(moneyArithmetic("const t = line.price_minor * qty;")).toHaveLength(1);
  expect(moneyArithmetic("const t = base + order.tax_minor;")).toHaveLength(1);
  expect(moneyArithmetic("const left = order.total_minor - paid;")).toHaveLength(1);
  expect(moneyArithmetic('fmt.money(o.price_delta_minor, o.currency) // a - b_minor')).toEqual([]);
  expect(moneyArithmetic("const q = l.qtyMilli + 1000;")).toEqual([]);
});

test("names without a display name are title-cased, never the raw slug", () => {
  expect(entryName(entry("a", { display_name: null, name_key: "butter_chicken" }))).toBe("Butter Chicken");
  expect(entryName(entry("a", { display_name: null, name_key: "naan", variant_display_name: null, variant_name_key: "half_plate" }))).toBe("Naan · Half Plate");
  expect(entryName(entry("a", { display_name: "Chef's Special" }))).toBe("Chef's Special");
});
