import type { Schemas } from "@munim/sdk";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { coreUrl } from "../../../lib/core.ts";
import { t } from "../../../lib/i18n/index.ts";
import { OrderProvider } from "../../../lib/order/store.tsx";
import "../order.css";

export const dynamic = "force-dynamic";

// The key is a path segment; anything that could not be a key (or cannot ride in a header) is the same S-404 as a wrong one
// (gotcha 16). The first call is made here so a bad key is a real 404 status, not a client-side message.
const KEY_SHAPE = /^[A-Za-z0-9_.-]{8,200}$/;

export default async function StorefrontLayout({ children, params }: { children: ReactNode; params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!KEY_SHAPE.test(key)) notFound();
  let res: Response | null = null;
  try {
    res = await fetch(`${coreUrl()}/v1/storefront/outlets`, {
      headers: { "x-munim-storefront-key": key }, cache: "no-store", signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Core down or slow: the pages show S-err with a retry, not a crash.
  }
  if (res?.status === 404) notFound();
  const outlets = res?.ok ? ((await res.json()) as Schemas["StorefrontOutletsResponse"]) : null;
  return (
    <div className="sf">
      <p className="sf-sample">{t("order.banner.sample")}</p>
      <OrderProvider storeKey={key} outlets={outlets?.outlets ?? null} payMethods={outlets?.pay_at_counter_methods ?? null}>
        {children}
      </OrderProvider>
      <footer className="sf-foot"><p>{t("order.banner.sample")}</p><p>{t("order.banner.demo")}</p></footer>
    </div>
  );
}
