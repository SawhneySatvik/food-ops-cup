"use client";
// /console/ask — C3. Owners, managers, advisors and judges ask; staff do not see Ask (screens C3 S-deny).
import "../../../lib/console-home/console-home.css";
import { AskView } from "../../../lib/console-home/ask.tsx";
import { useConsole } from "../../../lib/console/context.tsx";
import { t } from "../../../lib/i18n/index.ts";

export default function AskPage() {
  const c = useConsole();
  return (
    <div className="ch-page" data-page="console-ask">
      <header className="ch-page-head"><h1>{t("console.ask.title")}</h1></header>
      {c.member.role === "staff" ? null : <AskView />}
    </div>
  );
}
