// file: components/staff/sign-in.tsx
"use client";
// /staff/sign-in: the "Demo sign-in" picker with the four invented people. On the mock each signs in with a public
// mock token; against the real API this app's server signs them in (session.ts signInDemoServer).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { API_BASE, IS_MOCK } from "@/lib/munim";
import { DEMO_PEOPLE, signInDemo, signInDemoServer, type DemoPerson } from "@/lib/munim/session";
import { DEMO_SIGN_IN_OFF, staffErrorText } from "@/lib/munim/staff-copy";
import { Wordmark } from "../art";
import { ErrorNote } from "../ui";

export function StaffSignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (p: DemoPerson) => {
    setBusy(p.key);
    setError(null);
    const r = await (IS_MOCK ? signInDemo : signInDemoServer)(API_BASE, p);
    setBusy(null);
    if (r.ok) router.replace(p.home);
    else setError(!IS_MOCK && r.error.kind === "not_found" ? DEMO_SIGN_IN_OFF : staffErrorText(r.error, "sign-in"));
  };
  return (
    <main className="wrap staff-main py-10 sm:py-14">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="inline-flex min-h-12 items-center text-ink no-underline" aria-label="Cobnut Bakehouse, the shop"><Wordmark /></Link>
        <Link href="/" className="btn btn-ghost">Back to the shop</Link>
      </div>
      <h1 className="section-title mt-10">Staff sign-in</h1>
      <p className="mt-4 flex max-w-[62ch] flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <span className="badge badge-sim">Demo sign-in</span> Choose who you are for this demo. These people are invented; anyone can sign in as them.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
    </main>
  );
}
