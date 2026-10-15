// The synthetic business behind the in-app mock: Cobnut Bakehouse, two outlets in Lucknow (all invented).
// This file is the stand-in for Munim's books. The storefront never imports it; it only reaches it over HTTP.
import { createHash } from "node:crypto";

/** A stable UUIDv7-shaped id derived from a name, so every server instance agrees on every id. */
export function id7(name: string): string {
  const h = createHash("sha256").update(`cobnut:${name}`).digest("hex");
  const variant = "89ab"[parseInt(h[16]!, 16) % 4]!;
  // A fixed 2026 timestamp prefix keeps the ids looking like real v7 ids.
  return `019a0c5e-${h.slice(0, 4)}-7${h.slice(4, 7)}-${variant}${h.slice(7, 10)}-${h.slice(10, 22)}`;
}

export const STOREFRONT_KEY = "sfk_mock_cobnut_bakehouse_5b1e7d40";
export const TZ = "Asia/Kolkata";
/** India has no daylight saving: the mock may use a fixed offset for its own outlet hours. */
export const TZ_OFFSET_MIN = 330;
export const CURRENCY = "INR";
export const PREP_MIN = 15;
export const OPEN_FROM_MIN = 8 * 60; // 08:00 outlet time
export const OPEN_TO_MIN = 21 * 60; // 21:00 outlet time
export const WINDOW_CAPACITY = 6;
export const TAX = { rateBp: 500, components: [{ code: "CGST", rateBp: 250 }, { code: "SGST", rateBp: 250 }] };
export const TAX_CLASS = "bakery_5";

export const BRAND = { brand_id: id7("brand"), name: "Cobnut Bakehouse (synthetic)" };
export const CHANNEL_ID = id7("channel:own_site");

export interface MockOutlet {
  outlet_id: string;
  name: string;
  address: string;
  phone: string | null;
  tax_ids: { code: string; label: string; value: string }[];
  state: "open" | "busy";
  busy_extra_min: number;
  /** Item slugs sold out at this outlet only. */
  soldOut: string[];
}

export const OUTLETS: MockOutlet[] = [
  {
    outlet_id: id7("outlet:hazratganj"),
    name: "Cobnut Hazratganj",
    address: "14 Synthetic Arcade, Hazratganj, Lucknow (synthetic)",
    phone: "+919000000201",
    tax_ids: [
      { code: "GSTIN", label: "GSTIN", value: "09AAAAA0001A1Z5" },
      { code: "FSSAI", label: "FSSAI Lic. No.", value: "20000000000001" },
    ],
    state: "open",
    busy_extra_min: 0,
    soldOut: [],
  },
  {
    outlet_id: id7("outlet:gomti_nagar"),
    name: "Cobnut Gomti Nagar",
    address: "7 Synthetic Market, Gomti Nagar, Lucknow (synthetic)",
    phone: null,
    tax_ids: [],
    state: "busy",
    busy_extra_min: 10,
    soldOut: ["rose_tres_leches"],
  },
];

export interface MockOption {
  slug: string;
  name: string;
  delta: number;
}
export interface MockGroup {
  slug: string;
  name: string;
  description: string | null;
  min: number;
  max: number;
  options: MockOption[];
}
export interface MockVariant {
  slug: string;
  name: string;
  description: string | null;
  price: number;
}
export interface MockItem {
  slug: string;
  name: string;
  description: string;
  diet: "veg" | "non_veg" | "egg" | "vegan" | null;
  category: string;
  kind: "dish" | "sku" | "combo";
  price: number | null;
  variants: MockVariant[];
  groups: MockGroup[];
  /** Sold out at every outlet. */
  soldOut?: boolean;
}

