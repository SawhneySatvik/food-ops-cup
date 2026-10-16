// file: components/staff/pages/draft-detail.tsx
"use client";
// /staff/inbox/[draftId]: one AI draft, decided by a named person. GET /v1/drafts/{id} first (only it carries
// unverified_refs), then the names its rows need. Every number is a DraftField: the proposed value with its chip, or
// "Cannot verify". The buttons are 02's DecisionBar on 01's drafts.ts, the same as every other draft card: "Approve"
// only while every number traces, "Approve with my edits" sends what the person typed as {value, typed_by}, Reject
// always asks for a reason. Every answer refetches the draft and shows what it says now; live updates on
// inbox:<tenant> refetch it too.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import {
  approveGate, draftTitle, fieldLabel, findingTitle, historyWords, lineageLine, numericFields, sourceName, staleChanges, withEdits,
  type DraftDetail, type NumericField, type Outcome,
} from "@/lib/munim/drafts";
import { dayLabel, formatDate, formatTime, formatWhen, titleCase } from "@/lib/munim/format";
import { columnOf, formatCell, parseRef, outletNames, type CellFormat } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { watchFor } from "@/lib/munim/staff-app";
import { CHANNEL, NO_SEND, messageWords } from "@/lib/munim/campaign-words";
import { DRAFT_STATUS, staffErrorText } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { DecisionBar, useDecision } from "../decision";
import { DraftField } from "../draft-field";
import { useStaff } from "../shell";
import { CannotVerify, DRAFT_TONE, SimulatedRecipient, SimulatedSupplier, SnapshotDrawer, SourcedValue, StatusPill } from "../source";
import { ErrorNote, FullPage, OfflineBanner, Toast, useToast } from "../../ui";
import { LiveLine, NotForRole } from "./inbox";

const STALE = "The numbers behind this changed since it was proposed. It can no longer be approved or rejected; a new proposal will replace it.";
const DECIDED_ELSEWHERE = "Someone else already decided this. It has been refreshed.";
const PO_LINE = "Munim works out the total when it is approved. Recorded only — Munim does not process payments. Simulated supplier: nothing is sent to a real business.";

/** What the rows need names for (the payload carries ids only). */
interface Names {
  items: Map<string, string>;
  ingredients: Map<string, string>;
  supplier: Schemas["V1Supplier"] | null;
  /** A Cares proposal's simulated recipient, by its id. */
  recipient: string | null;
  finding: string | null;
}

