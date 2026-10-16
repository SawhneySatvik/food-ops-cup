import { Suspense } from "react";
import type { Metadata } from "next";
import { CaresScreen } from "@/components/staff/pages/cares";

export const metadata: Metadata = { title: "Munim Cares" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><CaresScreen /></Suspense>;
}
