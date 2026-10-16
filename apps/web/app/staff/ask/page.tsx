// file: app/staff/ask/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { AskPage } from "@/components/staff/pages/ask";

export const metadata: Metadata = { title: "Ask Munim" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><AskPage /></Suspense>;
}
