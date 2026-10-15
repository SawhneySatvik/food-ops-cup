// file: app/staff/kitchen/page.tsx
import { Suspense } from "react";
import { KitchenPage } from "@/components/staff/pages/kitchen";

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="state-box" aria-busy="true" />}><KitchenPage /></Suspense>;
}
