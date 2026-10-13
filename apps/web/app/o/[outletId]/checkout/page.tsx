import type { Metadata } from "next";
import { Suspense } from "react";
import { CheckoutPage } from "@/components/pages/checkout";

export const metadata: Metadata = { title: "Checkout" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[60dvh]" aria-busy="true" />}><CheckoutPage /></Suspense>;
}
