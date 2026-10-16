// file: app/staff/home/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { OwnerHomePage } from "@/components/staff/pages/owner-home";

export const metadata: Metadata = { title: "Owner home" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><OwnerHomePage /></Suspense>;
}
