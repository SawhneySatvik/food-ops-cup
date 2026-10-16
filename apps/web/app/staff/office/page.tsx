// file: app/staff/office/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { OfficePage } from "@/components/staff/pages/office";

export const metadata: Metadata = { title: "The office" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><OfficePage /></Suspense>;
}
