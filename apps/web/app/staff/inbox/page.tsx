// file: app/staff/inbox/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { InboxPage } from "@/components/staff/pages/inbox";

export const metadata: Metadata = { title: "Inbox" };

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><InboxPage /></Suspense>;
}
