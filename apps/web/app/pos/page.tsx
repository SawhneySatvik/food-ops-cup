"use client";
// /pos — counter (P1/P2), tender (P3, ?order=id) and receipt (P4, ?order=id&view=receipt) on one screen.
import { Card, StateDeny, StateEmpty, StateError, StateLoading, StateOffline } from "@munim/ui";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { t } from "../../lib/i18n/index.ts";
import { usePos } from "../../lib/pos/context.tsx";
import { useMenu } from "../../lib/pos/use-menu.ts";
import { Counter } from "./counter.tsx";
import { OrderPanel } from "./order-panel.tsx";

export default function PosPage() {
  return <Suspense fallback={<StateLoading rows={4} />}><PosRoute /></Suspense>;
}

function PosRoute() {
  const p = usePos();
  const params = useSearchParams();
  const orderId = params.get("order");
  const { menu, reload } = useMenu(p.initialOutletId);
  if (!p.initialOutletId || !p.counterChannelId) return <Card><StateEmpty message={t("pos.no_device")} /></Card>;
  if (menu.status === "load") return <StateLoading rows={5} />;
  if (menu.status === "deny") return <StateDeny />;
  if (menu.status === "off") return <StateOffline onRetry={reload} />;
  if (menu.status === "err") return <StateError onRetry={reload} />;
  const view = params.get("view") === "receipt" ? "receipt" : "tender";
  return orderId
    ? <OrderPanel orderId={orderId} view={view} entries={menu.entries} outletId={p.initialOutletId} />
    : <Counter entries={menu.entries} outletId={p.initialOutletId} />;
}
