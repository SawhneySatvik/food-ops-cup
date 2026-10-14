import { Suspense } from "react";
import { MenuPage } from "@/components/pages/menu";

export default function Page() {
  // The outlet id is only known at request time: the client reads it inside Suspense (Cache Components).
  return <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}><MenuPage /></Suspense>;
}
