// file: app/staff/ask/[threadId]/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { AskPage } from "@/components/staff/pages/ask";

export const metadata: Metadata = { title: "Ask Munim" };

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><AskPage /></Suspense>;
}
