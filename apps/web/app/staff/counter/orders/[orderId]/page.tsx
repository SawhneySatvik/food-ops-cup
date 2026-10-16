// file: app/staff/counter/orders/[orderId]/page.tsx
import { Suspense } from "react";
import { CounterOrderPage } from "@/components/staff/pages/counter-order";

export default function Page() {
  // The order id is only known at request time: the client reads it inside Suspense (as the storefront's tracker does).
  return <Suspense fallback={<div className="state-box" aria-busy="true" />}><CounterOrderPage /></Suspense>;
}
