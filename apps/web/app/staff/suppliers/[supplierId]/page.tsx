import { Suspense } from "react";
import { SupplierScreen } from "@/components/staff/pages/suppliers";

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><SupplierScreen /></Suspense>;
}
