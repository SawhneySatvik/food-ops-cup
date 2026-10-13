"use client";
// Shared client components: header, banners, diet marks, full-page messages, toast, outlet contact, mock panel.
import Link from "next/link";
import { useEffect, useState } from "react";
import { acceptingText, readyInMinutes } from "@/lib/munim/copy";
import { formatWhen } from "@/lib/munim/format";
import { MOCK_CONTROLS_ENABLED, readMockControls, writeMockControls, type ForcedAccepting } from "@/lib/munim/mock-controls";
import { IS_MOCK } from "@/lib/munim";
import type { Schemas } from "@/lib/munim/types";
import { DIET_WORD, SITE } from "@/lib/site";
import { Wordmark } from "./art";
import { AlertIcon, BagIcon, ClockIcon, Dot, LeafIcon, MoonIcon, OfflineIcon, PauseIcon, PhoneIcon, PinIcon } from "./icons";

type Accepting = Schemas["StorefrontAcceptingResponse"];
type Outlet = Schemas["StorefrontOutletsResponse"]["outlets"][number];

export function SiteHeader({ count, onCart }: { count?: number; onCart?: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b-[1.5px] border-line bg-bg">
      <div className="wrap flex min-h-[64px] items-center justify-between gap-3">
        <Link href="/" className="text-ink no-underline" aria-label={`${SITE.name}, home`}>
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          <Link href="/story" className="hidden min-h-12 items-center px-3 font-semibold text-ink no-underline sm:inline-flex">Our story</Link>
          <Link href="/cares" className="hidden min-h-12 items-center px-3 font-semibold text-ink no-underline sm:inline-flex">Cares</Link>
          {onCart && (
            <button type="button" className="btn btn-plain" onClick={onCart} aria-label={count ? `Cart, ${count} ${count === 1 ? "item" : "items"}` : "Cart, empty"}>
              <BagIcon />
              {count ? <span className="num">{count}</span> : null}
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}

const nextOpenText = (a: Accepting) => (a.next_open ? formatWhen(a.next_open, a.tz, SITE.locale) : null);

/** The outlet's state under the header. Reserves its height while loading (no layout shift). */
export function StateBanner({ accepting }: { accepting: Accepting | null }) {
  if (!accepting) return <div className="min-h-[56px] border-b-[1.5px] border-line bg-bg-deep" aria-hidden="true" />;
  const text = acceptingText(accepting, nextOpenText(accepting));
  const open = accepting.state === "open" || accepting.state === "busy";
  const tone =
    accepting.state === "open" ? "bg-card text-ink"
    : accepting.state === "busy" ? "bg-accent text-on-accent"
    : "bg-ink text-white";
  return (
    <div className={`min-h-[56px] border-b-[1.5px] border-line ${tone}`} role="status">
      <div className="wrap flex min-h-[56px] flex-wrap items-center gap-x-4 gap-y-1 py-2 font-semibold">
        <span className="inline-flex items-center gap-2">
          <StateIcon state={accepting.state} />
          {text}
        </span>
        {open && <span className="inline-flex items-center gap-2 font-normal"><ClockIcon size={18} /> Ready in about {readyInMinutes(accepting)} min</span>}
      </div>
    </div>
  );
}

export function StateIcon({ state }: { state: Accepting["state"] }) {
  if (state === "open") return <Dot className="bg-ok" />;
  if (state === "busy") return <ClockIcon size={18} />;
  if (state === "paused") return <PauseIcon size={18} />;
  return <MoonIcon size={18} />;
}

export function OfflineBanner({ show, text }: { show: boolean; text: string }) {
  if (!show) return null;
  return (
    <div className="sticky top-[65px] z-30 border-b-[1.5px] border-line bg-ink text-white" role="status">
      <div className="wrap flex min-h-12 items-center gap-2 py-2 font-semibold">
        <OfflineIcon size={20} className="flex-none" /> {text}
      </div>
    </div>
  );
}

/** The diet mark with its word (none when diet is null). Drawn shapes, never colour alone. */
export function DietBadge({ diet }: { diet: string | null }) {
  if (!diet || !DIET_WORD[diet]) return null;
  const mark =
    diet === "vegan" ? <LeafIcon size={16} className="text-veg" />
    : (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke={diet === "veg" ? "var(--veg)" : diet === "egg" ? "var(--ink)" : "var(--nonveg)"} strokeWidth="1.6" />
        {diet === "veg" && <circle cx="8" cy="8" r="3.6" fill="var(--veg)" />}
        {diet === "non_veg" && <path d="M8 4 12 11.5H4z" fill="var(--nonveg)" />}
        {diet === "egg" && <ellipse cx="8" cy="8.3" rx="3" ry="3.9" fill="var(--ink)" />}
      </svg>
    );
  return <span className="badge">{mark}{DIET_WORD[diet]}</span>;
}

export function FullPage({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="wrap grid min-h-[100dvh] content-start justify-items-center py-16">
      <div className="card w-full max-w-[520px] p-8 text-center">
        <h1 className="text-[34px]">{title}</h1>
        <div className="mt-3 space-y-2 text-muted">{children}</div>
        {action && <div className="mt-6 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function NotValid({ extra }: { extra?: string }) {
  return (
    <FullPage title="This link isn't valid." action={<Link href="/" className="btn btn-primary">Go to the menu</Link>}>
      <p>Check the address, or start again from the menu.</p>
      {extra && <p>{extra}</p>}
    </FullPage>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 font-semibold text-danger" role="alert">
      <AlertIcon size={20} className="mt-0.5 flex-none" /> <span>{children}</span>
    </p>
  );
}

/** "Added" and friends: a polite live region that is always mounted, so screen readers hear each message. */
export function Toast({ message }: { message: string | null }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 lg:bottom-8" role="status" aria-live="polite">
      {message && <div className="toast card px-6 py-3 font-semibold">{message}</div>}
    </div>
  );
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg];
}

/** The outlet's contact block shown above the footer on outlet routes. */
export function OutletContact({ outlet }: { outlet: Outlet | null }) {
  if (!outlet) return null;
  return (
    <section aria-label="Outlet details" className="wrap mt-12">
      <div className="card grid gap-2 p-6 sm:grid-cols-2">
        <div>
          <p className="display text-[22px]">{outlet.name}</p>
          <p className="mt-1 flex items-start gap-2 text-muted"><PinIcon size={20} className="mt-0.5 flex-none" />{outlet.address}</p>
        </div>
        <div className="space-y-1 text-[14px]">
          {outlet.phone && (
            <a className="inline-flex min-h-12 items-center gap-2 text-[16px] font-semibold" href={`tel:${outlet.phone}`}>
              <PhoneIcon size={20} /> {outlet.phone}
            </a>
          )}
          {outlet.tax_ids.map((t) => <p key={t.code} className="num">{t.label} {t.value}</p>)}
        </div>
      </div>
    </section>
  );
}

/** Dev-only switches for the mock's X-Mock-Force-* headers. Never rendered against the real API. */
export function MockPanel({ onChange }: { onChange?: () => void }) {
  const [c, setC] = useState(() => ({ accepting: null as ForcedAccepting | null, force429: false }));
  const [open, setOpen] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after hydration
  useEffect(() => setC(readMockControls()), []);
  if (!MOCK_CONTROLS_ENABLED || !IS_MOCK) return null;
  const update = (next: typeof c) => {
    setC(next);
    writeMockControls(next);
    onChange?.();
  };
  return (
    <div className="fixed bottom-24 right-3 z-40 lg:bottom-4">
      {open ? (
        <div className="card w-[240px] space-y-3 p-4 text-[14px]">
          <p className="font-bold">Mock test controls (dev only)</p>
          <label className="block">
            Outlet state
            <select value={c.accepting ?? ""} onChange={(e) => update({ ...c, accepting: (e.target.value || null) as ForcedAccepting | null })}>
              <option value="">normal</option>
              <option value="open">open</option>
              <option value="busy">busy</option>
              <option value="paused">paused</option>
              <option value="closed">closed</option>
            </select>
          </label>
          <label className="block">
            Force 429
            <select value={c.force429 ? "on" : "off"} onChange={(e) => update({ ...c, force429: e.target.value === "on" })}>
              <option value="off">off</option>
              <option value="on">on</option>
            </select>
          </label>
          <button type="button" className="btn btn-plain w-full" onClick={() => setOpen(false)}>Hide</button>
        </div>
      ) : (
        <button type="button" className="btn btn-plain min-h-12 px-4 text-[14px] opacity-90" onClick={() => setOpen(true)}>Mock controls</button>
      )}
    </div>
  );
}