export function DraftDetailPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const { session, client, outlets, handleAuth } = useStaff();
  const me = session.me;
  const allowed = can(session, "inbox");
  const [detail, setDetail] = useState<DraftDetail | "not_found" | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [names, setNames] = useState<Names>({ items: new Map(), ingredients: new Map(), supplier: null, recipient: null, finding: null });
  const [loadError, setLoadError] = useState<MunimError | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [result, setResult] = useState<{ type: string; entityId: string } | null>(null);
  const [live, setLive] = useState<LiveState>("connecting");
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [toast, setToast] = useToast();
  const online = useOnline();
  const statusRef = useRef<string | null>(null);
  const valid = UUID7.test(draftId);

  const load = useCallback(async (): Promise<DraftDetail | null> => {
    const r = await client.getDraft(draftId);
    if (r.ok) {
      setDetail(r.data);
      setLoadError(null);
      return r.data;
    }
    if (handleAuth(r.error)) return null;
    if (r.error.kind === "not_found") setDetail("not_found");
    else setLoadError(r.error);
    return null;
  }, [client, draftId, handleAuth]);

  // Every settled approve or reject: say what happened, then show what core says now.
  const onOutcome = (o: Outcome) => {
    if (o.kind === "signed_out") {
      handleAuth(o.error);
      return;
    }
    if (o.kind === "done") {
      setResult(o);
      setEditing(false);
      setEdits({});
      setToast(o.type === "drafts.reject.v1" ? "Rejected. Nothing was changed." : "Approved and applied.");
    }
    if (o.kind === "decided_elsewhere") setToast(DECIDED_ELSEWHERE);
    void load().then((d) => { statusRef.current = d?.draft.status ?? statusRef.current; });
  };
  // The command type is known once the draft has loaded; the bar that sends with it renders only after that.
  const dec = useDecision(client, { draft_id: draftId, command_type: detail && detail !== "not_found" ? detail.draft.command_type : "" }, "inbox", onOutcome);

  useEffect(() => {
    if (!allowed || !valid) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load().then((d) => { statusRef.current = d?.draft.status ?? null; });
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
    return watchFor(session, [topic.inbox(session.tenantId)], () => {
      void load().then((d) => {
        // Decided on another screen while this one was open, by someone else: say so. (This person's own decision
        // arrives here too, and is not announced twice.)
        if (d && statusRef.current === "proposed" && d.draft.status !== "proposed" && d.decision?.decided_by.member_id !== me.member_id) setToast(DECIDED_ELSEWHERE);
        statusRef.current = d?.draft.status ?? statusRef.current;
      });
    }, setLive);
  }, [allowed, valid, client, load, session, me.member_id, setToast]);

  // Names for the rows, once the draft is known: items from the outlet's menu, ingredients, the supplier, the simulated
  // recipient (from the outlet's recipients), the finding.
  const draft = detail && detail !== "not_found" ? detail.draft : null;
  const draftKey = draft?.draft_id ?? null;
  useEffect(() => {
    if (!draft) return;
    const p = draft.payload as Record<string, unknown>;
    // One of the draft's outlets this person works in (a manager sees a two-outlet draft by overlap; asking for the
    // other outlet's menu or recipients would be a 404). The menu only when the draft names an item.
    const outletId = draft.outlet_ids.find((o) => outlets.some((x) => x.id === o)) ?? null;
    let live = true;
    void Promise.all([
      outletId && typeof p.item_id === "string" ? client.getMenu(outletId, "counter") : null,
      client.listIngredients(),
      typeof p.supplier_id === "string" ? client.getSupplier(p.supplier_id) : null,
      typeof p.recipient_id === "string" && outletId ? client.listRecipients(outletId) : null,
      draft.finding_id ? client.listInbox() : null,
    ]).then(([menu, ing, sup, rec, inbox]) => {
      if (!live) return;
      const f = inbox?.ok ? inbox.data.items.find((i) => i.kind === "finding" && i.finding.finding_id === draft.finding_id) : undefined;
      setNames({
        items: new Map(menu?.ok ? menu.data.entries.map((e) => [e.item_id, e.display_name ?? titleCase(e.name_key)]) : []),
        ingredients: new Map(ing.ok ? ing.data.items.map((i) => [i.ingredient_id, i.name]) : []),
        supplier: sup?.ok ? sup.data : null,
        recipient: rec?.ok ? (rec.data.items.find((r) => r.recipient_id === p.recipient_id)?.name ?? null) : null,
        finding: f?.kind === "finding" ? findingTitle(f.finding.type) : null,
      });
    });
    return () => { live = false; };
    // The names depend on the draft, not on each refetch of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, client, outlets]);

  if (!allowed) return <NotForRole />;
  if (!valid || detail === "not_found") {
    return (
      <FullPage title="Not found." action={<Link href="/staff/inbox" className="btn btn-primary">Back to the inbox</Link>}>
        <p>It may have been removed, or it isn&apos;t in your outlets.</p>
      </FullPage>
    );
  }
  if (loadError && !detail) {
    return (
      <main className="wrap staff-main space-y-3">
        <ErrorNote>{staffErrorText(loadError, "inbox")}</ErrorNote>
        <button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button>
      </main>
    );
  }
  if (!detail || !tenant) return <main className="wrap staff-main"><div className="skeleton h-96" role="status" aria-label="Loading" /></main>;

  const tz = outlets.find((o) => o.id === detail.draft.outlet_ids[0])?.tz ?? outlets[0]?.tz ?? tenant.home_tz ?? "UTC";
  const fmt: CellFormat = { locale: SITE.locale, currency: tenant.base_currency, outletNames: outletNames(outlets) };
  const when = (iso: string) => formatWhen(iso, tz, SITE.locale);
  const open = (snapshotId: string, refToken: string) => setDrawer({ snapshotId, refToken });
  const fields = numericFields(detail);
  const gate = approveGate(detail, fields, me);
  const p = detail.draft.payload as Record<string, unknown>;
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? "Another outlet";

  const labelOf = (f: NumericField): string => {
    const base = fieldLabel(f.column);
    if (!f.line) return base;
    const id = typeof f.line.ingredient_id === "string" ? f.line.ingredient_id : typeof f.line.item_id === "string" ? f.line.item_id : null;
    const what = id ? (names.ingredients.get(id) ?? names.items.get(id) ?? "An item") : "A line";
    const unit = typeof f.line.unit === "string" ? f.line.unit : null;
    return `${what} · ${base}${unit ? (f.column.endsWith("_minor") ? ` per ${unit}` : ` (${unit})`) : ""}`;
  };

  const changes = staleChanges(detail);
  /** A cited cell in words: a recipient by name, other ids by their last characters, times in the outlet's zone. */
  const cellText = (value: Parameters<typeof formatCell>[0], column: string): string => {
    if (typeof value === "string" && column.endsWith("_id")) return column === "recipient_id" && names.recipient ? names.recipient : `…${value.slice(-8)}`;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatWhen(value, tz, SITE.locale);
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value, SITE.locale);
    return formatCell(value, column, fmt);
  };
  const textRows: [string, React.ReactNode][] = [];
  if (typeof p.item_id === "string") textRows.push(["Item", names.items.get(p.item_id) ?? "An item"]);
  if (typeof p.outlet_id === "string") textRows.push(["Outlet", outletName(p.outlet_id)]);
  if (Array.isArray(p.outlet_ids)) textRows.push(["Outlets", p.outlet_ids.length === 0 ? "Whole business" : p.outlet_ids.map((o) => outletName(String(o))).join(", ")]);
  if (typeof p.station === "string") textRows.push(["Station", titleCase(p.station)]);
  if (typeof p.supplier_id === "string") textRows.push(["Supplier", names.supplier ? <>{names.supplier.name} {names.supplier.kind === "simulated" && <SimulatedSupplier />}</> : "A supplier"]);
  // A donation: who gets the food (always with its badge: every recipient is simulated) and when it is picked up.
  if (typeof p.recipient_id === "string") textRows.push(["To", <>{names.recipient ?? "A simulated recipient that is no longer listed"} <SimulatedRecipient /></>]);
  if (typeof p.pickup_from === "string" && typeof p.pickup_to === "string") {
    textRows.push(["Pickup", `${dayLabel(p.pickup_from, tz, SITE.locale)} ${formatTime(p.pickup_from, tz, SITE.locale)} – ${formatTime(p.pickup_to, tz, SITE.locale)}`]);
  }
  if (typeof p.business_date === "string") textRows.push(["For", formatDate(p.business_date, SITE.locale)]);
  if (typeof p.valid_from === "string") textRows.push(["Starts", formatDate(p.valid_from, SITE.locale)]);
  if (typeof p.expected_on === "string") textRows.push(["Expected", formatDate(p.expected_on, SITE.locale)]);
  // A campaign (R67): the fixed message the customers would read, how, and the planned day. Nothing is ever sent.
  if (detail.draft.command_type === "customers.campaign.create.v1") {
    if (typeof p.message_key === "string") textRows.push(["Message", <q key="m">{messageWords(p.message_key)}</q>]);
    if (p.channel === "sms" || p.channel === "email") textRows.push(["By", CHANNEL[p.channel]]);
    if (typeof p.send_at === "string") textRows.push(["Planned for", dayLabel(p.send_at, tz, SITE.locale)]);
  }

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="wrap staff-main space-y-5">
        <Link href="/staff/inbox" className="btn btn-plain">← Inbox</Link>
        <article className="card space-y-4 p-6" aria-labelledby="draft-title">
          <header className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={DRAFT_TONE[detail.draft.status] ?? "new"}>{DRAFT_STATUS[detail.draft.status] ?? detail.draft.status}</StatusPill>
              <span className="text-[15px] text-muted">{sourceName(detail.draft.source)} · {detail.draft.outlet_ids.length === 0 ? "Whole business" : detail.draft.outlet_ids.map(outletName).join(", ")}</span>
            </div>
            <h1 id="draft-title" className="section-title">{draftTitle(detail.draft.command_type)}</h1>
          </header>

          <div>
            {textRows.map(([label, value]) => (
              <div key={label} className="draft-field"><p className="font-semibold">{label}</p><p>{value}</p></div>
            ))}
            {fields.map((f) => (
              <DraftField key={f.path} label={labelOf(f)} value={f.value} edit={edits[f.path] ?? null} editorName={me.name} fmt={fmt} column={f.column}
                lineUnit={typeof f.line?.unit === "string" ? f.line.unit : undefined} onOpen={open}
                editing={editing} onEdit={editing ? (v) => setEdits((e) => { const next = { ...e }; if (v === null) delete next[f.path]; else next[f.path] = v; return next; }) : undefined} />
            ))}
          </div>

          {detail.draft.command_type === "purchasing.po.create.v1" && <p className="text-[14px] text-muted">{PO_LINE}</p>}
          {detail.draft.command_type === "customers.campaign.create.v1" && <p className="badge badge-sim h-auto whitespace-normal py-1">{NO_SEND}</p>}

          {detail.draft.based_on.length > 0 && (
            <div className="space-y-1">
              <p className="font-semibold">Based on</p>
              <ul className="space-y-1">
                {detail.draft.based_on.map((b) => {
                  const ref = parseRef(b.ref);
                  return (
                    <li key={b.ref}>
                      {templateWords(b.template_id)}:{" "}
                      {ref ? <SourcedValue text={cellText(b.expected, columnOf(ref))} refToken={b.ref} onOpen={open} /> : <CannotVerify />}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {detail.draft.status === "stale" && (
            <div className="space-y-2">
              <p className="font-semibold">{STALE}</p>
              <ul className="space-y-1">
                {changes.map((c) => {
                  const was = parseRef(c.ref);
                  const now = c.now_ref ? parseRef(c.now_ref) : null;
                  return (
                    <li key={c.ref}>
                      Was {was ? <SourcedValue text={formatCell(c.value, columnOf(was), fmt)} refToken={c.ref} onOpen={open} /> : <CannotVerify />}
                      {" · now "}
                      {now && c.now_ref ? <SourcedValue text={formatCell(c.now, columnOf(now), fmt)} refToken={c.now_ref} onOpen={open} /> : <CannotVerify />}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="lineage">{lineageLine(detail, when, names.finding)}</p>

          <DecisionBar
            name={me.name} gate={gate} commandType={detail.draft.command_type} edits={edits} editing={editing}
            onEdit={(on) => { setEditing(on); if (!on) setEdits({}); }}
            busy={dec.busy} error={dec.error} retry={dec.retry} wait={dec.wait}
            onApprove={() => dec.approve(null, null)}
            onApproveEdited={(reason) => dec.approve(withEdits(detail.draft.payload, edits, me.member_id), reason)}
            onReject={dec.reject}
          />
          {result?.type === "purchasing.po.create.v1" && <Link href={`/staff/purchase-orders/${result.entityId}`} className="btn btn-secondary">Open the purchase order</Link>}
          {result?.type === "customers.campaign.create.v1" && <Link href="/staff/campaigns" className="btn btn-secondary">Open campaigns</Link>}
        </article>

        <section aria-labelledby="history-title" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="history-title" className="text-[22px]">What happened</h2>
            <LiveLine state={live} onRefresh={() => void load()} />
          </div>
          <ol className="space-y-1">
            {detail.history.map((h, i) => (
              <li key={i} className="text-[15px]">
                {historyWords(h)} · {when(h.at)}{h.reason ? <> · “<span>{h.reason}</span>”</> : null}
              </li>
            ))}
          </ol>
        </section>

        <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />
        <Toast message={toast} />
      </main>
    </>
  );
}
