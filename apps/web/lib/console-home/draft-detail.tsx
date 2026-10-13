"use client";
// C2 · Draft detail (screens/console-home-inbox-ask.md C2, flows/approval.md). Decide one proposal with its full evidence:
// every payload field is shown (no hidden fields), each proposed number is its ref rendered by RefText (value + chip
// opening the snapshot rows), a person's edit is labelled "Typed by {name}" with its diff. Approve / Reject go through
// core's draft routes as command envelopes; one command_id + idempotency key per intent, resent unchanged on Retry (S-off,
// S-err), so a retry can never apply twice. Core executes under the approver's identity; this screen writes nothing else.
import {
  AbstainBlock, Badge, Button, DraftFrame, IconCheck, IconLock, Input, RefText, RowsDrawer, Sheet, SimulatedBadge, StateError,
  StateLoading, StateOffline, createFormatter, parseMinor, type ResolvedRef,
} from "@munim/ui";
import { parseRef } from "@munim/contracts/shared";
import { uuidv7, type Schemas } from "@munim/sdk";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, newIdempotencyKey } from "../api.ts";
import { useConsole, type Outlet } from "../console/context.tsx";
import { t } from "../i18n/index.ts";
import { outletSubject } from "./inbox.tsx";
import { draftTypeLabel, proposedBy, specialistName } from "./labels.ts";
import { RefValue } from "./ref-value.tsx";

type Detail = Schemas["V1DraftDetail"];
type Draft = Detail["draft"];
type Change = { ref: string; value: string | number | boolean | null; now_ref: string | null; now: string | number | boolean | null };
type DecisionError = { error?: { code?: string; message?: string; reason_code?: string | null }; changes?: Change[] };

