// file: app/staff/office/[desk]/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { DeskPage } from "@/components/staff/pages/desk";

export const metadata: Metadata = { title: "A desk" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><DeskPage /></Suspense>;
}
