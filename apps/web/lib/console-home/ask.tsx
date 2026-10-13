"use client";
// C3 · Ask (screens/console-home-inbox-ask.md C3; R45 F9). Ask anyone, or a specialist with a leading "@Name" — core
// parses the address, runs the ask, validates the envelope and composes the signature "{Specialist} · via Manager";
// this screen only renders what core stored: the answer through RefText (every number a snapshot chip), or the
// "Cannot verify" block with no partial answer. The question and any model text are React text nodes only.
import { SPECIALIST_REGISTRY } from "@munim/contracts/intel";
import { anyRefTokens, parseRef } from "@munim/contracts/shared";
import { AbstainBlock, Button, RefText, RowsDrawer, StateEmpty, createFormatter, type Checked } from "@munim/ui";
import type { Schemas } from "@munim/sdk";
import { useMemo, useState } from "react";
import { api } from "../api.ts";
import { useConsole } from "../console/context.tsx";
import { t } from "../i18n/index.ts";
import { signatureText, specialistName } from "./labels.ts";

type AskResponse = Schemas["V1AskResponse"];
type Turn = { question: string; answer: AskResponse["answer"] };
type Phase = { kind: "idle" } | { kind: "loading" } | { kind: "offline"; question: string; deep: boolean } | { kind: "error"; question: string; deep: boolean } | { kind: "aioff" };

// Questions whose router reply is recorded (services/intel/munim_intel/decide/fixtures, IN restaurant), word for word:
// a fixture is keyed by the exact question text, so these route as recorded instead of falling to the unrecorded path.
const SUGGESTIONS = ["console.ask.suggest.food_cost", "console.ask.suggest.payouts", "console.ask.suggest.short_payout"] as const;
// The eight F8 specialists, addressed by their first alias (core matches it case-insensitively after the "@").
const SPECIALISTS = SPECIALIST_REGISTRY.specialists.filter((s) => s.kind === "specialist").map((s) => ({ id: s.id, alias: s.aliases[0]! }));

/** Distinct snapshot ids an answer cites (the "Sources" list; its length is the "Checked: {n} sources" count). */
export function sourcesOf(answer: AskResponse["answer"]): string[] {
  const ids = new Set<string>();
  for (const r of answer.resolved_refs) {
    const m = /^⟨snap:([0-9a-f-]{36})·/.exec(r.ref);
    if (m) ids.add(m[1]!);
  }
  return [...ids];
}

/** What an abstained answer tried: every ref token in its text plus every bare ref id in its segments' `refs`, once. */
export function checkedOf(envelope: AskResponse["answer"]["envelope"]): Checked[] {
  const out = new Map<string, Checked>();
  for (const seg of envelope.segments) {
    for (const [token] of seg.text.matchAll(anyRefTokens())) {
      const p = parseRef(token);
      if (p) out.set(token, { token, snapshot_id: p.kind === "snap" ? p.snapshot_id : null });
    }
    for (const id of seg.refs) out.set(id, { token: id, snapshot_id: id.startsWith("snap:") ? id.slice(5) : null });
  }
  return [...out.values()];
}

export function AnswerView({ turn }: { turn: Turn }) {
  const c = useConsole();
  const fmt = useMemo(() => createFormatter(c.format), [c.format]);
  const [open, setOpen] = useState<string | null>(null);
  const a = turn.answer;
  const sources = sourcesOf(a);
  return (
    <li className="ch-turn" data-turn="" data-abstained={a.envelope.abstained || undefined}>
      <p className="ch-question"><span className="ch-meta">{t("console.ask.you")}</span> {turn.question}</p>
      <div className="ch-answer" data-answer={a.answer_id}>
        <p className="ch-signature" data-signature={a.signature.specialist}>{signatureText(a.signature)}</p>
        {a.envelope.abstained ? <Abstained envelope={a.envelope} /> : <RefText envelope={a.envelope} resolved={a.resolved_refs} format={c.format} />}
        {!a.envelope.abstained && sources.length > 0 && (
          <div className="ch-sources">
            <span className="ch-meta">{t("console.ask.checked", { n: fmt.number(sources.length) })}</span>
            <span className="ch-meta">{t("console.ask.sources")}</span>
            {sources.map((id) => (
              <button key={id} type="button" className="mu-chip" data-mu-chip="source-rows" onClick={() => setOpen(id)}>{t("common.ref.snapshot")}</button>
            ))}
            <RowsDrawer target={open ? { snapshot_id: open } : null} format={c.format} onClose={() => setOpen(null)} />
          </div>
        )}
      </div>
    </li>
  );
}

/** S-abst: "Cannot verify: …" (core's reason code) and "What was checked" — the refs it tried, or, when the envelope
 *  names none, a plain line saying no source was found. No partial answer. */
