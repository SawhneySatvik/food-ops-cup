// file: components/staff/pages/draft-detail.tsx
"use client";
// /staff/inbox/[draftId]: one AI draft, decided by a named person. GET /v1/drafts/{id} first (only it carries
// unverified_refs), then the names its rows need. Every number is a DraftField: the proposed value with its chip, or
// "Cannot verify"; "Approve" exists only while every number traces; "Approve with my edits" sends what the person typed
// as {value, typed_by}; Reject always asks for a reason. One attempt = one frozen envelope (01 §4). A 409 or 422 from
// approve refetches the draft and shows what it says now. Live updates on inbox:<tenant> refetch it too.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown, useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { attemptFor, retryable, type CommandAttempt } from "@/lib/munim/commands";
import {
  approveGate, draftTitle, editsReady, fieldLabel, findingTitle, historyWords, lineageLine, numericFields, sourceName, staleChanges, withEdits,
  type DraftDetail, type NumericField,
} from "@/lib/munim/drafts";
import { formatDate, formatWhen, titleCase } from "@/lib/munim/format";
import { columnOf, formatCell, parseRef, type CellFormat } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { watchFor } from "@/lib/munim/staff-app";
import { DRAFT_STATUS, REJECT_REASONS, staffErrorText } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { DraftField } from "../draft-field";
import { useStaff } from "../shell";
import { CannotVerify, DRAFT_TONE, SimulatedSupplier, SnapshotDrawer, SourcedValue, StatusPill } from "../source";
import { ErrorNote, FullPage, Toast, useToast } from "../../ui";
import { LiveLine, NotForRole } from "./inbox";

type Approve = CommandAttempt<"drafts.approve.v1", Schemas["DraftsApproveV1"]>;
type Reject = CommandAttempt<"drafts.reject.v1", Schemas["DraftsRejectV1"]>;
type ReasonCode = (typeof REJECT_REASONS)[number]["code"];
type Mode = "view" | "edit" | "reject";

const NOT_TRACED = "Some numbers in this draft don't trace to your books. Type the values you checked, or reject it.";
const UNTRACEABLE = "Some numbers this draft relies on can't be opened with your access, so it can't be approved. You can reject it.";
const NOT_FOR_YOU = "Only the owner can decide this one: it changes the whole business.";
const STALE = "The numbers behind this changed since it was proposed. It can no longer be approved; reject it or wait for a new one.";
const DECIDED_ELSEWHERE = "Someone else already decided this. It has been refreshed.";

/** What the rows need names for (the payload carries ids only). */
interface Names {
  items: Map<string, string>;
  ingredients: Map<string, string>;
  supplier: Schemas["V1Supplier"] | null;
  finding: string | null;
}

