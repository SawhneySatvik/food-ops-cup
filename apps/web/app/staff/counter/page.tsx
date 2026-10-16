// file: app/staff/counter/page.tsx
import { Suspense } from "react";
import { CounterPage } from "@/components/staff/pages/counter";

export default function Page() {
  return <Suspense fallback={<div className="state-box" aria-busy="true" />}><CounterPage /></Suspense>;
}
