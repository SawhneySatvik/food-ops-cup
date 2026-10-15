// file: app/staff/inbox/[draftId]/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { DraftDetailPage } from "@/components/staff/pages/draft-detail";

export const metadata: Metadata = { title: "A proposal" };

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><DraftDetailPage /></Suspense>;
}
