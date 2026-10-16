// Storefront theme contrast (T-128; design-system §9, §10): the colours an owner picks must keep text readable. WCAG 2.x
// relative luminance and contrast ratio, judged here (core-api refuses a failing theme with `theme_contrast`); apps/web keeps a
// copy for the editor's live readout only. The page background and the ink are the storefront's locked tokens (not themable).

/** The storefront's locked page background and text colour (apps/web globals.css --bg, --ink). */
export const PAGE = "#fbf4ea";
export const INK = "#2a1a12";
export const WHITE = "#ffffff";
/** WCAG AA for body text. */
export const MIN_RATIO = 4.5;

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export type ThemeVerdict =
  | { ok: true; onPrimary: string; onSecondary: string }
  | { ok: false; token: "primary" | "secondary" | "accent"; ratio: number };

/** The text colour that reads on a fill: white when it reaches 4.5:1, else ink, else null. */
const onColour = (fill: string): string | null => (contrast(WHITE, fill) >= MIN_RATIO ? WHITE : contrast(INK, fill) >= MIN_RATIO ? INK : null);

/** Primary and secondary each need a text colour on them and must read as text on the page; ink must read on the accent.
 *  The first failure is reported with its measured ratio (the best one reachable for that token). */
export function judgeTheme(t: { primary: string; secondary: string; accent: string }): ThemeVerdict {
  for (const token of ["primary", "secondary"] as const) {
    const fill = t[token];
    const on = onColour(fill);
    const onPage = contrast(fill, PAGE);
    if (!on) return { ok: false, token, ratio: Math.max(contrast(WHITE, fill), contrast(INK, fill)) };
    if (onPage < MIN_RATIO) return { ok: false, token, ratio: onPage };
  }
  const accent = contrast(INK, t.accent);
  if (accent < MIN_RATIO) return { ok: false, token: "accent", ratio: accent };
  return { ok: true, onPrimary: onColour(t.primary)!, onSecondary: onColour(t.secondary)! };
}