export function DraftDetailPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const { session, client, outlets, handleAuth } = useStaff();
  const me = session.me;
  const allowed = can(session, "inbox");
  const [detail, setDetail] = useState<DraftDetail | "not_found" | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [names, setNames] = useState<Names>({ items: new Map(), ingredients: new Map(), supplier: null, finding: null });
  const [loadError, setLoadError] = useState<MunimError | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [why, setWhy] = useState("");
  const [rejectCode, setRejectCode] = useState<ReasonCode | "">("");
  const [rejectNote, setRejectNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "edited" | "reject" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [result, setResult] = useState<Schemas["CommandResult"] | null>(null);
  const [live, setLive] = useState<LiveState>("connecting");
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [toast, setToast] = useToast();
  const online = useOnline();
  const approveAttempt = useRef<Approve | null>(null);
  const rejectAttempt = useRef<Reject | null>(null);
  const busyRef = useRef(false);
  const statusRef = useRef<string | null>(null);
  const valid = UUID7.test(draftId);
  const waitS = useCountdown(retryAt, () => setRetryAt(null));

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

  useEffect(() => {
    if (!allowed || !valid) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load().then((d) => { statusRef.current = d?.draft.status ?? null; });
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
    return watchFor(session, [topic.inbox(session.tenantId)], () => {
      void load().then((d) => {
        // Decided on another screen while this one was open (not by this person's own tap): say so.
        if (d && statusRef.current === "proposed" && d.draft.status !== "proposed" && !busyRef.current && d.decision?.decided_by.member_id !== me.member_id) setToast(DECIDED_ELSEWHERE);
        statusRef.current = d?.draft.status ?? statusRef.current;
      });
    }, setLive);
  }, [allowed, valid, client, load, session, me.member_id, setToast]);

  // Names for the rows, once the draft is known: items from the outlet's menu, ingredients, the supplier, the finding.
  const draft = detail && detail !== "not_found" ? detail.draft : null;
  const draftKey = draft?.draft_id ?? null;
  useEffect(() => {
    if (!draft) return;
    const p = draft.payload as Record<string, unknown>;
    const outletId = draft.outlet_ids[0] ?? null;
    let live = true;
    void Promise.all([
      outletId ? client.getMenu(outletId, "counter") : null,
      client.listIngredients(),
      typeof p.supplier_id === "string" ? client.getSupplier(p.supplier_id) : null,
      draft.finding_id ? client.listInbox() : null,
    ]).then(([menu, ing, sup, inbox]) => {
      if (!live) return;
      const f = inbox?.ok ? inbox.data.items.find((i) => i.kind === "finding" && i.finding.finding_id === draft.finding_id) : undefined;
      setNames({
        items: new Map(menu?.ok ? menu.data.entries.map((e) => [e.item_id, e.display_name ?? titleCase(e.name_key)]) : []),
        ingredients: new Map(ing.ok ? ing.data.items.map((i) => [i.ingredient_id, i.name]) : []),
        supplier: sup?.ok ? sup.data : null,
        finding: f?.kind === "finding" ? findingTitle(f.finding.type) : null,
      });
    });
    return () => { live = false; };
    // The names depend on the draft, not on each refetch of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, client]);

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
  const fmt: CellFormat = { locale: SITE.locale, currency: tenant.base_currency };
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

  const settle = async (r: Awaited<ReturnType<typeof client.approveDraft>>, verb: "approve" | "reject") => {
    if (r.ok) {
      if (verb === "approve") approveAttempt.current = null;
      else rejectAttempt.current = null;
      setResult(r.data);
      setMode("view");
      setEdits({});
      setToast(verb === "approve" ? "Approved and applied." : "Rejected. Nothing was changed.");
      statusRef.current = (await load())?.draft.status ?? null;
      return;
    }
    if (handleAuth(r.error)) return;
    if (!retryable(r.error)) {
      approveAttempt.current = null;
      rejectAttempt.current = null;
    }
    if (r.error.kind === "rate_limited") setRetryAt(Date.now() + (r.error.retryAfterMs ?? 5000));
    if (r.error.code === "already_decided") setToast(DECIDED_ELSEWHERE);
    else setNote(staffErrorText(r.error, "inbox"));
    // The draft may have moved (decided, stale, failed, or numbers that no longer trace): show what it says now.
    if (r.error.status === 409 || r.error.status === 422 || r.error.kind === "not_found") statusRef.current = (await load())?.draft.status ?? null;
  };

  const approve = async (withMine: boolean) => {
    if (busyRef.current) return;
    const edited = withMine ? withEdits(detail.draft.payload, edits, me.member_id) : null;
    const reason = withMine ? why.trim() : null;
    const a = attemptFor(approveAttempt.current, JSON.stringify([draftId, edited, reason]), "drafts.approve.v1", () => ({
      draft_id: draftId, command_type: detail.draft.command_type, edited_payload: edited, reason,
    }));
    approveAttempt.current = a;
    busyRef.current = true;
    setBusy(withMine ? "edited" : "approve");
    setNote(null);
    const r = await client.approveDraft(draftId, a.body);
    busyRef.current = false;
    setBusy(null);
    await settle(r, "approve");
  };

  const reject = async () => {
    const text = rejectNote.trim();
    if (busyRef.current || !rejectCode || text.length < 1 || text.length > 500) return;
    const a = attemptFor(rejectAttempt.current, JSON.stringify([draftId, rejectCode, text]), "drafts.reject.v1", () => ({ draft_id: draftId, reason: text, reason_code: rejectCode }));
    rejectAttempt.current = a;
    busyRef.current = true;
    setBusy("reject");
    setNote(null);
    const r = await client.rejectDraft(draftId, a.body);
    busyRef.current = false;
    setBusy(null);
    await settle(r, "reject");
  };

  const locked = busy !== null || retryAt !== null;
  const changes = staleChanges(detail);
  const textRows: [string, React.ReactNode][] = [];
  if (typeof p.item_id === "string") textRows.push(["Item", names.items.get(p.item_id) ?? "An item"]);
  if (typeof p.outlet_id === "string") textRows.push(["Outlet", outletName(p.outlet_id)]);
  if (Array.isArray(p.outlet_ids)) textRows.push(["Outlets", p.outlet_ids.length === 0 ? "Whole business" : p.outlet_ids.map((o) => outletName(String(o))).join(", ")]);
  if (typeof p.station === "string") textRows.push(["Station", titleCase(p.station)]);
  if (typeof p.supplier_id === "string") textRows.push(["Supplier", names.supplier ? <>{names.supplier.name} {names.supplier.kind === "simulated" && <SimulatedSupplier />}</> : "A supplier"]);
  if (typeof p.business_date === "string") textRows.push(["For", formatDate(p.business_date, SITE.locale)]);
  if (typeof p.valid_from === "string") textRows.push(["Starts", formatDate(p.valid_from, SITE.locale)]);
  if (typeof p.expected_on === "string") textRows.push(["Expected", formatDate(p.expected_on, SITE.locale)]);

  return (
    <main className="wrap staff-main max-w-[860px] space-y-5">
      {!online && <div className="offline-bar" role="status">You&apos;re offline. Showing the last update.</div>}
      <Link href="/staff/inbox" className="btn btn-plain">← Inbox</Link>
      <article className="card space-y-4 p-6" aria-labelledby="draft-title">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={DRAFT_TONE[detail.draft.status] ?? "new"}>{DRAFT_STATUS[detail.draft.status] ?? detail.draft.status}</StatusPill>
            <span className="text-[15px] text-muted">{sourceName(detail.draft.source)} · {detail.draft.outlet_ids.length === 0 ? "Whole business" : detail.draft.outlet_ids.map(outletName).join(", ")}</span>
          </div>
          <h1 id="draft-title" className="text-[30px]">{draftTitle(detail.draft.command_type)}</h1>
        </header>

        <div>
          {textRows.map(([label, value]) => (
            <div key={label} className="draft-field"><p className="font-semibold">{label}</p><p>{value}</p></div>
          ))}
          {fields.map((f) => (
            <DraftField key={f.path} label={labelOf(f)} value={f.value} edit={edits[f.path] ?? null} editorName={me.name} fmt={fmt} column={f.column} onOpen={open}
              editing={mode === "edit"} onEdit={mode === "edit" ? (v) => setEdits((e) => { const next = { ...e }; if (v === null) delete next[f.path]; else next[f.path] = v; return next; }) : undefined} />
          ))}
        </div>

        {detail.draft.based_on.length > 0 && (
          <div className="space-y-1">
            <p className="font-semibold">Based on</p>
            <ul className="space-y-1">
              {detail.draft.based_on.map((b) => {
                const ref = parseRef(b.ref);
                return (
                  <li key={b.ref}>
                    {templateWords(b.template_id)}:{" "}
                    {ref ? <SourcedValue text={formatCell(b.expected, columnOf(ref), fmt)} refToken={b.ref} onOpen={open} /> : <CannotVerify />}
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

        {gate.kind === "not_for_you" && <p className="font-semibold">{NOT_FOR_YOU}</p>}
        {gate.kind === "untraceable" && <p className="font-semibold">{UNTRACEABLE}</p>}
        {gate.kind === "type_first" && mode !== "reject" && <p className="font-semibold">{NOT_TRACED}</p>}

        {mode === "edit" && (gate.kind === "open" || gate.kind === "type_first") && (
          <div className="space-y-3">
            <label className="grid gap-1 font-semibold">
              Why you changed it
              <textarea value={why} maxLength={500} rows={2} onChange={(e) => setWhy(e.target.value)} disabled={locked} />
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" disabled={locked || !editsReady(gate, edits, why)} onClick={() => void approve(true)}>
                {busy === "edited" ? "Saving…" : `Approve with my edits as ${me.name}`}
              </button>
              <button type="button" className="btn btn-plain" disabled={locked} onClick={() => { setMode("view"); setEdits({}); }}>Cancel</button>
            </div>
          </div>
        )}

        {mode === "reject" && gate.kind !== "closed" && gate.kind !== "not_for_you" && (
          <div className="space-y-3">
            <label className="grid gap-1 font-semibold">
              Why reject it?
              <select value={rejectCode} onChange={(e) => setRejectCode(e.target.value as ReasonCode | "")} disabled={locked}>
                <option value="">Choose a reason</option>
                {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 font-semibold">
              What&apos;s wrong?
              <textarea value={rejectNote} maxLength={500} rows={2} onChange={(e) => setRejectNote(e.target.value)} disabled={locked} />
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" disabled={locked || !rejectCode || rejectNote.trim().length === 0} onClick={() => void reject()}>
                {busy === "reject" ? "Saving…" : `Reject as ${me.name}`}
              </button>
              <button type="button" className="btn btn-plain" disabled={locked} onClick={() => setMode("view")}>Cancel</button>
            </div>
          </div>
        )}

        {mode === "view" && gate.kind !== "closed" && gate.kind !== "not_for_you" && (
          <div className="flex flex-wrap gap-3">
            {gate.kind === "open" && (
              <button type="button" className="btn btn-primary" disabled={locked} onClick={() => void approve(false)}>{busy === "approve" ? "Saving…" : `Approve as ${me.name}`}</button>
            )}
            {(gate.kind === "open" || gate.kind === "type_first") && <button type="button" className="btn btn-plain" disabled={locked} onClick={() => setMode("edit")}>Edit</button>}
            <button type="button" className="btn btn-plain text-danger" disabled={locked} onClick={() => setMode("reject")}>Reject</button>
          </div>
        )}

        {note && <ErrorNote>{note}</ErrorNote>}
        {retryAt !== null && <p className="text-muted" role="status">You can try again in {waitS} s.</p>}
        {result?.type === "purchasing.po.create.v1" && <Link href={`/staff/purchase-orders/${result.entity_id}`} className="btn btn-secondary">Open the purchase order</Link>}
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
  );
}
