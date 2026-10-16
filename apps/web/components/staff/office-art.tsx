// file: components/staff/office-art.tsx
"use client";
// The AI office's art (T-128): one desk per specialist, the simulated suppliers' bay and the owner's desk, drawn here from
// plain SVG shapes in Cobnut's tokens (cream, hazelnut, rose; fine cocoa outlines, rounded corners). Written for this
// project (hard rule 1; docs/plan/art/PROVENANCE.md): no sprite pack, no generated image, nothing traced. No text and no
// number is drawn: names are DOM text beside the art, and every figure lives in the finding or draft a desk links to.
// Motion (a nod and a lamp) is CSS only and stops under prefers-reduced-motion.
import type { Desk } from "@/lib/munim/office";

const SKIN = "#d9a37a"; // one warm skin tone for every figure: people are told apart by desk, prop and name, never colour
const SHIRT: Record<Desk, string> = {
  manager: "var(--primary)", catalogue: "var(--secondary)", kitchen: "#ffffff", inventory_purchasing: "#8c6e5a", finance: "#5b3a78",
  people: "#2e6b34", customers: "#9e2f4e", compliance: "#7a4b00", market: "#7b3f1d",
};

/** Each desk's prop, on the desk top: what the specialist works with. */
function Prop({ desk }: { desk: Desk }) {
  const s = { stroke: "var(--ink)", strokeWidth: 1.6, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  switch (desk) {
    case "manager": // a service bell
      return <g {...s}><path d="M74 50a8 8 0 0 1 16 0z" fill="var(--accent)" /><path d="M72 50h20" /><path d="M82 41v-2" /></g>;
    case "catalogue": // a menu card
      return <g {...s}><rect x="74" y="36" width="15" height="15" rx="2" fill="#ffffff" /><path d="M77 41h9M77 45h6" /></g>;
    case "kitchen": // a whisk in a bowl
      return <g {...s}><path d="M72 46h18a9 6 0 0 1-18 0z" fill="var(--accent)" /><path d="M84 46l4-12" /><ellipse cx="88.5" cy="33" rx="2.4" ry="3.4" fill="none" /></g>;
    case "inventory_purchasing": // a crate
      return <g {...s}><rect x="73" y="38" width="17" height="13" rx="1.5" fill="#e8c49a" /><path d="M73 44h17M81.5 38v13" /></g>;
    case "finance": // a ledger, open
      return <g {...s}><path d="M72 40l9 2v10l-9-2z" fill="#ffffff" /><path d="M81 42l9-2v10l-9 2z" fill="#ffffff" /><path d="M74 44l5 1M83 44l5-1" /></g>;
    case "people": // a rota on a clipboard
      return <g {...s}><rect x="74" y="35" width="14" height="17" rx="2" fill="#ffffff" /><path d="M77 40h8M77 44h8M77 48h5" /><rect x="78" y="33" width="6" height="3" rx="1" fill="var(--line)" /></g>;
    case "customers": // a speech bubble with a heart
      return <g {...s}><path d="M72 37h17v10h-10l-4 4v-4h-3z" fill="#ffffff" /><path d="M80.5 44.5l-3-3a1.6 1.6 0 0 1 3-1.6 1.6 1.6 0 0 1 3 1.6z" fill="var(--secondary)" strokeWidth={1} /></g>;
    case "compliance": // a thermometer
      return <g {...s}><rect x="79" y="32" width="5" height="16" rx="2.5" fill="#ffffff" /><circle cx="81.5" cy="49" r="3.6" fill="var(--secondary)" /><path d="M81.5 38v10" stroke="var(--secondary)" /></g>;
    default: // market: a flag on a stand
      return <g {...s}><path d="M77 52V33" /><path d="M77 34h12l-3 4 3 4H77" fill="var(--accent)" /></g>;
  }
}

/** One desk: the specialist, their desk and prop, and a lamp that lights while they work. */
export function DeskArt({ desk, active }: { desk: Desk; active: boolean }) {
  return (
    <svg viewBox="0 0 120 90" className="office-art" data-active={active ? "true" : undefined} aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="82" rx="46" ry="6" fill="var(--bg-deep)" />
      {/* the chair and the person behind the desk */}
      <rect x="31" y="30" width="32" height="36" rx="9" fill="#8c6e5a" stroke="var(--ink)" strokeWidth="1.6" />
      <g className="office-person">
        <path d="M29 62c0-17 8-26 18-26s18 9 18 26z" fill={SHIRT[desk]} stroke="var(--ink)" strokeWidth="1.6" />
        <circle cx="47" cy="23" r="11" fill={SKIN} stroke="var(--ink)" strokeWidth="1.6" />
        <path d="M36 20a11 11 0 0 1 22 0c-4-4-17-4-22 0z" fill="var(--ink)" />
        <circle cx="43" cy="24" r="1.3" fill="var(--ink)" />
        <circle cx="51" cy="24" r="1.3" fill="var(--ink)" />
      </g>
      {/* the desk top and its front */}
      <path d="M16 54h88l-6 8H22z" fill="var(--card)" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="22" y="62" width="76" height="16" rx="3" fill="#e8c49a" stroke="var(--ink)" strokeWidth="1.6" />
      <path d="M60 62v16" stroke="var(--ink)" strokeWidth="1.2" />
      {/* the lamp */}
      <path d="M24 54V38l8-6" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
      <path className="office-lamp" d="M28 30l10 2-4 8z" fill="var(--line)" stroke="var(--ink)" strokeWidth="1.4" strokeLinejoin="round" />
      <Prop desk={desk} />
    </svg>
  );
}

/** The simulated suppliers' bay: three crates under a striped awning, the dashed outline that marks anything simulated. */
export function SupplierBayArt({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 120 90" className="office-art" data-active={active ? "true" : undefined} aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="82" rx="46" ry="6" fill="var(--bg-deep)" />
      <rect x="14" y="16" width="92" height="62" rx="6" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeDasharray="5 4" />
      <path d="M18 24h84l-6 10H24z" fill="var(--accent)" stroke="var(--ink)" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M38 24l-3 10M58 24v10M78 24l3 10" stroke="var(--secondary)" strokeWidth="3" />
      {[24, 50, 76].map((x) => (
        <g key={x} className="office-person">
          <rect x={x} y="50" width="20" height="24" rx="2" fill="#e8c49a" stroke="var(--ink)" strokeWidth="1.6" />
          <path d={`M${x} 58h20M${x + 10} 50v24`} stroke="var(--ink)" strokeWidth="1.2" />
        </g>
      ))}
    </svg>
  );
}

/** The owner's desk: an in-tray where a proposal lands for a person to decide. */
export function OwnerDeskArt({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 120 90" className="office-art" data-active={active ? "true" : undefined} aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="82" rx="46" ry="6" fill="var(--bg-deep)" />
      <path d="M16 54h88l-6 8H22z" fill="var(--card)" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="22" y="62" width="76" height="16" rx="3" fill="#e8c49a" stroke="var(--ink)" strokeWidth="1.6" />
      <path d="M40 54l4-10h32l4 10" fill="#ffffff" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
      <g className="office-paper">
        <path d="M48 47l2-12h20l2 12" fill="var(--accent)" stroke="var(--ink)" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M54 40h12" stroke="var(--ink)" strokeWidth="1.2" />
      </g>
      <circle cx="96" cy="44" r="7" fill="var(--secondary)" stroke="var(--ink)" strokeWidth="1.4" />
      <path d="M92.5 44l2.5 2.5 4.5-5" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