function Abstained({ envelope }: { envelope: AskResponse["answer"]["envelope"] }) {
  const c = useConsole();
  const checked = checkedOf(envelope);
  return (
    <div className="ch-abstained">
      <AbstainBlock reasonCode={envelope.reason_code ?? "other"} checked={checked} format={c.format} />
      {checked.length === 0 && (
        <p className="ch-checked-none" data-checked="none"><strong>{t("abstain.checked")}</strong> {t("console.ask.checked_none")}</p>
      )}
    </div>
  );
}

export function AskView() {
  const c = useConsole();
  const [question, setQuestion] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  if (!c.aiEnabled || phase.kind === "aioff") {
    return <section className="mu-card" data-state="aioff"><p>{t("console.ask.aioff")}</p></section>;
  }

  const ask = async (q: string, deep = false) => {
    const text = q.trim();
    if (!text) return;
    setPhase({ kind: "loading" });
    let res: { data?: AskResponse; error?: unknown; response: Response };
    try {
      res = await api.POST("/v1/ask", { body: { question: text, ...(threadId ? { thread_id: threadId } : {}), ...(deep ? { deep: true } : {}) } });
    } catch {
      return setPhase({ kind: "offline", question: text, deep });
    }
    if (res.data) {
      setThreadId(res.data.thread_id);
      setTurns((ts) => [...ts, { question: text, answer: res.data!.answer }]);
      setQuestion("");
      return setPhase({ kind: "idle" });
    }
    const code = (res.error as { error?: { code?: string } } | undefined)?.error?.code;
    // Only an explicit AI-off refusal switches Ask off (rule 11). A plain 503 `unavailable` is also what core answers for
    // any failed intel call — a recorded-fixture miss included (threads/index.ts) — so it is S-err with Try again.
    const reason = (res.error as { error?: { reason_code?: string | null } } | undefined)?.error?.reason_code;
    if (code === "model_blocked" || reason === "model_blocked") {
      c.setAiOff();
      return setPhase({ kind: "aioff" });
    }
    setPhase({ kind: "error", question: text, deep });
  };

  const last = turns[turns.length - 1];
  return (
    <div className="ch-ask">
      <form className="ch-ask-form" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <label htmlFor="ask-q" className="mu-visually-hidden">{t("console.ask.label")}</label>
        <input id="ask-q" className="mu-input ch-ask-input" type="text" value={question} maxLength={2000} autoComplete="off"
          placeholder={t("console.ask.suggest.food_cost")} onChange={(e) => setQuestion(e.target.value)} />
        <Button type="submit" variant="primary" busy={phase.kind === "loading"} disabled={!question.trim()}>{t("console.ask.submit")}</Button>
        {turns.length > 0 && <Button variant="ghost" onClick={() => { setTurns([]); setThreadId(null); setPhase({ kind: "idle" }); }}>{t("console.ask.new")}</Button>}
      </form>

      <div className="ch-ask-picks">
        <span className="ch-meta">{t("console.ask.specialists")}</span>
        {SPECIALISTS.map((s) => (
          <Button key={s.id} size="sm" variant="ghost" onClick={() => setQuestion(`@${s.alias} `)}>@{specialistName(s.id)}</Button>
        ))}
      </div>

      {turns.length === 0 && phase.kind !== "loading" && (
        <StateEmpty message={t("console.ask.empty")} action={
          <div className="ch-ask-picks">
            {SUGGESTIONS.map((k) => <Button key={k} variant="secondary" onClick={() => void ask(t(k))}>{t(k)}</Button>)}
          </div>
        } />
      )}

      {turns.length > 0 && <ol className="ch-turns" aria-live="polite">{turns.map((tn) => <AnswerView key={tn.answer.answer_id} turn={tn} />)}</ol>}

      {phase.kind === "loading" && <p className="ch-loading" role="status" data-state="load"><span className="mu-spinner" aria-hidden="true" />{t("console.ask.loading")}</p>}
      {phase.kind === "offline" && (
        <div className="mu-state" data-state="off" role="alert">
          <div className="mu-state-body"><p>{t("console.ask.off")}</p>
            <Button onClick={() => void ask(phase.question, phase.deep)}>{t("common.action.retry")}</Button></div>
        </div>
      )}
      {phase.kind === "error" && (
        <div className="mu-state" data-state="err" role="alert">
          <div className="mu-state-body"><p>{t("console.ask.err")}</p>
            <Button onClick={() => void ask(phase.question, phase.deep)}>{t("common.action.try_again")}</Button></div>
        </div>
      )}
      {last && last.answer.envelope.follow_up === "dig_deeper" && phase.kind === "idle" && (
        <Button variant="secondary" onClick={() => void ask(last.question, true)}>{t("console.ask.dig_deeper")}</Button>
      )}
    </div>
  );
}
