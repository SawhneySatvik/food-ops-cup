"use client";
// P1 Counter sale. Totals come only from POST /v1/orders:preview (G-POS-1); the cart never adds a price itself.
import { Badge, Button, Card, Input, StateDeny, StateError, StateOffline, StateEmpty, Skeleton, createFormatter } from "@munim/ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { t } from "../../lib/i18n/index.ts";
import { formatSpec, usePos } from "../../lib/pos/context.tsx";
import {
  addToCart, classify, createIntents, entryKey, entryName, groupByCategory, placePayload, previewBody, refuseKey, settle, stepQty, titleCase,
  type CartLine, type MenuEntry, type OrderKind, type Outcome, type Preview,
} from "../../lib/pos/logic.ts";
import { OptionsSheet } from "./options-sheet.tsx";

type PreviewState = { status: "idle" | "load" | "err" | "off" } | { status: "ok"; data: Preview; key: string };

export function Counter({ entries, outletId }: { entries: MenuEntry[]; outletId: string }) {
  const pos = usePos();
  const router = useRouter();
  const fmt = createFormatter(formatSpec(pos, outletId));
  const outlet = pos.outlets.find((o) => o.id === outletId)!;
  const channelId = pos.counterChannelId!;

  const [cart, setCart] = useState<CartLine[]>([]);
  const [kind, setKind] = useState<OrderKind>("takeaway");
  const [table, setTable] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [picking, setPicking] = useState<MenuEntry | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [reprice, setReprice] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const intents = useRef(createIntents());

  const groups = useMemo(() => groupByCategory(entries, query), [entries, query]);
  const shown = category ? groups.filter((g) => g.category === category) : groups;

  const where = { outletId, channelId, kind };
  const bodyKey = JSON.stringify(cart.length ? previewBody(cart, where) : null);
  useEffect(() => {
    if (!cart.length) { setPreview({ status: "idle" }); return; }
    let live = true;
    setPreview({ status: "load" });
    const timer = setTimeout(() => {
      void settle(() => api.POST("/v1/orders:preview", { body: previewBody(cart, where) })).then((r) => {
        if (!live) return;
        const res = r as { data?: Preview };
        const gone = !(r as { response?: Response }).response;
        setPreview(res.data ? { status: "ok", data: res.data, key: bodyKey } : { status: gone ? "off" : "err" });
      });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bodyKey is the cart + where, serialised
  }, [bodyKey, reprice]);

  const add = (e: MenuEntry, optionIds: string[]) => { setCart((c) => addToCart(c, e, optionIds)); setOutcome(null); };
  const tap = (e: MenuEntry) => (e.option_groups.length ? setPicking(e) : add(e, []));

  // A preview answers for the cart it priced: one for an older cart is never shown or sent.
  const previewOk = preview.status === "ok" && preview.key === bodyKey ? preview.data : null;
  const refused = previewOk?.refusals ?? [];
  // Core zeroes every total when it refuses a line, so a refused preview shows the refusal and no amounts.
  const priced = previewOk && refused.length === 0 ? previewOk : null;
  const canCharge = !!previewOk && refused.length === 0 && !busy;

  const charge = async () => {
    if (!previewOk) return;
    setBusy(true);
    // The envelope is keyed by what the person is charging: the same cart + the same previewed total is the same intent,
    // so Retry after "No connection" resends the same ids and core answers with the original result.
    const sig = JSON.stringify([cart.map((l) => [l.lineId, l.qtyMilli, l.optionIds]), kind, table, previewOk.total_minor]);
    const intent = intents.current.get(sig);
    const res = await settle(() => api.POST("/v1/orders", {
      body: { command_id: intent.command_id, idempotency_key: intent.idempotency_key, type: "orders.place.v1",
        payload: placePayload(cart, { ...where, orderId: intent.entity_id, deviceId: outlet.deviceId, table, previewTotalMinor: previewOk.total_minor }) },
    }));
    const o = classify(res);
    setBusy(false);
    if (o.kind === "ok") {
      intents.current.clear();
      router.push(`/pos?order=${intent.entity_id}`);
      return;
    }
    if (o.kind === "refused") { intents.current.clear(); if (o.reason === "preview_total_changed") setReprice((n) => n + 1); }
    setOutcome(o);
  };

  if (entries.length === 0) return <Card><StateEmpty message={t("pos.empty_menu")} /></Card>;

  return (
    <div className="pos-counter">
      <section className="pos-menu" aria-labelledby="pos-h">
        <h1 id="pos-h">{t("pos.p1.heading")}</h1>
        <div className="pos-tools">
          <div role="group" aria-label={t("pos.kind.label")} className="pos-seg">
            {(["takeaway", "dine_in"] as const).map((k) => (
              <Button key={k} variant={kind === k ? "primary" : "secondary"} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`pos.kind.${k}`)}</Button>
            ))}
          </div>
          {kind === "dine_in" && <Input id="pos-table" label={t("pos.table")} value={table} maxLength={20} onChange={(e) => setTable(e.target.value)} />}
          <Input id="pos-search" type="search" label={t("pos.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div role="group" aria-label={t("pos.categories")} className="pos-seg">
          <Button variant={category === null ? "primary" : "secondary"} aria-pressed={category === null} onClick={() => setCategory(null)}>{t("pos.all")}</Button>
          {groups.map((g) => (
            <Button key={g.category} variant={category === g.category ? "primary" : "secondary"} aria-pressed={category === g.category} onClick={() => setCategory(g.category)}>{titleCase(g.category)}</Button>
          ))}
        </div>
        <div className="pos-grid">
          {shown.flatMap((g) => g.entries).map((e) => (
            <button key={entryKey(e)} type="button" className="pos-tile" data-testid="pos-tile" disabled={!e.available} onClick={() => tap(e)}>
              <span className="pos-tile-name">{entryName(e)}</span>
              {e.available ? <span className="pos-tile-price">{fmt.money(e.price_minor, e.currency)}</span> : <Badge tone="warning">{t("pos.sold_out")}</Badge>}
            </button>
          ))}
        </div>
      </section>

      <Card className="pos-cart" aria-labelledby="pos-cart-h">
        <h2 id="pos-cart-h">{t("pos.cart.new")}</h2>
        {cart.length === 0 ? <p className="pos-muted">{t("pos.cart.empty")}</p> : (
          <ul className="pos-lines">
            {cart.map((l, i) => {
              const linePriced = priced?.lines[i];
              const name = entryName(l.entry);
              return (
                <li key={l.lineId} data-testid="pos-line">
                  <div className="pos-line-main">
                    <strong>{fmt.qtyMilli(l.qtyMilli)} × {name}</strong>
                    {l.optionIds.map((id) => {
                      const o = l.entry.option_groups.flatMap((g) => g.options).find((x) => x.option_id === id);
                      return o ? <span key={id} className="pos-muted">+ {o.display_name ?? o.name_key} {fmt.money(o.price_delta_minor, o.currency)}</span> : null;
                    })}
                  </div>
                  <span className="pos-amount">{linePriced && priced ? fmt.money(linePriced.line_total_minor, priced.currency) : "—"}</span>
                  <div className="pos-step">
                    <Button aria-label={t("pos.cart.dec", { name })} onClick={() => setCart((c) => stepQty(c, l.lineId, -1))}>–</Button>
                    <Button aria-label={t("pos.cart.inc", { name })} onClick={() => setCart((c) => stepQty(c, l.lineId, 1))}>+</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {cart.length > 0 && !previewOk && preview.status !== "err" && preview.status !== "off" && <Skeleton rows={2} />}
        {priced && (
          <dl className="pos-totals" data-testid="pos-preview">
            <Badge tone="info">{t("pos.preview.label")}</Badge>
            <div><dt>{t("pos.preview.subtotal")}</dt><dd data-k="subtotal">{fmt.money(priced.subtotal_minor, priced.currency)}</dd></div>
            {priced.discount_minor > 0 && <div><dt>{t("pos.preview.discount")}</dt><dd>{fmt.money(priced.discount_minor, priced.currency)}</dd></div>}
            <div><dt>{t("pos.preview.tax")}</dt><dd data-k="tax">{fmt.money(priced.tax_minor, priced.currency)}</dd></div>
            <div className="pos-grand"><dt>{t("pos.preview.total")}</dt><dd data-k="total">{fmt.money(priced.total_minor, priced.currency)}</dd></div>
            <p className="pos-muted">{t("pos.preview.note")}</p>
          </dl>
        )}
        {preview.status === "err" && <StateError onRetry={() => setReprice((n) => n + 1)} />}
        {preview.status === "off" && <StateOffline onRetry={() => setReprice((n) => n + 1)} />}
        {refused.map((r) => <p key={`${r.line_no}-${r.reason_code}`} role="alert" className="pos-refusal">{t(refuseKey(r.reason_code))}</p>)}

        {outcome?.kind === "off" && <StateOffline onRetry={() => void charge()} />}
        {outcome?.kind === "deny" && <StateDeny />}
        {outcome?.kind === "err" && <StateError onRetry={() => void charge()} />}
        {outcome?.kind === "refused" && <p role="alert" className="pos-refusal" data-testid="pos-refusal">{t(outcome.copyKey)}</p>}

        <Button variant="primary" size="lg" className="pos-charge" disabled={!canCharge} busy={busy} onClick={() => void charge()}>{t("pos.charge")}</Button>
      </Card>

      <OptionsSheet entry={picking} fmt={fmt} onClose={() => setPicking(null)} onAdd={(e, ids) => { add(e, ids); setPicking(null); }} />
    </div>
  );
}
