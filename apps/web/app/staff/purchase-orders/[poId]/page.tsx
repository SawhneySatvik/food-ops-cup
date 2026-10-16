import { Suspense } from "react";
import type { Metadata } from "next";
import { PurchaseOrderScreen } from "@/components/staff/pages/purchase-order";

export const metadata: Metadata = { title: "A purchase order" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><PurchaseOrderScreen /></Suspense>;
}
