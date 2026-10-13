// Cobnut Bakehouse's only site-specific constants. Everything else comes from the API or lib/munim.
import { E164_PATTERN } from "./munim/checkout";
import { titleCase } from "./munim/format";

export const SITE = {
  name: "Cobnut Bakehouse",
  short: "Cobnut",
  tagline: "Baked at dawn. Boxed with care. Pick up warm.",
  locale: "en-IN",
  /** Categories in this order first; any category the API adds later follows in API order. */
  categoryOrder: ["pastries", "cakes", "cookies", "gift_boxes", "drinks"],
} as const;

// The API sends categories and deals as keys only (no display names): label them here, with a fallback.
const CATEGORY_LABEL: Record<string, string> = { pastries: "Pastries", cakes: "Cakes", cookies: "Cookies", gift_boxes: "Gift boxes", drinks: "Drinks" };
const DEAL_LABEL: Record<string, string> = { "deal.morning_bake": "Morning bake" };

export const categoryLabel = (slug: string): string => CATEGORY_LABEL[slug] ?? titleCase(slug);
export const dealLabel = (nameKey: string): string => DEAL_LABEL[nameKey] ?? titleCase(nameKey);

/** A bakery's diet words. In India the green veg mark already means "no egg", so it reads "Eggless" here; the
 *  marks themselves still follow the API's `diet` exactly and nothing is guessed from a name. */
export const DIET_WORD: Record<string, string> = { veg: "Eggless", non_veg: "Non-veg", egg: "Contains egg", vegan: "Vegan" };

/** Items that take a written note, by name_key: the label and the hint for the text box. Sent as the line's note. */
export const NOTE_FIELDS: Record<string, { label: string; hint: string }> = {
  "item.praline_celebration_cake": { label: "Message on the cake (optional)", hint: "Piped in chocolate. Up to 40 characters fit best." },
  "item.build_a_box": { label: "Gift card message (optional)", hint: "Handwritten on the card if you choose gift wrap." },
};

/** An Indian mobile number as typed ("98123 45678", "098123-45678", "+91 98123 45678", "919812345678") -> E.164
 *  ("+919812345678"); null when it is not one. */
export function toE164(input: string): string | null {
  const d = input.replace(/[\s()-]/g, "");
  const e = d.startsWith("+") ? d : /^0\d{10}$/.test(d) ? `+91${d.slice(1)}` : /^91\d{10}$/.test(d) ? `+${d}` : /^\d{10}$/.test(d) ? `+91${d}` : null;
  return e !== null && E164_PATTERN.test(e) && (!e.startsWith("+91") || /^\+91[6-9]\d{9}$/.test(e)) ? e : null;
}

export const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
