"use client";
// /console/inbox — the list the chrome's Inbox badge counts (R40 C3: same list, same length).
import "../../../lib/console-home/console-home.css";
import { InboxPanel, ReadOnlyBanner } from "../../../lib/console-home/inbox.tsx";
import { useConsole } from "../../../lib/console/context.tsx";

export default function InboxPage() {
  const c = useConsole();
  return (
    <div className="ch-page" data-page="console-inbox">
      {c.member.role === "advisor" && <ReadOnlyBanner />}
      <InboxPanel />
    </div>
  );
}
