// file: app/staff/layout.tsx
// Every /staff route: the demo bar in the staff screens' words, the staff stylesheet and the shell.
import { Suspense } from "react";
import { DemoBar } from "@/components/chrome";
import { StaffShell } from "@/components/staff/shell";
import "./staff.css";

export default function StaffLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The shell reads the pathname, which on a dynamic route is only known at request time: keep it inside Suspense.
  return (
    <>
      <DemoBar staff />
      <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}>
        <StaffShell>{children}</StaffShell>
      </Suspense>
    </>
  );
}
