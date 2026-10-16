// file: components/staff/shell.tsx
"use client";
// The staff shell: top bar (wordmark, "Sample data" for a demo business, outlet switcher, the person, "Demo sign-in"
// badge, sign out), the tablet nav,
// and the context every staff screen reads with useStaff(). A missing session or any 401 sends the person to
// /staff/sign-in. Screens never read sessionStorage themselves.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MunimError } from "@/lib/munim/client";
import { SAMPLE_DATA } from "@/lib/munim/copy";
import { can, readOutlet, readSession, signOut, writeOutlet, type Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { staffFor } from "@/lib/munim/staff-app";
import { DEMO_SIGN_IN, ROLE_LABEL, staffErrorText } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { Wordmark } from "../art";
import { ErrorNote, MockPanel } from "../ui";

type Outlet = Schemas["V1Outlets"]["outlets"][number];

export interface Staff {
  session: Session;
  client: StaffClient;
  outlets: Outlet[];
  /** The outlet the switcher chose; every outlet-scoped screen uses it. Null only while `outletsState` is "loading":
   *  the shell itself shows the "failed" and no-outlet states instead of the screen. */
  outlet: Outlet | null;
  outletsState: "loading" | "ready" | "failed";
  /** Loads the outlets again (the shell's "Try again"). */
  retryOutlets: () => void;
  setOutlet: (id: string) => void;
  /** Call with any failed result: a 401 signs the person out; returns true when it handled the error. */
  handleAuth: (e: MunimError) => boolean;
}

const StaffContext = createContext<Staff | null>(null);
export const useStaff = (): Staff => {
  const s = useContext(StaffContext);
  if (!s) throw new Error("useStaff outside StaffShell");
  return s;
};

/** `also`: other routes that belong under the tab (a purchase order is reached from Suppliers). */
const NAV: readonly { href: string; label: string; screen: string; also?: string }[] = [
  { href: "/staff/counter", label: "Counter", screen: "counter" },
  { href: "/staff/kitchen", label: "Kitchen", screen: "kitchen" },
  { href: "/staff/home", label: "Home", screen: "home" },
  { href: "/staff/inbox", label: "Inbox", screen: "inbox" },
  { href: "/staff/ask", label: "Ask Munim", screen: "ask" },
  { href: "/staff/office", label: "The office", screen: "office" },
  { href: "/staff/investigations", label: "Investigations", screen: "investigations" },
  { href: "/staff/cares", label: "Cares", screen: "cares" },
  { href: "/staff/suppliers", label: "Suppliers", screen: "suppliers", also: "/staff/purchase-orders" },
  { href: "/staff/campaigns", label: "Campaigns", screen: "campaigns" },
  { href: "/staff/storefront", label: "Storefront", screen: "storefront" },
];

// "sm" and up, as Tailwind's: the bar keeps everything in one row there; on a phone the outlet and the labels move under it.
const WIDE = "(min-width: 640px)";
const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);

