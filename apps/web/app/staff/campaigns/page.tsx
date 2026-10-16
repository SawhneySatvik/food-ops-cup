// file: app/staff/campaigns/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { CampaignsPage } from "@/components/staff/pages/campaigns";

export const metadata: Metadata = { title: "Campaigns" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><CampaignsPage /></Suspense>;
}
