// file: app/staff/counter/page.tsx
import { Suspense } from "react";
import { CounterPage } from "@/components/staff/pages/counter";

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="state-box" aria-busy="true" />}><CounterPage /></Suspense>;
}