export function StaffShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState<string | null>(null);
  const [outletsState, setOutletsState] = useState<"loading" | "ready" | "failed">("loading");
  const [outletsError, setOutletsError] = useState<MunimError | null>(null);
  const [outletsTry, setOutletsTry] = useState(0);
  // GET /v1/tenant's is_demo; a failed read shows the badge (saying "sample" wrongly is the safe mistake).
  const [demoData, setDemoData] = useState(true);
  const signIn = path === "/staff/sign-in";
  const wide = useWide();
  const navRef = useRef<HTMLElement>(null);

  // Whatever sticks under the bar (the offline banner, the till's cart) needs its real height, and the bar wraps on tablets.
  const barRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty("--staff-bar-h", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty("--staff-bar-h"); };
  }, []);

  // On a phone the tabs scroll: bring the current one into view, or Suppliers sits off-screen.
  useEffect(() => {
    const nav = navRef.current;
    const here = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && here) nav.scrollLeft = here.offsetLeft - (nav.clientWidth - here.offsetWidth) / 2;
  }, [path, session, wide]);

  useEffect(() => {
    const s = readSession();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after hydration
    setSession(s);
    if (!s && !signIn) router.replace("/staff/sign-in");
  }, [router, signIn]);

  const client = useMemo(() => (session ? staffFor(session) : null), [session]);
  const handleAuth = useCallback((e: MunimError) => {
    if (e.status !== 401) return false;
    signOut();
    router.replace("/staff/sign-in");
    return true;
  }, [router]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new attempt starts in "loading"
    setOutletsState("loading");
    void client.listOutlets().then((r) => {
      if (!live) return;
      if (!r.ok) {
        if (handleAuth(r.error)) return;
        setOutletsError(r.error);
        setOutletsState("failed");
        return;
      }
      // GET /v1/outlets lists every outlet of the business; the person works in those GET /v1/me names.
      const mine = r.data.outlets.filter((o) => session!.me.outlet_ids === "*" || session!.me.outlet_ids.includes(o.id));
      setOutlets(mine);
      const saved = readOutlet();
      setOutletId(mine.some((o) => o.id === saved) ? saved : (mine[0]?.id ?? null));
      setOutletsState("ready");
    });
    return () => { live = false; };
  }, [client, handleAuth, session, outletsTry]);

  useEffect(() => {
    if (!client) return;
    void client.getTenant().then((r) => setDemoData(r.ok ? r.data.is_demo : true));
  }, [client]);

  if (signIn) return <>{children}</>;
  if (!session || !client) return <div className="state-box" role="status">Signing you in…</div>;

  const outlet = outlets.find((o) => o.id === outletId) ?? null;
  const setOutlet = (id: string) => { writeOutlet(id); setOutletId(id); };
  const retryOutlets = () => setOutletsTry((n) => n + 1);
  const value: Staff = { session, client, outlets, outlet, setOutlet, outletsState, retryOutlets, handleAuth };
  // Every screen needs an outlet: a failed load or a person with none is shown here, once, instead of the screen.
  const body = outletsState === "failed" ? (
    <main className="wrap staff-main space-y-3">
      <ErrorNote>{outletsError ? staffErrorText(outletsError, "home") : "Your outlets couldn't load."}</ErrorNote>
      <button type="button" className="btn btn-plain" onClick={retryOutlets}>Try again</button>
    </main>
  ) : outletsState === "ready" && outlets.length === 0 ? (
    <main className="wrap staff-main"><div className="state-box"><p>You aren&apos;t set up at any outlet yet. Ask the owner.</p></div></main>
  ) : children;

  const outletPick = outlets.length > 1 ? (
    <label className="flex items-center gap-2 font-semibold">
      Outlet
      <select className="min-w-0 flex-1 sm:w-auto sm:flex-none" value={outletId ?? ""} onChange={(e) => setOutlet(e.target.value)}>
        {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  ) : outlet ? <span className="font-semibold">{outlet.name}</span> : null;
  const sample = demoData && <span className="badge badge-sim">{SAMPLE_DATA}</span>;
  const demoSignIn = session.demo && <span className="badge badge-sim">{DEMO_SIGN_IN}</span>;

  return (
    <StaffContext.Provider value={value}>
      <header ref={barRef} className="staff-bar">
        <div className="staff-bar-row">
          <Link href="/staff" className="inline-flex min-h-12 items-center text-ink no-underline" aria-label="Cobnut Bakehouse staff, home"><Wordmark compact /></Link>
          {wide && <span className="badge">Staff</span>}
          {wide && outletPick}
          {wide && sample}
          <span className="ml-auto flex items-center gap-2">
            {/* The named person every action is taken as: shortened to the first name on phones, never hidden. */}
            <span className="font-semibold md:hidden">{session.me.name.split(" ")[0]}</span>
            <span className="hidden font-semibold md:inline">{session.me.name}</span>
            <span className="hidden text-muted md:inline">· {ROLE_LABEL[session.me.role]}</span>
            {wide && demoSignIn}
            <button type="button" className="btn btn-plain px-4 sm:px-[22px]" onClick={() => { signOut(); router.replace("/staff/sign-in"); }}
              aria-label={`Sign out ${session.me.name}`}>Sign out</button>
          </span>
        </div>
        <nav ref={navRef} aria-label="Staff" className="staff-nav">
          {NAV.filter((n) => can(session, n.screen)).map((n) => (
            <Link key={n.href} href={n.href} className="chip" aria-current={[n.href, n.also].some((h) => h && path.startsWith(h)) ? "page" : undefined}>{n.label}</Link>
          ))}
        </nav>
      </header>
      {!wide && (
        <div className="staff-context">
          {outletPick && <div className="w-full">{outletPick}</div>}
          {sample}
          {demoSignIn}
        </div>
      )}
      {body}
      <MockPanel staff />
    </StaffContext.Provider>
  );
}
