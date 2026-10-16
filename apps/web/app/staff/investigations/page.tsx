// file: app/staff/investigations/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { InvestigationsPage } from "@/components/staff/pages/investigations";

export const metadata: Metadata = { title: "Investigations" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><InvestigationsPage /></Suspense>;
}
