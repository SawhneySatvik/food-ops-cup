// /staff index redirect (02 §3, moved out of app/staff/page.tsx so the route file can opt out of instant validation).
"use client";
// /staff: send the signed-in person to the screen they start on (the picker's person's own, else by role).
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useStaff } from "./shell";

export function StaffIndex() {
  const { session } = useStaff();
  const router = useRouter();
  useEffect(() => {
    router.replace(session.home ?? (session.me.role === "staff" ? "/staff/counter" : "/staff/home"));
  }, [router, session]);
  return <div className="state-box" role="status">Opening…</div>;
}
