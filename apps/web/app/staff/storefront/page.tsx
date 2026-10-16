// file: app/staff/storefront/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { StorefrontBuilderPage } from "@/components/staff/pages/storefront-builder";

export const metadata: Metadata = { title: "Storefront" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><StorefrontBuilderPage /></Suspense>;
}
