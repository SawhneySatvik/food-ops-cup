"use client";
// Impact. Two blocks, each number a chip that opens the snapshot rows it was rendered from (R25, R26): the business's own
// impact (a member-minted `cares.impact` snapshot: evidence, not the books) and the network total (an operator-minted,
// operator-published snapshot; the API gives each value beside its ref). Nothing is summed, converted or rounded here.
import type { Schemas } from "@munim/sdk";
import type { Snapshot } from "@munim/contracts/shared";
import { Card, CannotVerify, IconRows, RowsDrawer, Skeleton, SnapshotSourceProvider, StateEmpty, StateError, Table, createFormatter, type FormatSpec, type SnapshotSource } from "@munim/ui";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useConsole } from "../console/context.tsx";
import { t } from "../i18n/index.ts";
import { impactCache, type Load } from "./data.ts";
import { cityName, dateIn, parseRef } from "./model.ts";
import { CaresLabels } from "./shared.tsx";

type Target = { snapshot_id: string; row: number; column: string };
type NetImpact = Schemas["V1CaresNetworkImpact"];

function Chip({ text, onOpen }: { text: string; onOpen: () => void }) {
  return (
    <button type="button" className="mu-chip" data-mu-chip="snap" aria-label={t("cares.impact.cell", { value: text })} onClick={onOpen}>
      <IconRows size={14} />{text}
    </button>
  );
}

/** Public: the published network snapshot only (404 otherwise — "cannot verify" in the drawer). */
const networkSource: SnapshotSource = async (id) => {
  const { data, response } = await api.GET("/v1/cares-network/snapshots/{id}", { params: { path: { id } } });
  if (data) return data as unknown as Snapshot;
  if (response.status === 404 || response.status === 403) return null;
  throw new Error(`network snapshot ${response.status}`);
};

const MINE_COLS = ["handovers", "portions_milli", "weight_g", "volume_ml", "value_at_cost_minor"] as const;
const MINE_KINDS = ["total", "donation", "offer"];

function MyImpact({ format }: { format: FormatSpec }) {
  const c = useConsole();
  const [snap, setSnap] = useState<Load<Snapshot>>({ status: "loading" });
  const [target, setTarget] = useState<Target | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scope = c.outletId;
  useEffect(() => {
    let live = true;
    setSnap({ status: "loading" });
    const now = new Date();
    const tz = format.tz;
    const from = dateIn(tz, now, 30);
    const to = dateIn(tz, now, -30);
    const key = `${scope ?? "all"}|${from}|${to}`;
    let p = impactCache.get(key) as Promise<Snapshot | null> | undefined;
    if (!p) {
      p = api.POST("/v1/snapshots", { body: { template_id: "cares.impact", params: { outlet_id: scope, from, to } } }).then(
        (r) => (r.data ? (r.data as unknown as Snapshot) : null),
        () => null,
      );
      impactCache.set(key, p);
    }
    p.then((snapshot) => {
      if (!snapshot) impactCache.delete(key); // only a failure is re-minted, on retry
      if (live) setSnap(snapshot ? { status: "ok", data: snapshot } : { status: "err" });
    });
    return () => { live = false; };
  }, [scope, format.tz, attempt]);

  const fmt = createFormatter(format);
  return (
    <section data-block="my-impact">
      <h3>{t("cares.impact.mine")}</h3>
      <p className="mu-field-hint">{t("cares.impact.period", { scope: c.outlets.find((o) => o.id === scope)?.name ?? t("chrome.scope.all") })}</p>
      {snap.status === "loading" && <Skeleton rows={3} />}
      {snap.status === "err" && <StateError onRetry={() => setAttempt((n) => n + 1)} />}
      {snap.status === "ok" && (
        <div className="cares-scroll"><Table>
          <thead><tr><th />{MINE_COLS.map((col) => <th key={col} className="num">{t(`cares.impact.col.${col}`)}</th>)}</tr></thead>
          <tbody>
            {snap.data.rows.map((row, i) => (
              <tr key={i} data-impact-row={String(row.kind)}>
                <th scope="row">{MINE_KINDS.includes(String(row.kind)) ? t(`cares.impact.row.${String(row.kind)}`) : String(row.kind)}</th>
                {MINE_COLS.map((col) => (
                  <td key={col} className="num">
                    <Chip text={fmt.cell(row[col] ?? null, col)} onOpen={() => setTarget({ snapshot_id: snap.data.snapshot_id, row: i, column: col })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table></div>
      )}
      <RowsDrawer target={target} format={format} onClose={() => setTarget(null)} />
    </section>
  );
}

const NET_COLS = ["businesses", "donations", "meals_portions_milli", "weight_g", "volume_ml"] as const;

function NetworkImpact({ format }: { format: FormatSpec }) {
  const [net, setNet] = useState<Load<NetImpact | null>>({ status: "loading" });
  const [target, setTarget] = useState<Target | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setNet({ status: "loading" });
    api.GET("/v1/cares-network/impact").then(
      (r) => live && setNet(r.data ? { status: "ok", data: r.data } : r.response.status === 404 ? { status: "ok", data: null } : { status: "err" }),
      () => live && setNet({ status: "err" }),
    );
    return () => { live = false; };
  }, [attempt]);

  const fmt = createFormatter(format);
  return (
    <section data-block="network-impact">
      <h3>{t("cares.impact.network")}</h3>
      {net.status === "loading" && <Skeleton rows={3} />}
      {net.status === "err" && <StateError onRetry={() => setAttempt((n) => n + 1)} />}
      {net.status === "ok" && net.data === null && <StateEmpty message={t("cares.impact.network_empty")} />}
      {net.status === "ok" && net.data !== null && (() => {
        const d = net.data;
        return (
          <SnapshotSourceProvider source={networkSource}>
            <CaresLabels labels={d.labels} />
            <p className="mu-field-hint">{t("cares.impact.network_asof", { time: fmt.dateTime(d.as_of) })}</p>
            <div className="cares-scroll"><Table>
              <thead><tr><th />{NET_COLS.map((col) => <th key={col} className="num">{t(`cares.impact.col.${col}`)}</th>)}</tr></thead>
              <tbody>
                {d.rows.map((row, i) => (
                  <tr key={i} data-impact-row={row.city_code ?? "all"}>
                    <th scope="row">{row.city_code ? cityName(row.city_code) : t("cares.impact.all_cities")}</th>
                    {NET_COLS.map((col) => {
                      const fact = row[col];
                      const ref = parseRef(fact.ref);
                      // A ref that is malformed, names another snapshot, or points at another cell is never opened.
                      if (!ref || ref.snapshot_id !== d.snapshot_id || ref.row !== i || ref.column !== col) return <td key={col} className="num"><CannotVerify /></td>;
                      return <td key={col} className="num"><Chip text={fmt.cell(fact.value, col)} onOpen={() => setTarget(ref)} /></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </Table></div>
            <RowsDrawer target={target} format={format} onClose={() => setTarget(null)} />
          </SnapshotSourceProvider>
        );
      })()}
    </section>
  );
}

export function ImpactTab() {
  const c = useConsole();
  return (
    <>
      <MyImpact format={c.format} />
      <Card><NetworkImpact format={c.format} /></Card>
    </>
  );
}
