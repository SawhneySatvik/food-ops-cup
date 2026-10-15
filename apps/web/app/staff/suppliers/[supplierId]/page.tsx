import { Suspense } from "react";
import type { Metadata } from "next";
import { SupplierScreen } from "@/components/staff/pages/supplier";

export const metadata: Metadata = { title: "A supplier" };

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><SupplierScreen /></Suspense>;
}
