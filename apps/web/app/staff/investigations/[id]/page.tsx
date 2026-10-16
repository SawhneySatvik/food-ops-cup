// file: app/staff/investigations/[id]/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { InvestigationPage } from "@/components/staff/pages/investigation";

export const metadata: Metadata = { title: "An investigation" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><InvestigationPage /></Suspense>;
}