// Prices in paise, excluding GST. Every amount the storefront shows is computed from these by the mock's pricing.
export const ITEMS: MockItem[] = [
  { slug: "hazelnut_croissant", name: "Hazelnut Croissant", description: "Laminated butter dough rolled around roasted hazelnut cream, finished with a crackly praline glaze.", diet: "egg", category: "pastries", kind: "dish", price: 18000, variants: [], groups: [] },
  { slug: "pain_au_chocolat", name: "Pain au Chocolat", description: "Two batons of dark chocolate tucked into flaky, buttery layers.", diet: "egg", category: "pastries", kind: "dish", price: 17000, variants: [], groups: [] },
  { slug: "cardamom_knot", name: "Cardamom Knot", description: "A soft, twisted bun brushed with cardamom sugar syrup. Made without eggs.", diet: "veg", category: "pastries", kind: "dish", price: 14000, variants: [], groups: [] },
  { slug: "pistachio_danish", name: "Pistachio Danish", description: "Pistachio frangipane and a glossy apricot glaze on a crisp pastry pinwheel.", diet: "egg", category: "pastries", kind: "dish", price: 21000, variants: [], groups: [], soldOut: true },
  {
    slug: "praline_celebration_cake", name: "Hazelnut Praline Cake", description: "Layers of sponge, hazelnut praline cream and a whisper of dark chocolate ganache. Add a message for the top.", diet: null, category: "cakes", kind: "dish", price: null,
    variants: [
      { slug: "half_kg", name: "½ kg (serves 4–6)", description: null, price: 75000 },
      { slug: "one_kg", name: "1 kg (serves 8–10)", description: null, price: 140000 },
    ],
    groups: [
      { slug: "sponge", name: "Sponge", description: null, min: 1, max: 1, options: [{ slug: "classic", name: "Classic (contains egg)", delta: 0 }, { slug: "eggless", name: "Eggless", delta: 8000 }] },
    ],
  },
  { slug: "gianduja_mousse", name: "Gianduja Mousse Cup", description: "Silky milk-chocolate hazelnut mousse over a cocoa crumb.", diet: "egg", category: "cakes", kind: "dish", price: 26000, variants: [], groups: [] },
  { slug: "rose_tres_leches", name: "Rose Pistachio Tres Leches", description: "A milk-soaked slice scented with rose, topped with chopped pistachio.", diet: "egg", category: "cakes", kind: "dish", price: 24000, variants: [], groups: [] },
  { slug: "brown_butter_cookie", name: "Brown Butter Hazelnut Cookie", description: "Chewy middle, crisp edge, toasted hazelnuts all the way through.", diet: "egg", category: "cookies", kind: "dish", price: 9000, variants: [], groups: [] },
  { slug: "eggless_choc_chip", name: "Eggless Choc-Chip Cookie", description: "Our classic chocolate chip cookie, made without eggs.", diet: "veg", category: "cookies", kind: "dish", price: 8000, variants: [], groups: [] },
  { slug: "oat_jaggery_cookie", name: "Oat & Jaggery Cookie", description: "Rolled oats, jaggery and coconut oil. No dairy, no eggs.", diet: "vegan", category: "cookies", kind: "dish", price: 8500, variants: [], groups: [] },
  {
    slug: "build_a_box", name: "Build-a-Box", description: "Pick a box size and two to four flavours of our bite-sized truffle cookies. Boxed and ribboned to give.", diet: null, category: "gift_boxes", kind: "combo", price: null,
    variants: [
      { slug: "box_6", name: "Box of 6", description: null, price: 54000 },
      { slug: "box_9", name: "Box of 9", description: null, price: 78000 },
      { slug: "box_12", name: "Box of 12", description: null, price: 102000 },
    ],
    groups: [
      {
        slug: "flavours", name: "Flavours", description: "Choose 2 to 4.", min: 2, max: 4,
        options: [
          { slug: "hazelnut_praline", name: "Hazelnut praline", delta: 0 },
          { slug: "dark_chocolate", name: "Dark chocolate", delta: 0 },
          { slug: "salted_caramel", name: "Salted caramel", delta: 0 },
          { slug: "rose_pistachio", name: "Rose pistachio", delta: 0 },
          { slug: "coffee_walnut", name: "Coffee walnut", delta: 0 },
          { slug: "kesar_badam", name: "Kesar badam", delta: 6000 },
        ],
      },
      { slug: "gift_wrap", name: "Gift wrap", description: null, min: 0, max: 1, options: [{ slug: "ribbon_card", name: "Ribbon and gift card", delta: 5000 }] },
    ],
  },
  { slug: "truffle_tin", name: "Truffle Tin", description: "Sixteen hand-rolled hazelnut and cocoa truffles in a keepsake tin. Made without eggs.", diet: "veg", category: "gift_boxes", kind: "sku", price: 65000, variants: [], groups: [] },
  {
    slug: "hazelnut_hot_chocolate", name: "Hazelnut Hot Chocolate", description: "Steamed milk, melted dark chocolate and roasted hazelnut paste.", diet: "veg", category: "drinks", kind: "dish", price: null,
    variants: [
      { slug: "regular", name: "Regular", description: null, price: 16000 },
      { slug: "large", name: "Large", description: null, price: 21000 },
    ],
    groups: [],
  },
  {
    slug: "cold_coffee", name: "Cold Coffee", description: "Strong brew shaken with milk and a little jaggery syrup.", diet: "veg", category: "drinks", kind: "dish", price: 15000, variants: [],
    groups: [{ slug: "milk", name: "Milk", description: null, min: 1, max: 1, options: [{ slug: "dairy", name: "Dairy", delta: 0 }, { slug: "oat", name: "Oat", delta: 4000 }] }],
  },
];

export const itemId = (slug: string) => id7(`item:${slug}`);
export const variantId = (item: string, slug: string) => id7(`variant:${item}:${slug}`);
export const groupId = (item: string, slug: string) => id7(`group:${item}:${slug}`);
export const optionId = (item: string, group: string, slug: string) => id7(`option:${item}:${group}:${slug}`);

export interface MockDeal {
  deal_id: string;
  name_key: string;
  kind: string;
  /** Percent off the eligible lines, in basis points. Never sent to the storefront (the API sends no percentage). */
  pctBp: number;
  items: string[];
  windows: { days: number[]; from: string; to: string }[];
  valid_from: string;
  valid_to: string | null;
}

export const DEALS: MockDeal[] = [
  {
    deal_id: id7("deal:morning_bake"),
    name_key: "deal.morning_bake",
    kind: "percent_item",
    pctBp: 2000,
    items: ["cardamom_knot", "hazelnut_croissant"],
    windows: [{ days: [1, 2, 3, 4, 5, 6], from: "08:00", to: "11:00" }],
    valid_from: "2026-01-01",
    valid_to: null,
  },
];

export interface MockCoupon {
  code: string;
  coupon_id: string;
  pctBp: number;
  minSpend?: number;
  outlet?: string;
  expired?: boolean;
  capReached?: boolean;
}

export const COUPONS: MockCoupon[] = [
  { code: "COBNUT10", coupon_id: id7("coupon:cobnut10"), pctBp: 1000, minSpend: 50000 },
  { code: "GANJ5", coupon_id: id7("coupon:ganj5"), pctBp: 500, outlet: OUTLETS[0]!.outlet_id },
  { code: "DIWALI25", coupon_id: id7("coupon:diwali25"), pctBp: 2500, expired: true },
  { code: "FIRST50", coupon_id: id7("coupon:first50"), pctBp: 5000, capReached: true },
];