export type Me = { id: string | null; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// The same JSON Pointer escaping core uses for resolved_refs paths (approvals/payload.ts).
const seg = (k: string | number) => `/${String(k).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEdit = (v: unknown): v is { value: number; typed_by: string } => isObj(v) && Object.keys(v).length === 2 && "value" in v && "typed_by" in v;
const isRefToken = (v: unknown): v is string => typeof v === "string" && v.startsWith("⟨") && v.endsWith("⟩");
/** Only money leaves are editable here: they parse to minor units through the pack (format.parseMinor). */
const editable = (key: string) => key.endsWith("_minor");

/** A copy of `payload` with the leaf at each pointer replaced by the person's `{value, typed_by}`; every other leaf —
 *  every untouched ref included — is the proposed value unchanged (core refuses a swapped ref). */
export function withEdits(payload: Record<string, unknown>, edits: ReadonlyMap<string, number>, typedBy: string): Record<string, unknown> {
  const walk = (v: unknown, path: string): unknown => {
    if (edits.has(path)) return { value: edits.get(path)!, typed_by: typedBy };
    if (Array.isArray(v)) return v.map((x, i) => walk(x, path + seg(i)));
    if (isObj(v) && !isEdit(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path + seg(k))]));
    return v;
  };
  return walk(payload, "") as Record<string, unknown>;
}

interface Ctx {
  format: { country: string; tz: string };
  resolved: ResolvedRef[];
  outlets: readonly Outlet[];
  names: Readonly<Record<string, string>>;
  me: Me;
  editing: boolean;
  inputs: Record<string, string>;
  setInput: (path: string, text: string) => void;
}

function Leaf({ k, v, path, ctx }: { k: string; v: unknown; path: string; ctx: Ctx }) {
  const fmt = createFormatter(ctx.format);
  if (isRefToken(v)) {
    const chip = <RefValue token={v} resolved={ctx.resolved} format={ctx.format} />;
    if (!ctx.editing || !editable(k)) return chip;
    const text = ctx.inputs[path] ?? "";
    const minor = text.trim() === "" ? null : parseMinor(text, fmt.pack);
    const invalid = text.trim() !== "" && minor === null;
    return (
      <div className="ch-edit" data-edit={path}>
        {chip}
        <Input id={`edit-${path}`} label={k} inputMode="decimal" autoComplete="off" value={text} onChange={(e) => ctx.setInput(path, e.target.value)}
          error={invalid ? t("console.draft.edit_invalid") : undefined} />
        {minor !== null && (
          <div className="ch-diff" data-diff={path}>
            <span>{t("console.draft.diff.was")}</span>{chip}
            <span>{t("console.draft.diff.now", { new: fmt.money(minor) })}</span>
            <Badge tone="info">{t("draft.typed_by", { name: ctx.me.name })}</Badge>
          </div>
        )}
      </div>
    );
  }
  if (isEdit(v)) {
    // A person's typed value is a row value of the draft, labelled as theirs (R26) — formatted, never recomputed.
    const who = ctx.names[v.typed_by] ?? (v.typed_by === ctx.me.id ? ctx.me.name : t("console.draft.someone"));
    return (
      <span className="ch-typed" data-typed="">
        <span className="num">{editable(k) ? fmt.money(v.value) : fmt.number(v.value)}</span>
        <Badge tone="info">{t("draft.typed_by", { name: who })}</Badge>
      </span>
    );
  }
  if (v === null || v === undefined) return <span className="ch-meta">—</span>;
  if (typeof v === "boolean") return <span>{v ? "✓" : "✗"}</span>;
  // By contract every numeric leaf is a ref or a person's edit; a bare number here cannot be traced.
  if (typeof v === "number") return <span className="mu-unverified">{t("common.cannot_verify")}</span>;
  if (typeof v === "string") {
    if (UUID.test(v)) {
      const name = ctx.outlets.find((o) => o.id === v)?.name ?? ctx.names[v];
      return name ? <span title={v} data-uuid="">{name}</span> : <span className="mu-id" data-uuid="">{v}</span>;
    }
    if (ISO_DATE.test(v)) return <span data-date="">{fmt.date(v)}</span>;
    if (ISO_INSTANT.test(v)) return <span data-date="">{fmt.dateTime(v)}</span>;
    // Codes and enum values (basis, currency, unit) read as ids; any other text is plain, so a digit in it stays visible
    // to the payload digit gate (e2e t064-console) instead of hiding inside an id style.
    return /^[A-Za-z_.]+$/.test(v) ? <span className="mu-id">{v}</span> : <span>{v}</span>;
  }
  return <span className="mu-id">{JSON.stringify(v)}</span>;
}

function Value({ k, v, path, ctx }: { k: string; v: unknown; path: string; ctx: Ctx }): ReactNode {
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="ch-meta">—</span>;
    if (v.every((x) => isObj(x) && !isEdit(x))) {
      const cols = [...new Set(v.flatMap((x) => Object.keys(x as object)))];
      return (
        <div className="ch-scroll">
          <table className="mu-table ch-payload-table">
            <thead><tr><th>#</th>{cols.map((c) => <th key={c} className="mu-id">{c}</th>)}</tr></thead>
            <tbody>
              {v.map((row, i) => (
                <tr key={i}>
                  <td className="ch-meta" data-ordinal="">{createFormatter(ctx.format).number(i + 1)}</td>
                  {cols.map((c) => <td key={c}><Value k={c} v={(row as Record<string, unknown>)[c]} path={path + seg(i) + seg(c)} ctx={ctx} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <div className="ch-inline-list">{v.map((x, i) => <Value key={i} k={k} v={x} path={path + seg(i)} ctx={ctx} />)}</div>;
  }
  if (isObj(v) && !isEdit(v)) return <Fields obj={v} path={path} ctx={ctx} />;
  return <Leaf k={k} v={v} path={path} ctx={ctx} />;
}

function Fields({ obj, path, ctx }: { obj: Record<string, unknown>; path: string; ctx: Ctx }) {
  return (
    <dl className="ch-fields">
      {Object.entries(obj).map(([k, v]) => (
        <Fragment key={k}>
          <dt className="mu-id">{k}</dt>
          <dd><Value k={k} v={v} path={path + seg(k)} ctx={ctx} /></dd>
        </Fragment>
      ))}
    </dl>
  );
}

type Load = { status: "loading" } | { status: "missing" } | { status: "error" } | { status: "offline" } | { status: "ok"; detail: Detail };
type Intent = { kind: "approve" | "reject"; body: Record<string, unknown> };
type Phase =
  | { kind: "idle" }
  | { kind: "exec" }
  | { kind: "offline" }
  | { kind: "error"; message: string | null }
  | { kind: "deny"; amount: boolean }
  | { kind: "stale"; changes: Change[] }
  | { kind: "fail"; message: string | null }
  | { kind: "decided" };

function useDraft(id: string) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const reload = useCallback(async (): Promise<void> => {
    try {
      const { data, response } = await api.GET("/v1/drafts/{id}", { params: { path: { id } } });
      if (data) { setLoad({ status: "ok", detail: data }); return; }
      // RLS hides another outlet's or tenant's draft: 404 (gotcha 16), same as an unknown id.
      setLoad(response.status === 404 || response.status === 400 ? { status: "missing" } : { status: "error" });
    } catch {
      setLoad({ status: "offline" });
    }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  return { load, reload };
}

/** The finding behind the draft (WHY), from the inbox the console holds, else core's findings list. */
function useFinding(findingId: string | null) {
  const c = useConsole();
  const held = findingId ? c.inbox?.items.find((i) => i.kind === "finding" && i.finding.finding_id === findingId) : undefined;
  const [fetched, setFetched] = useState<Schemas["V1Finding"] | null>(null);
  useEffect(() => {
    if (!findingId || held) return;
    let live = true;
    void api.GET("/v1/findings", { params: { query: { limit: 100 } } }).then(({ data }) => {
      if (live) setFetched(data?.items.find((f) => f.finding_id === findingId) ?? null);
    }, () => {});
    return () => { live = false; };
  }, [findingId, held]);
  return held?.kind === "finding" ? held.finding : fetched;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ch-section"><h3>{title}</h3>{children}</section>;
}

export function DraftDetail({ draftId, me, names }: { draftId: string; me: Me; names: Readonly<Record<string, string>> }) {
  const { load, reload } = useDraft(draftId);
  if (load.status === "loading") return <StateLoading rows={8} />;
  if (load.status === "missing") return <section className="mu-card" data-state="missing"><p>{t("console.draft.not_found")}</p><Link href="/console/inbox">{t("console.draft.back")}</Link></section>;
  if (load.status === "offline") return <StateOffline onRetry={() => void reload()} />;
  if (load.status === "error") return <StateError onRetry={() => void reload()} />;
  return <DraftDecide detail={load.detail} reload={reload} me={me} names={names} />;
}

/** The loaded draft and its decision controls. Rendering depends only on its props and the console context. */
export function DraftDecide({ detail, reload, me, names }: { detail: Detail; reload: () => Promise<void>; me: Me; names: Readonly<Record<string, string>> }) {
  const c = useConsole();
  const draftId = detail.draft.draft_id;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [intent, setIntent] = useState<Intent | null>(null);
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [drawer, setDrawer] = useState<string | null>(null);
  const finding = useFinding(detail.draft.finding_id);
  const fmt = useMemo(() => createFormatter(c.format), [c.format]);

  const send = useCallback(async (it: Intent) => {
    setIntent(it);
    setPhase({ kind: "exec" });
    const path = { params: { path: { id: draftId } } };
    let res: { data?: unknown; error?: unknown; response: Response };
    try {
      res = it.kind === "approve"
        ? await api.POST("/v1/drafts/{id}:approve", { ...path, body: it.body as never })
        : await api.POST("/v1/drafts/{id}:reject", { ...path, body: it.body as never });
    } catch {
      return setPhase({ kind: "offline" }); // the intent is kept: Retry resends the same command_id and key
    }
    const err = (res.error ?? {}) as DecisionError;
    const code = err.error?.code;
    if (res.data || code === "already_decided") {
      // Only our own success says "Approved by …" / "Rejected."; a decision someone else made first reads D-done
      // "Already decided by {name} at {time}." (flows/approval.md, concurrent decision).
      setIntent(null);
      setPhase({ kind: res.data ? "decided" : "idle" });
      setEditing(false);
      await Promise.all([reload(), c.refreshInbox()]);
      return;
    }
    if (res.response.status === 403) { setIntent(null); return setPhase({ kind: "deny", amount: it.kind === "approve" && (it.body.payload as { edited_payload: unknown }).edited_payload !== null }); }
    if (code === "stale_draft") { setIntent(null); setPhase({ kind: "stale", changes: err.changes ?? [] }); await Promise.all([reload(), c.refreshInbox()]); return; }
    if (code === "execution_failed") { setIntent(null); setPhase({ kind: "fail", message: err.error?.message ?? null }); await Promise.all([reload(), c.refreshInbox()]); return; }
    if (code === "cannot_verify") { setIntent(null); setPhase({ kind: "idle" }); await reload(); return; }
    // 4xx refusals are final for this intent; 5xx keep it so Retry resends the same key.
    if (res.response.status < 500) setIntent(null);
    setPhase({ kind: "error", message: err.error?.message ?? null });
  }, [draftId, reload, c]);

  const d: Draft = detail.draft;
  const decision = detail.decision;
  const type = draftTypeLabel(d.command_type);
  const subject = outletSubject(d.outlet_ids, c.outlets);
  const role = c.member.role;
  const readOnly = role === "advisor";
  // Tenant-wide drafts (outlet_ids = []) are owner-only approvals (contracts DraftView); known up front, so the
  // buttons are hidden, not greyed (README §3 S-deny).
  const ownerOnly = d.outlet_ids.length === 0 && role !== "owner" && role !== "judge";
  const unverified = detail.unverified_refs.length > 0;
  const resolved: ResolvedRef[] = d.resolved_refs.map((r) => ({ ref: r.ref, value: r.value }));
  const edits = new Map<string, number>();
  let editsInvalid = false;
  for (const [p, text] of Object.entries(inputs)) {
    if (text.trim() === "") continue;
    const m = parseMinor(text, fmt.pack);
    if (m === null) editsInvalid = true;
    else edits.set(p, m);
  }
  const ctx: Ctx = { format: c.format, resolved, outlets: c.outlets, names, me, editing, inputs, setInput: (p, v) => setInputs((s) => ({ ...s, [p]: v })) };
  const proposed = d.status === "proposed";
  const canDecide = proposed && !readOnly && !ownerOnly && !["deny", "stale", "fail"].includes(phase.kind);
  const busy = phase.kind === "exec";
  const staleChanges = phase.kind === "stale" ? phase.changes
    : d.status === "stale" ? [...detail.history].reverse().find((h) => h.event === "stale" && h.changes)?.changes ?? [] : [];

  const approve = () => send({
    kind: "approve",
    body: { command_id: uuidv7(), idempotency_key: newIdempotencyKey(), type: "drafts.approve.v1",
      payload: { draft_id: d.draft_id, command_type: d.command_type, edited_payload: null, reason: null } },
  });
  const approveEdited = () => send({
    kind: "approve",
    body: { command_id: uuidv7(), idempotency_key: newIdempotencyKey(), type: "drafts.approve.v1",
      payload: { draft_id: d.draft_id, command_type: d.command_type, edited_payload: withEdits(d.payload, edits, me.id!), reason: note.trim() || null } },
  });
  const reject = () => {
    setRejectOpen(false);
    void send({
      kind: "reject",
      body: { command_id: uuidv7(), idempotency_key: newIdempotencyKey(), type: "drafts.reject.v1", payload: { draft_id: d.draft_id, reason: reason.trim() } },
    });
  };

  const frameState = busy || d.status === "executing" ? "exec" : d.status === "stale" ? "stale" : d.status === "failed" ? "fail" : "pending";
  const decidedBy = decision?.decided_by.name ?? t("console.draft.someone");

  const body = (
    <>
      {finding && (
        <Section title={t("console.draft.why")}>
          <RefText envelope={finding.envelope} resolved={finding.resolved_refs} format={c.format} />
        </Section>
      )}
      {d.command_type === "finance.dispute.draft.v1" && <p className="ch-banner" role="note">{t("console.draft.finance_banner")}</p>}
      {d.command_type.startsWith("purchasing.") && <p className="ch-simulated-line"><SimulatedBadge /></p>}
      <Section title={`${t("console.draft.payload")} (${d.command_type})`}>
        <div data-payload="">
          <Fields obj={d.payload} path="" ctx={ctx} />
        </div>
      </Section>
      {d.based_on.length > 0 && (
        <Section title={t("console.draft.relies_on")}>
          <ul className="ch-relies">
            {d.based_on.map((b) => (
              <li key={b.ref}>
                <span className="mu-id">{b.template_id}</span>
                <RefValue token={b.ref} resolved={[{ ref: b.ref, value: b.expected }]} format={c.format} />
              </li>
            ))}
          </ul>
          <p className="ch-meta">{t("console.draft.relies_on_note")}</p>
        </Section>
      )}
      {d.evidence.length > 0 && (
        <Section title={t("console.draft.evidence")}>
          <div className="ch-inline-list">
            {d.evidence.map((e) => e.startsWith("snap:")
              ? <button key={e} type="button" className="mu-chip" data-mu-chip="evidence" onClick={() => setDrawer(e.slice(5))}>{t("console.draft.open_rows")}</button>
              : <span key={e} className="mu-chip" data-kind="source">{t("common.ref.source")}</span>)}
          </div>
          <RowsDrawer target={drawer ? { snapshot_id: drawer } : null} format={c.format} onClose={() => setDrawer(null)} />
        </Section>
      )}
    </>
  );

  return (
    <article className="ch-draft" data-draft-status={d.status} data-phase={phase.kind}>
      <header className="ch-page-head">
        <Link href="/console/inbox" className="ch-back">{t("console.draft.back")}</Link>
        <h1>{[type, subject].filter(Boolean).join(" · ")}</h1>
        <p className="ch-meta">{t("console.draft.proposed_at", { who: proposedBy(d.source), time: fmt.dateTime(d.created_at) })}</p>
      </header>

      {readOnly && <p className="ch-banner" role="note" data-banner="read-only"><IconLock size={18} />{t("console.home.read_only")}</p>}

      {decision && (d.status === "executed" || d.status === "rejected") && (
        <div className="ch-outcome" role="status" data-state="D-done" data-verdict={decision.verdict}>
          <IconCheck />
          <div>
            <p>
              {phase.kind === "decided"
                ? decision.verdict === "rejected"
                  ? t("console.draft.rejected", { specialist: d.source.startsWith("intel:") ? specialistName(d.source.slice(6)) : type })
                  : decision.verdict === "edited"
                    ? `${t("console.draft.approved_edited")} ${t("console.draft.approved", { name: decidedBy, time: fmt.dateTime(decision.decided_at) })}`
                    : t("console.draft.approved", { name: decidedBy, time: fmt.dateTime(decision.decided_at) })
                : t("draft.state.done", { name: decidedBy, time: fmt.dateTime(decision.decided_at) })}
            </p>
            <p className="ch-meta">
              <Badge tone={decision.verdict === "rejected" ? "danger" : "success"}>{t(`console.draft.verdict.${decision.verdict}`)}</Badge>
              {decision.reason !== null && <> {t("console.draft.decision.reason", { reason: decision.reason })}</>}
            </p>
          </div>
        </div>
      )}

      {(d.status === "stale" || phase.kind === "stale") && (
        <div className="ch-outcome" role="status" data-state="D-stale">
          <div>
            <p>{t("draft.state.stale")}</p>
            {staleChanges.length > 0 && (
              <>
                <p className="ch-meta">{t("console.draft.stale.changed")}</p>
                <ul className="ch-relies">
                  {staleChanges.map((ch) => (
                    <li key={ch.ref}>
                      <span>{t("console.draft.diff.was")}</span>
                      <RefValue token={ch.ref} resolved={[{ ref: ch.ref, value: ch.value }]} format={c.format} />
                      <span>→</span>
                      {ch.now_ref ? <RefValue token={ch.now_ref} resolved={[{ ref: ch.now_ref, value: ch.now }]} format={c.format} /> : <span className="mu-unverified">{t("common.cannot_verify")}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {(d.status === "failed" || phase.kind === "fail") && (
        <div className="ch-outcome" role="alert" data-state="D-fail">
          <p>{t("draft.state.fail")}</p>
          {phase.kind === "fail" && phase.message && phase.message !== t("draft.state.fail") && <p className="ch-meta">{phase.message}</p>}
        </div>
      )}

      {proposed || busy ? <DraftFrame state={frameState}>{body}</DraftFrame> : <section className="mu-card">{body}</section>}

      {unverified && proposed && (
        <AbstainBlock reasonCode="unresolved_ref" format={c.format} checked={detail.unverified_refs.map((r) => { const p = parseRef(r); return { token: r, snapshot_id: p?.kind === "snap" ? p.snapshot_id : null }; })} />
      )}
      {unverified && proposed && <p className="ch-banner" role="note" data-state="S-abst">{t("console.draft.abst")}</p>}

      {proposed && ownerOnly && !readOnly && (
        <div className="mu-state" data-state="deny" role="note"><IconLock /><div className="mu-state-body"><p>{t("console.draft.deny", { type })}</p></div></div>
      )}
      {phase.kind === "deny" && (
        <div className="mu-state" data-state="deny" role="alert"><IconLock /><div className="mu-state-body"><p>{phase.amount ? t("console.draft.deny_amount") : t("console.draft.deny", { type })}</p></div></div>
      )}
      {phase.kind === "offline" && intent && <StateOffline onRetry={() => void send(intent)} />}
      {phase.kind === "error" && (intent
        ? <StateError {...(phase.message ? { detail: phase.message } : {})} onRetry={() => void send(intent)} />
        : <StateError {...(phase.message ? { detail: phase.message } : {})} />)}

      {canDecide && (
        <div className="ch-decide" data-decide="">
          {editing ? (
            <>
              <Input id="edit-note" label={t("console.draft.edit_note")} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
              <div className="ch-decide-row">
                <Button variant="ghost" onClick={() => { setEditing(false); setInputs({}); setNote(""); }} disabled={busy}>{t("console.draft.cancel_edit")}</Button>
                <Button variant="primary" busy={busy} disabled={edits.size === 0 || editsInvalid || unverified} onClick={() => void approveEdited()}>{t("console.draft.approve_edited")}</Button>
              </div>
            </>
          ) : (
            <div className="ch-decide-row">
              <Button variant="danger" onClick={() => { setReason(""); setRejectOpen(true); }} disabled={busy}>{t("console.draft.reject")}</Button>
              {me.id && !unverified && resolved.some((r) => /_minor⟩$/.test(r.ref)) && (
                <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>{t("console.draft.edit")}</Button>
              )}
              {!unverified && <Button variant="primary" busy={busy} onClick={() => void approve()}>{t("console.draft.approve")}</Button>}
            </div>
          )}
        </div>
      )}

      <Sheet open={rejectOpen} onClose={() => setRejectOpen(false)} title={t("console.draft.reject.title")} side="bottom">
        <form className="ch-reject" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) reject(); }}>
          <label htmlFor="reject-reason">{t("console.draft.reject.label")}</label>
          <textarea id="reject-reason" className="mu-input ch-textarea" required maxLength={500} rows={3} value={reason}
            aria-describedby="reject-hint" onChange={(e) => setReason(e.target.value)} />
          <span id="reject-hint" className="mu-field-hint">{t("console.draft.reject.hint")}</span>
          <Button type="submit" variant="danger" disabled={reason.trim().length === 0 || reason.length > 500}>{t("console.draft.reject.confirm")}</Button>
        </form>
      </Sheet>
    </article>
  );
}
