// file: components/staff/shell.tsx
"use client";
// The staff shell: top bar (wordmark, outlet switcher, the person, "Demo sign-in" badge, sign out), the tablet nav,
// and the context every staff screen reads with useStaff(). A missing session or any 401 sends the person to
// /staff/sign-in. Screens never read sessionStorage themselves.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { can, readOutlet, readSession, signOut, writeOutlet, type Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { staffFor } from "@/lib/munim/staff-app";
import { DEMO_SIGN_IN, ROLE_LABEL } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { Wordmark } from "../art";
import { MockPanel } from "../ui";

type Outlet = Schemas["V1Outlets"]["outlets"][number];

export interface Staff {
  session: Session;
  client: StaffClient;
  outlets: Outlet[];
  /** The outlet the switcher chose; every outlet-scoped screen uses it. */
  outlet: Outlet | null;
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

const NAV = [
  { href: "/staff/counter", label: "Counter", screen: "counter" },
  { href: "/staff/kitchen", label: "Kitchen", screen: "kitchen" },
  { href: "/staff/home", label: "Home", screen: "home" },
  { href: "/staff/inbox", label: "Inbox", screen: "inbox" },
  { href: "/staff/ask", label: "Ask Munim", screen: "ask" },
  { href: "/staff/cares", label: "Cares", screen: "cares" },
  { href: "/staff/suppliers", label: "Suppliers", screen: "suppliers" },
] as const;

export function StaffShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState<string | null>(null);
  const signIn = path === "/staff/sign-in";

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
    void client.listOutlets().then((r) => {
      if (!live) return;
      if (!r.ok) { handleAuth(r.error); return; }
      // GET /v1/outlets lists every outlet of the business; the person works in those GET /v1/me names.
      const mine = r.data.outlets.filter((o) => session!.me.outlet_ids === "*" || session!.me.outlet_ids.includes(o.id));
      setOutlets(mine);
      const saved = readOutlet();
      setOutletId(mine.some((o) => o.id === saved) ? saved : (mine[0]?.id ?? null));
    });
    return () => { live = false; };
  }, [client, handleAuth, session]);

  if (signIn) return <>{children}</>;
  if (!session || !client) return <div className="state-box" role="status">Signing you in…</div>;

  const outlet = outlets.find((o) => o.id === outletId) ?? null;
  const setOutlet = (id: string) => { writeOutlet(id); setOutletId(id); };
  const value: Staff = { session, client, outlets, outlet, setOutlet, handleAuth };

  return (
    <StaffContext.Provider value={value}>
      <header className="staff-bar">
        <div className="staff-bar-row">
          <Link href="/staff" className="text-ink no-underline" aria-label="Cobnut Bakehouse staff, home"><Wordmark /></Link>
          <span className="badge">Staff</span>
          {outlets.length > 1 ? (
            <label className="flex items-center gap-2 font-semibold">
              Outlet
              <select className="w-auto" value={outletId ?? ""} onChange={(e) => setOutlet(e.target.value)}>
                {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          ) : outlet ? <span className="font-semibold">{outlet.name}</span> : null}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <span className="font-semibold">{session.me.name}</span>
            <span className="text-muted">· {ROLE_LABEL[session.me.role]}</span>
            {session.demo && <span className="sim-badge">{DEMO_SIGN_IN}</span>}
            <button type="button" className="btn btn-plain" onClick={() => { signOut(); router.replace("/staff/sign-in"); }}>Sign out</button>
          </span>
        </div>
        <nav aria-label="Staff" className="staff-nav">
          {NAV.filter((n) => can(session, n.screen)).map((n) => (
            <Link key={n.href} href={n.href} className="chip" aria-current={path.startsWith(n.href) ? "page" : undefined}>{n.label}</Link>
          ))}
        </nav>
      </header>
      {children}
      <MockPanel staff />
    </StaffContext.Provider>
  );
}
