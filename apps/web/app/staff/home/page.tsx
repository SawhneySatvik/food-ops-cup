// file: app/staff/home/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { OwnerHomePage } from "@/components/staff/pages/owner-home";

export const metadata: Metadata = { title: "Owner home" };

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><OwnerHomePage /></Suspense>;
}
