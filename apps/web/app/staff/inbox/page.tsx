// file: app/staff/inbox/page.tsx
import { Suspense } from "react";
import type { Metadata } from "next";
import { InboxPage } from "@/components/staff/pages/inbox";

export const metadata: Metadata = { title: "Inbox" };

// Staff pages render only after the browser has read the session (see app/staff/layout.tsx).
export const instant = false;

export default function Page() {
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><InboxPage /></Suspense>;
}
