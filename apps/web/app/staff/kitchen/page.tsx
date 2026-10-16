// file: app/staff/kitchen/page.tsx
import { Suspense } from "react";
import { KitchenPage } from "@/components/staff/pages/kitchen";

export default function Page() {
  return <Suspense fallback={<div className="state-box" aria-busy="true" />}><KitchenPage /></Suspense>;
}
