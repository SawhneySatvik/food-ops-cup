// file: components/staff/sign-in.tsx
"use client";
// /staff/sign-in. On the mock: the "Demo sign-in" picker with the three invented people. Against the real API the
// picker is never shown; the IdP sign-in replaces it when the founder sends the details (00 §3).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { API_BASE, IS_MOCK } from "@/lib/munim";
import { DEMO_PEOPLE, signInDemo, type DemoPerson } from "@/lib/munim/session";
import { staffErrorText } from "@/lib/munim/staff-copy";
import { ErrorNote } from "../ui";

export function StaffSignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (p: DemoPerson) => {
    setBusy(p.key);
    setError(null);
    const r = await signInDemo(API_BASE, p);
    setBusy(null);
    if (r.ok) router.replace(p.home);
    else setError(staffErrorText(r.error, "sign-in"));
  };
  return (
    <main className="wrap py-10">
      <h1 className="section-title">Staff sign-in</h1>
      {IS_MOCK ? (
        <>
          <p className="mt-4 max-w-[60ch]">
            <span className="sim-badge">Demo sign-in</span> Choose who you are for this demo. These people are invented; anyone can sign in as them.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {DEMO_PEOPLE.map((p) => (
              <button key={p.key} type="button" className="card card-link grid gap-2 p-6 text-left" disabled={busy !== null} onClick={() => void go(p)}>
                <span className="display text-[24px]">{p.name}</span>
                <span className="text-muted">{p.blurb}</span>
                <span className="btn btn-primary mt-2">{busy === p.key ? "Signing in…" : `Sign in as ${p.name}`}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-4">Sign-in with your work account is coming soon.</p>
      )}
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
    </main>
  );
}
