// file: components/staff/sign-in.tsx
"use client";
// /staff/sign-in. On the mock: the "Demo sign-in" picker with the three invented people. Against the real API the
// picker is never shown; the IdP sign-in replaces it when the founder sends the details (00 §3).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { API_BASE, IS_MOCK } from "@/lib/munim";
import { DEMO_PEOPLE, signInDemo, type DemoPerson } from "@/lib/munim/session";
import { staffErrorText } from "@/lib/munim/staff-copy";
import { Wordmark } from "../art";
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
    <main className="wrap max-w-[1040px] py-10 sm:py-14">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-ink no-underline" aria-label="Cobnut Bakehouse, the shop"><Wordmark /></Link>
        <Link href="/" className="btn btn-ghost">Back to the shop</Link>
      </div>
      <h1 className="section-title mt-10">Staff sign-in</h1>
      {IS_MOCK ? (
        <>
          <p className="mt-4 flex max-w-[62ch] flex-wrap items-center gap-x-2 gap-y-1 text-muted">
            <span className="sim-badge">Demo sign-in</span> Choose who you are for this demo. These people are invented; anyone can sign in as them.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {DEMO_PEOPLE.map((p) => (
              <button key={p.key} type="button" className="card card-link flex flex-col items-start gap-1 p-6 text-left" disabled={busy !== null} onClick={() => void go(p)}
                aria-label={`Sign in as ${p.name}`}>
                <span aria-hidden="true" className="mb-3 grid size-12 place-items-center rounded-full bg-accent text-[18px] font-bold text-on-accent">
                  {p.name.split(" ").slice(0, 2).map((w) => w[0]).join("")}
                </span>
                <span className="display text-[23px] leading-tight">{p.name}</span>
                <span className="mb-5 text-muted">{p.blurb}</span>
                <span className="btn btn-primary mt-auto w-full">{busy === p.key ? "Signing in…" : "Sign in"}</span>
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
