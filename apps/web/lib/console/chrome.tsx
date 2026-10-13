"use client";
// Console chrome (screens/00-README.md §2, cut to the demo spine): logo, business, scope switch, demo badge, live pill,
// Inbox badge, Ask, user menu; nav Home · Cares. Ask is removed — not errored — when AI is off (S-aioff).
import { AiGate, Badge, IconAsk, IconChevronDown, IconInbox, LivePill, SyntheticBadge, createFormatter } from "@munim/ui";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { setScope, setTheme, signOut } from "../actions.ts";
import { t } from "../i18n/index.ts";
import { useConsole } from "./context.tsx";

const NAV = [
  { href: "/console", key: "chrome.nav.home", exact: true },
  { href: "/console/cares", key: "chrome.nav.cares", exact: false },
] as const;

export function ConsoleChrome() {
  const c = useConsole();
  const path = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const fmt = createFormatter(c.format);
  // R40 C3: the badge is the length of the list held; a capped list says "N+".
  const inboxCount = c.inbox ? `${fmt.number(c.inbox.items.length)}${c.inbox.nextCursor ? "+" : ""}` : null;

  return (
    <header className="console-chrome">
      <div className="console-bar">
        <Link href="/console" className="console-logo">{t("chrome.logo")}</Link>
        <span className="console-business">{c.tenant.name}</span>
        <label className="console-scope">
          <span className="mu-visually-hidden">{t("chrome.scope.label")}</span>
          <select className="mu-input" value={c.outletId ?? "all"}
            onChange={(e) => { const v = e.target.value; startTransition(async () => { await setScope(v); router.refresh(); }); }}>
            <option value="all">{t("chrome.scope.all")}</option>
            {c.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        {c.tenant.isDemo && <SyntheticBadge />}
        <span className="console-spacer" />
        {c.live !== null && <LivePill state={c.live} />}
        {inboxCount !== null && (
          <Link href="/console/inbox" className="mu-btn" data-variant="ghost" data-size="sm" aria-label={t("chrome.inbox.count", { count: inboxCount })}>
            <IconInbox size={18} />{t("chrome.inbox")}<Badge tone="accent">{inboxCount}</Badge>
          </Link>
        )}
        <AiGate enabled={c.aiEnabled}>
          <Link href="/console/ask" className="mu-btn" data-variant="secondary" data-size="sm"><IconAsk size={18} />{t("chrome.ask")}</Link>
        </AiGate>
        <details className="console-user">
          <summary className="mu-btn" data-variant="ghost" data-size="sm" aria-label={t("chrome.user.menu")}>
            {c.member.name}<IconChevronDown size={16} />
          </summary>
          <div className="console-menu mu-card">
            <p className="console-menu-role">{t(`chrome.role.${c.member.role}`)}</p>
            <fieldset className="console-theme">
              <legend>{t("chrome.theme.label")}</legend>
              {(["light", "dark", "system"] as const).map((v) => (
                <button key={v} type="button" className="mu-btn" data-variant="secondary" data-size="sm"
                  onClick={() => startTransition(async () => { await setTheme(v); router.refresh(); })}>{t(`chrome.theme.${v}`)}</button>
              ))}
            </fieldset>
            <form action={signOut}><button type="submit" className="mu-btn" data-variant="ghost" data-size="sm">{t("chrome.user.sign_out")}</button></form>
          </div>
        </details>
      </div>
      <nav className="console-nav" aria-label={t("chrome.nav.label")}>
        {NAV.map((n) => {
          const active = n.exact ? path === n.href : path.startsWith(n.href);
          return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}>{t(n.key)}</Link>;
        })}
      </nav>
    </header>
  );
}
