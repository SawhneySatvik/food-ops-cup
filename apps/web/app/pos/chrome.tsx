"use client";
import { SyntheticBadge } from "@munim/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setScope, signOut } from "../../lib/actions.ts";
import { t } from "../../lib/i18n/index.ts";
import { usePos } from "../../lib/pos/context.tsx";

export function PosChrome() {
  const p = usePos();
  const router = useRouter();
  const [, start] = useTransition();
  return (
    <header className="pos-chrome">
      <Link href="/pos" className="pos-logo">{t("pos.title")}</Link>
      <span className="pos-business">{p.tenant.name}</span>
      {p.outlets.length > 0 && (
        <label>
          <span className="mu-visually-hidden">{t("pos.outlet.label")}</span>
          <select className="mu-input" value={p.initialOutletId ?? ""} onChange={(e) => { const v = e.target.value; start(async () => { await setScope(v); router.replace("/pos"); router.refresh(); }); }}>
            {p.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {p.tenant.isDemo && <SyntheticBadge />}
      <span className="pos-spacer" />
      <Link href="/console" className="mu-btn" data-variant="ghost">{t("pos.to_console")}</Link>
      <form action={signOut}><button type="submit" className="mu-btn" data-variant="ghost">{t("chrome.user.sign_out")}</button></form>
    </header>
  );
}
