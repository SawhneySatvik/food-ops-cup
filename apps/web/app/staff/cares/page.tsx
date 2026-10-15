import { Suspense } from "react";
import type { Metadata } from "next";
import { CaresScreen } from "@/components/staff/pages/cares";

export const metadata: Metadata = { title: "Munim Cares" };

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><CaresScreen /></Suspense>;
}
