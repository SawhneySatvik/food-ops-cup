"use client";
// C1 · Console home (screens/console-home-inbox-ask.md): the morning brief and the inbox. The "Today" strip is left out:
// no pack owns sales / order-count templates (gap G-CON-2), and this screen computes no aggregate of its own.
import { createFormatter } from "@munim/ui";
import "../../lib/console-home/console-home.css";
import { BriefPanel, InboxPanel, ReadOnlyBanner } from "../../lib/console-home/inbox.tsx";
import { useConsole } from "../../lib/console/context.tsx";
import { t } from "../../lib/i18n/index.ts";

export default function ConsoleHome() {
  const c = useConsole();
  const fmt = createFormatter(c.format);
  return (
    <div className="ch-page" data-page="console-home">
      <header className="ch-page-head">
        <h1>{t("console.home.greeting", { name: c.member.name })}</h1>
        <p className="ch-meta" suppressHydrationWarning>{fmt.date(new Date())}</p>
      </header>
      {c.member.role === "advisor" && <ReadOnlyBanner />}
      <BriefPanel />
      <InboxPanel />
    </div>
  );
}
