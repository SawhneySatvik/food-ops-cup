// /staff index redirect (02 §3, moved out of app/staff/page.tsx so the route file can opt out of instant validation).
"use client";
// /staff: send the signed-in person to the screen their role starts on.
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useStaff } from "./shell";
import { DEMO_PEOPLE } from "@/lib/munim/session";

export function StaffIndex() {
  const { session } = useStaff();
  const router = useRouter();
  useEffect(() => {
    const demo = DEMO_PEOPLE.find((p) => p.token === session.token);
    router.replace(demo ? demo.home : session.me.role === "staff" ? "/staff/counter" : "/staff/home");
  }, [router, session]);
  return <div className="state-box" role="status">Opening…</div>;
}
