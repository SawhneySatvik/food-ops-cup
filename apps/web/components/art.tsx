// Illustrations drawn by hand for this project as inline SVG: flat palette fills, fine cocoa strokes, simple
// geometric parts. Decorative: every one is aria-hidden. Logged in the README.

const INK = "var(--ink)";

/** Hero: a croissant made of five overlapping crescents, leaning on a hazelnut, with two warm steam curls. */
export function HeroArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 240" className={className} aria-hidden="true" focusable="false">
      <ellipse cx="160" cy="214" rx="132" ry="14" fill="var(--bg-deep)" />
      <g stroke={INK} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <path d="M40 168c10-46 42-70 70-74 6 30-8 64-34 86-14 6-30 2-36-12z" fill="#d9a066" />
        <path d="M250 168c-10-46-42-70-70-74-6 30 8 64 34 86 14 6 30 2 36-12z" fill="#d9a066" />
        <path d="M92 102c18-30 46-40 68-40s50 10 68 40c-10 40-36 72-68 72s-58-32-68-72z" fill="#e8b57c" />
        <path d="M120 80c12-20 26-26 40-26s28 6 40 26c-6 30-22 54-40 54s-34-24-40-54z" fill="#f0c993" />
        <path d="M112 112c14 6 30 9 48 9s34-3 48-9M128 146c10 4 20 6 32 6s22-2 32-6" fill="none" />
        <path d="M232 196c-6-22 6-44 26-48 20-4 36 12 36 32 0 18-14 30-30 30-14 0-28-4-32-14z" fill="#9a5b2e" />
        <path d="M246 156c4-12 16-18 28-14l2 10c-10-2-20 0-30 4z" fill="#6b3a1b" />
        <path d="M258 176c4 8 12 12 22 10" fill="none" stroke="#f0c993" />
      </g>
      <g fill="none" stroke="var(--secondary)" strokeWidth="3" strokeLinecap="round">
        <path d="M140 44c-8-8 8-14 0-24" />
        <path d="M176 44c-8-8 8-14 0-24" />
      </g>
      <g fill="var(--secondary)">
        <circle cx="58" cy="70" r="4" />
        <circle cx="268" cy="92" r="3" />
        <circle cx="290" cy="60" r="5" />
      </g>
    </svg>
  );
}

/** A single hazelnut: cap and nut, for marks and section motifs. */
export function Hazelnut({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <g stroke={INK} strokeWidth="1.6" strokeLinejoin="round">
        <path d="M6 18c0-6 4.5-9.5 10-9.5S26 12 26 18c0 5.5-4.5 10-10 10S6 23.5 6 18z" fill="#9a5b2e" />
        <path d="M7 13c2-6 6-9 9-9s7 3 9 9c-3-2-6-3-9-3s-6 1-9 3z" fill="#6b3a1b" />
      </g>
      <path d="M11 20c1.5 3 4 4.5 7 4.5" fill="none" stroke="#f0c993" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Category motifs: a little line drawing for each category the bakery uses (fallback: the hazelnut). */
export function CategoryMotif({ slug, size = 30 }: { slug: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 32 32", "aria-hidden": true as const, focusable: "false" as const };
  const s = { stroke: INK, strokeWidth: 1.6, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  switch (slug) {
    case "pastries":
      return <svg {...common}><g {...s}><path d="M4 22c2-8 7-12 12-12s10 4 12 12c-4 2-8 3-12 3s-8-1-12-3z" fill="#e8b57c" /><path d="M11 12l2 11M21 12l-2 11" fill="none" /></g></svg>;
    case "cakes":
      return <svg {...common}><g {...s}><path d="M5 26V15l22-6v17z" fill="#f6d9c8" /><path d="M5 19.5 27 14" fill="none" stroke="var(--secondary)" /><circle cx="22" cy="7" r="2.4" fill="var(--secondary)" /></g></svg>;
    case "cookies":
      return <svg {...common}><g {...s}><circle cx="16" cy="16" r="11" fill="#d9a066" /><g fill={INK} stroke="none"><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="14" r="1.6" /><circle cx="14" cy="20" r="1.6" /><circle cx="21" cy="21" r="1.2" /></g></g></svg>;
    case "gift_boxes":
      return <svg {...common}><g {...s}><rect x="5" y="13" width="22" height="14" rx="2" fill="#f6d9c8" /><path d="M4 13h24M16 13v14" fill="none" stroke="var(--secondary)" /><path d="M16 13c-3-6-9-6-9-2.5S13 13 16 13zm0 0c3-6 9-6 9-2.5S19 13 16 13z" fill="none" stroke="var(--secondary)" /></g></svg>;
    case "drinks":
      return <svg {...common}><g {...s}><path d="M8 11h16l-2 16H10z" fill="#ffffff" /><path d="M7 11h18" fill="none" /><path d="M10 16h12l-1 6H11z" fill="#9a5b2e" stroke="none" /><path d="M13 7c-1.5-1.5 1.5-2.5 0-4M19 7c-1.5-1.5 1.5-2.5 0-4" fill="none" stroke="var(--secondary)" /></g></svg>;
    default:
      return <Hazelnut size={size} />;
  }
}

/** The wordmark: a hazelnut beside the name in the serif. `compact` drops "Bakehouse" on phones, in the two page bars
 *  (shop: Staff and Cart beside it; staff: the person and Sign out), where the full name does not fit one row. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Hazelnut size={30} />
      <span className="display text-[22px] leading-none">
        Cobnut <span className={`italic text-secondary${compact ? " max-sm:hidden" : ""}`}>Bakehouse</span>
      </span>
    </span>
  );
}
