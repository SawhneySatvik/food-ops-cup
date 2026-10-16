import { Suspense } from "react";
import { StaffIndex } from "@/components/staff/staff-index";

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><StaffIndex /></Suspense>;
}
