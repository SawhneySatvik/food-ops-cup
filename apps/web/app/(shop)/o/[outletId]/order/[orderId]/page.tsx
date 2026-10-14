import type { Metadata } from "next";
import { Suspense } from "react";
import { TrackerPage } from "@/components/pages/tracker";

export const metadata: Metadata = { title: "Your order" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><TrackerPage /></Suspense>;
}
