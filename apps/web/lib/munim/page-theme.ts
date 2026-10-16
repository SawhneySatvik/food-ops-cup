// file: lib/munim/page-theme.ts
// The storefront page (T-128; design-system §9): Cobnut's built-in document, the theme presets, the contrast readout the
// editor shows, and a theme as CSS variables. Core judges a theme when it is saved (core-domain storefront/index.ts, the same
// WCAG rule); this copy only tells the person, as they pick, whether a save would be refused. Locked, so never set here:
// fonts, the semantic tokens (danger, ok, warn, the source chip), the focus ring and the page background. Plain TypeScript.
import type { CSSProperties } from "react";
import type { Schemas } from "./types";

export type PageDoc = Schemas["StorefrontPageDoc"];
export type Theme = PageDoc["theme"];
export type Section = PageDoc["sections"][number];

/** The storefront as built: Cobnut's own look and words. The shop shows exactly this while nothing is published. */
export const BUILT_IN: PageDoc = {
  theme: { primary: "#7b3f1d", secondary: "#9e2f4e", accent: "#f6d9c8", radius: "round", layout: "hero-banner" },
  sections: [
    { kind: "hero", visible: true, badge: "Lucknow · two bakehouses · pickup only", tagline: "Baked at dawn. Boxed with care. Pick up warm." },
    { kind: "outlets", visible: true, title: "Pick your bakehouse" },
    { kind: "ribbon", visible: true },
    { kind: "cards", visible: true, cards: [
      { title: "Build a gift box", body: "Pick a box size and two to four truffle-cookie flavours, add a ribbon and a card. Choose an outlet to start." },
      { title: "Cakes with a message", body: "Celebration cakes by weight, classic or eggless, with your words piped on top." },
    ] },
  ],
};

/** Colour presets; every one passes the contrast rule (measured in the page-theme test). */
export const PRESETS: Array<{ id: string; name: string; colours: Pick<Theme, "primary" | "secondary" | "accent"> }> = [
  { id: "cobnut", name: "Cobnut original", colours: { primary: "#7b3f1d", secondary: "#9e2f4e", accent: "#f6d9c8" } },
  { id: "pistachio", name: "Pistachio", colours: { primary: "#2f5d3a", secondary: "#8a3b5c", accent: "#dcebc9" } },
  { id: "plum", name: "Plum and cream", colours: { primary: "#5b2a5e", secondary: "#a3361c", accent: "#f3dbe8" } },
  { id: "harbour", name: "Harbour blue", colours: { primary: "#1f4e6b", secondary: "#9e2f4e", accent: "#d6e8ef" } },
  { id: "espresso", name: "Espresso", colours: { primary: "#3b2416", secondary: "#7a4b00", accent: "#f1e0c5" } },
];

export const LAYOUTS: Array<{ id: Theme["layout"]; name: string; how: string }> = [
  { id: "hero-banner", name: "Large welcome", how: "A big welcome with the illustration, then the outlets side by side." },
  { id: "menu-grid", name: "Straight to the outlets", how: "A short welcome, then the outlets side by side." },
  { id: "menu-list", name: "Outlets as a list", how: "A short welcome, then the outlets one under the other." },
];

/** The page background and ink are locked (globals.css --bg, --ink). */
const PAGE = "#fbf4ea";
const INK = "#2a1a12";
const WHITE = "#ffffff";
export const MIN_RATIO = 4.5;

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
/** WCAG 2.x contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
export const isHex = (s: string): boolean => /^#[0-9a-f]{6}$/.test(s);

/** The text colour that reads on a fill (white, else ink), or null when neither reaches 4.5 : 1. */
export const onColour = (fill: string): string | null => (contrast(WHITE, fill) >= MIN_RATIO ? WHITE : contrast(INK, fill) >= MIN_RATIO ? INK : null);

/** What the editor shows beside each colour: the ratio that limits it and whether a save would pass. */
export interface Readout { ratio: number; ok: boolean; why: string }
export function readout(token: "primary" | "secondary" | "accent", hex: string): Readout {
  if (!isHex(hex)) return { ratio: 1, ok: false, why: "Not a colour" };
  if (token === "accent") {
    const r = contrast(INK, hex);
    return { ratio: r, ok: r >= MIN_RATIO, why: "Dark text on it" };
  }
  const on = Math.max(contrast(WHITE, hex), contrast(INK, hex));
  const page = contrast(hex, PAGE);
  return on < page ? { ratio: on, ok: on >= MIN_RATIO, why: "Text on it" } : { ratio: page, ok: page >= MIN_RATIO, why: "As text on the page" };
}
export const themeOk = (t: Theme): boolean => (["primary", "secondary", "accent"] as const).every((k) => readout(k, t[k]).ok);

/** "8.2 : 1". */
export const ratioWords = (r: number): string => `${(Math.floor(r * 10) / 10).toFixed(1)} : 1`;

/** A theme as the storefront's CSS variables (set on the shop's wrapper; the staff screens never wear it). */
export function themeVars(t: Theme): CSSProperties {
  return {
    "--primary": t.primary, "--on-primary": onColour(t.primary) ?? WHITE,
    "--secondary": t.secondary, "--on-secondary": onColour(t.secondary) ?? WHITE,
    "--accent": t.accent, "--on-accent": INK,
    "--radius-card": t.radius === "round" ? "22px" : "12px", "--radius-field": t.radius === "round" ? "14px" : "8px",
  } as CSSProperties;
}

/** Moves the section at `from` one place up or down (the non-drag way); out of range = unchanged. */
export function moveSection(sections: readonly Section[], from: number, to: number): Section[] {
  if (from === to || from < 0 || to < 0 || from >= sections.length || to >= sections.length) return [...sections];
  const out = [...sections];
  const [s] = out.splice(from, 1);
  out.splice(to, 0, s!);
  return out;
}

export const SECTION_NAME: Record<Section["kind"], string> = { hero: "Welcome", outlets: "Outlets", ribbon: "Ribbon of words", cards: "Cards" };
