"use client";
// Placeholder console home — T-064 replaces this file with the brief + inbox (console-home-inbox-ask.md).
import { Card } from "@munim/ui";
import { t } from "../../lib/i18n/index.ts";
import { useConsole } from "../../lib/console/context.tsx";

export default function ConsoleHome() {
  const c = useConsole();
  return (
    <Card data-placeholder="console-home">
      <h2>{t("chrome.nav.home")}</h2>
      <p>{c.tenant.name}</p>
    </Card>
  );
}
