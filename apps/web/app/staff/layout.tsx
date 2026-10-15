// file: app/staff/layout.tsx
// Every /staff route: the staff stylesheet and the shell. The root layout above it still renders the demo bar.
import { Suspense } from "react";
import { StaffShell } from "@/components/staff/shell";
import "./staff.css";

// The shell renders a page only once the browser has read the person's session (sessionStorage), so the server can
// never render a staff page ahead of a navigation. Opt the staff segments out of Next's instant-navigation check.
export const instant = false;

export default function StaffLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The shell reads the pathname, which on a dynamic route is only known at request time: keep it inside Suspense.
  return (
    <Suspense fallback={<div className="min-h-[100dvh]" aria-busy="true" />}>
      <StaffShell>{children}</StaffShell>
    </Suspense>
  );
}
