"use client";
// Munim Cares on the storefront: this business's own published donation listings (GET /v1/storefront/cares, uncached,
// 60/min) and the network impact (public route, no key). Each impact number is a chip that opens the public snapshot rows
// it was rendered from; its ref must name this response's snapshot, the all-cities row and that column, else "cannot
// verify" (R25). Labels are the API's: the recipient name already ends in "(simulated)" and "Simulated recipient" is shown
// as well. Untrusted listing text renders as text only. A failed call hides the section, except 429, which says so.
import { Badge, CannotVerify, IconFlask, IconRows, RowsDrawer, SnapshotSourceProvider, type SnapshotSource } from "@munim/ui";
import type { Snapshot } from "@munim/contracts/shared";
import { createPublicClient, type Schemas } from "@munim/sdk";
import { useEffect, useState } from "react";
import { API_BASE } from "../api.ts";
import { t } from "../i18n/index.ts";
import type { CaresItem } from "./api.ts";
import { readRefusal, storefrontClient } from "./api.ts";
import { countryFor, formatterFor } from "./format.ts";
import { useStore } from "./store.tsx";

type Impact = Schemas["V1CaresNetworkImpact"];
type State = { kind: "load" } | { kind: "ok"; items: CaresItem[] } | { kind: "limited"; seconds: number } | { kind: "hidden" };
type Target = { snapshot_id: string; row: number; column: string };

const FOOD = { cooked: "order.cares.food.cooked", raw: "order.cares.food.raw", packaged: "order.cares.food.packaged" } as const;
const CELLS = ["meals_portions_milli", "weight_g"] as const;

/** `⟨snap:<id>·<row>·<col>⟩` -> its parts; anything else is null (a forged or malformed ref is "cannot verify"). */
export function parseRef(token: string): Target | null {
  const m = /^⟨snap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})·(\d+)·([a-z][a-z0-9_]*)⟩$/.exec(token);
  return m ? { snapshot_id: m[1]!, row: Number(m[2]), column: m[3]! } : null;
}

/** The ref of `column` in the all-cities row, only if it names exactly this response's snapshot, that row and that column. */
export function verifiedRef(impact: Impact, column: (typeof CELLS)[number]): { row: number; target: Target } | null {
  const row = impact.rows.findIndex((r) => r.city_code === null);
  if (row < 0) return null;
  const ref = parseRef(impact.rows[row]![column].ref);
  return ref && ref.snapshot_id === impact.snapshot_id && ref.row === row && ref.column === column ? { row, target: ref } : null;
}

/** Public: the published network snapshot only (404 otherwise — "cannot verify" in the drawer). */
const snapshotSource: SnapshotSource = async (id) => {
  const { data, response } = await createPublicClient({ baseUrl: API_BASE }).GET("/v1/cares-network/snapshots/{id}", { params: { path: { id } } });
  if (data) return data as unknown as Snapshot;
  if (response.status === 404 || response.status === 403) return null;
  throw new Error(`snapshot ${response.status}`);
};

export function CaresSection({ currency }: { currency: string }) {
  const { storeKey, outlet } = useStore();
  const [state, setState] = useState<State>({ kind: "load" });
  const [impact, setImpact] = useState<Impact | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const { data, response, error } = await storefrontClient(storeKey).GET("/v1/storefront/cares");
        if (!live) return;
        if (data) return setState({ kind: "ok", items: data.items });
        const r = readRefusal(response, error);
        if (r.reason === "rate_limited") {
          const seconds = r.retryAfter ?? 5;
          setState({ kind: "limited", seconds });
          timer = setTimeout(() => setRetry((n) => n + 1), seconds * 1000);
        } else setState({ kind: "hidden" });
      } catch {
        if (live) setState({ kind: "hidden" });
      }
    })();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [storeKey, retry]);

  useEffect(() => {
    let live = true;
    createPublicClient({ baseUrl: API_BASE }).GET("/v1/cares-network/impact", { params: { query: {} } })
      .then(({ data }) => { if (live && data) setImpact(data); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const fmt = formatterFor(currency, outlet?.tz);
  const country = countryFor(currency);
  if (state.kind === "hidden" || state.kind === "load" || !fmt || !country || !outlet) return null;
  const totalRow = impact?.rows.find((r) => r.city_code === null);
  return (
    <section className="sf-col" aria-labelledby="sf-cares-h" data-section="cares">
      <h2 id="sf-cares-h">{t("order.cares.title")}</h2>
      <p>{t("order.cares.intro")}</p>
      {state.kind === "limited" && <p className="sf-note" data-tone="warning" role="status">{t("order.refuse.rate_limited_wait", { seconds: String(state.seconds) })}</p>}
      {state.kind === "ok" && state.items.length === 0 && <p>{t("order.cares.empty")}</p>}
      {state.kind === "ok" && state.items.map((l) => <Listing key={l.listing_id} l={l} currency={currency} />)}
      {impact && totalRow && (
        <SnapshotSourceProvider source={snapshotSource}>
          <div className="sf-cares-listing" data-block="network-impact">
            <strong>{t("order.cares.meals")}</strong>
            <Badge tone="info">{impact.labels.data}</Badge>
            <dl className="sf-dl">
              {CELLS.map((col) => {
                const ok = verifiedRef(impact, col);
                const text = fmt.cell(totalRow[col].value, col);
                return (
                  <div key={col} style={{ display: "contents" }}>
                    <dt>{t(`order.cares.cell.${col}` as "order.cares.cell.weight_g")}</dt>
                    <dd data-cell={col}>
                      {ok
                        ? <button type="button" className="mu-chip" data-mu-chip="snap" aria-label={t("order.cares.cell_aria", { value: text })} onClick={() => setTarget(ok.target)}><IconRows size={14} />{text}</button>
                        : <CannotVerify />}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
          <RowsDrawer target={target} format={{ country, tz: outlet.tz }} onClose={() => setTarget(null)} />
        </SnapshotSourceProvider>
      )}
      <p className="mu-field-hint">{t("order.cares.rules")}</p>
    </section>
  );
}

function Listing({ l, currency }: { l: CaresItem; currency: string }) {
  const fmt = formatterFor(currency, l.tz);
  if (!fmt) return null;
  return (
    <article className="sf-cares-listing" data-listing={l.listing_id}>
      <strong>{l.outlet_name}</strong>
      <span className="sf-meta">
        <Badge tone="evidence" icon={<IconFlask size={14} />}>{t("order.cares.simulated_recipient")}</Badge>
        <span>{t("order.cares.recipient", { name: l.recipient_name })}</span>
      </span>
      <span>{t("order.cares.pickup", { from: fmt.dateTime(l.pickup_from), to: fmt.time(l.pickup_to) })}</span>
      <ul className="sf-list">
        {l.lines.map((x) => (
          <li key={x.line_no}>
            {x.label ?? x.label_key ?? ""} · {t(FOOD[x.food_kind])} · {fmt.qtyMilli(x.qty_milli)} {x.unit}
            {x.expires_on && ` · ${t("order.cares.expires", { date: fmt.date(x.expires_on) })}`}
          </li>
        ))}
      </ul>
    </article>
  );
}
