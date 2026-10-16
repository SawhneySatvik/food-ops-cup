// file: components/staff/pages/ask.tsx
"use client";
// /staff/ask and /staff/ask/[threadId]: Ask Munim. A question goes to the Manager, or to a specialist named by a
// leading "@Name"; the answer's every number is a snapshot cell with its source chip, or "Cannot verify"; an answer
// Munim could not trace is an honest abstention. POST /v1/ask returns only when the answer is stored (up to about
// 90 s) and gives no run id to follow, so the screen shows a waiting state, then the answer, then refetches. A lost
// request is looked for, never resent. A 503 hides the ask box and keeps past answers readable.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useCountdown, useOnline } from "@/lib/hooks";
import { addressee, findLostAnswer, pickable, QUESTION_MAX, signatureWords, withMention, type Specialist, type Thread, type ThreadItem, type Turn } from "@/lib/munim/ask";
import type { MunimError } from "@/lib/munim/client";
import { formatWhen } from "@/lib/munim/format";
import type { CellFormat } from "@/lib/munim/refs";
import { abstainText, specialistName, staffErrorText } from "@/lib/munim/staff-copy";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { useStaff } from "../shell";
import { AiSegment, CannotVerify, SnapshotDrawer } from "../source";
import { ErrorNote, FullPage, OfflineBanner } from "../../ui";

type OpenRef = (snapshotId: string, refToken: string) => void;

const LOST = "The connection dropped before the answer arrived. Munim may still be answering: tap Refresh in a minute before you ask again.";
const TAINTED = "This answer also read text from outside your books, such as a supplier's message. Its numbers still come only from your books.";
const STAFF_NUMBERS = "Some numbers are shown only to managers and owners. Where you see Cannot verify, ask one of them.";
/** How many listed threads get their first question fetched for the list (the list item carries none). */
const PREVIEWS = 20;

function TurnBlock({ turn, mine, fmt, onOpen, onDeeper }: { turn: Turn; mine: boolean; fmt: CellFormat; onOpen: OpenRef; onDeeper: ((question: string) => void) | null }) {
  const a = turn.answer;
  return (
    <li className="space-y-2">
      <div className="ml-auto max-w-[70ch] rounded-card border-[1.5px] border-line bg-bg-deep p-4">
        <p className="text-[14px] font-semibold text-muted">
          {mine ? "You asked" : "A teammate asked"}{turn.addressed_to ? ` · to ${specialistName(turn.addressed_to)}` : ""}
        </p>
        <p className="whitespace-pre-wrap">{turn.question ?? "The question wasn't stored."}</p>
      </div>
      {a === null ? (
        <div className="card p-5"><p><CannotVerify /> No answer is stored for this question.</p></div>
      ) : (
        <div className="card space-y-2 p-5">
          <p className="text-[15px] font-semibold text-muted">{signatureWords(a.signature)}</p>
          {a.envelope.abstained
            ? <p><CannotVerify /> {abstainText(a.envelope.reason_code)}</p>
            : a.envelope.segments.map((s, i) => <AiSegment key={i} segment={s} resolved={a.resolved_refs} fmt={fmt} onOpen={onOpen} />)}
          {turn.tainted && <p className="text-[14px] text-muted">{TAINTED}</p>}
          {onDeeper && a.envelope.follow_up === "dig_deeper" && turn.question && (
            <button type="button" className="btn btn-plain" onClick={() => onDeeper(turn.question!)}>Dig deeper across specialists</button>
          )}
        </div>
      )}
    </li>
  );
}

export function AskPage() {
  const params = useParams<{ threadId?: string }>();
  const threadId = params.threadId ?? null;
  const router = useRouter();
  const { session, client, outlet, handleAuth } = useStaff();
  const me = session.me;
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [specialists, setSpecialists] = useState<Specialist[]>([]);
  const [threads, setThreads] = useState<ThreadItem[] | null>(null);
  const [olderHidden, setOlderHidden] = useState(false);
  const [firstQ, setFirstQ] = useState<Map<string, string | null>>(new Map());
  const [listError, setListError] = useState<MunimError | null>(null);
  const [thread, setThread] = useState<Thread | "not_found" | null>(null);
  const [threadError, setThreadError] = useState<MunimError | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ question: string; since: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [aiOff, setAiOff] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const online = useOnline();
  const waitS = useCountdown(retryAt, () => setRetryAt(null));
  const valid = threadId === null || UUID7.test(threadId);

  const loadThreads = useCallback(async () => {
    const r = await client.listThreads();
    if (!r.ok) {
      if (!handleAuth(r.error)) setListError(r.error);
      return;
    }
    setListError(null);
    setThreads(r.data.items);
    setOlderHidden(r.data.next_cursor !== null);
    // The list item has no question text: read each listed thread's first question (plain text, the person's own).
    const shown = r.data.items.slice(0, PREVIEWS);
    const firsts = await Promise.all(shown.map((t) => client.getThread(t.thread_id)));
    setFirstQ(new Map(shown.map((t, i) => {
      const f = firsts[i]!;
      return [t.thread_id, f.ok ? (f.data.turns[0]?.question ?? null) : null] as const;
    })));
  }, [client, handleAuth]);

  const loadThread = useCallback(async () => {
    if (!threadId || !UUID7.test(threadId)) return;
    const r = await client.getThread(threadId);
    if (r.ok) {
      setThread(r.data);
      setThreadError(null);
    } else if (!handleAuth(r.error)) {
      if (r.error.kind === "not_found") setThread("not_found");
      else setThreadError(r.error);
    }
  }, [client, threadId, handleAuth]);

  useEffect(() => {
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
    void client.listSpecialists().then((r) => r.ok && setSpecialists(pickable(r.data.items)));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void loadThreads();
  }, [client, loadThreads]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new thread: clear the last one's state, then fetch
    setThread(null);
    setNote(null);
    void loadThread();
  }, [loadThread]);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - pending.since) / 1000)), 1000);
    return () => clearInterval(t);
  }, [pending]);

  const current = thread && thread !== "not_found" ? thread : null;

  const send = async (raw: string, deep = false) => {
    const question = raw.trim();
    // A first question needs the list as it was before sending, so a lost answer can be found (findLostAnswer).
    if (!question || question.length > QUESTION_MAX || pending || (threadId === null && threads === null)) return;
    const turnsBefore = current?.turns.length ?? 0;
    const before = new Set((threads ?? []).map((t) => t.thread_id));
    setPending({ question, since: Date.now() });
    setElapsed(0);
    setNote(null);
    const r = await client.ask(threadId ? { question, thread_id: threadId, ...(deep ? { deep: true } : {}) } : { question });
    if (r.ok) {
      setPending(null);
      setText("");
      if (!threadId) router.push(`/staff/ask/${r.data.thread_id}`);
      else await loadThread();
      void loadThreads();
      return;
    }
    if (handleAuth(r.error)) return setPending(null);
    if (r.error.kind === "network" || r.error.status === 504) {
      // Lost on the way back, timed out, or cut by a gateway while core was still waiting for intel: look for it, never resend.
      const found = await findLostAnswer(client, me.member_id, threadId, turnsBefore, before);
      setPending(null);
      if (found && !threadId) router.push(`/staff/ask/${found}`);
      else if (found) await loadThread();
      else setNote(LOST);
      if (found) setText("");
      void loadThreads();
      return;
    }
    setPending(null);
    if (r.error.status === 503) return setAiOff(true); // AI unavailable: hide the ask box, never an error state
    if (r.error.kind === "rate_limited") setRetryAt(Date.now() + (r.error.retryAfterMs ?? 5000));
    if (r.error.kind === "not_found") return setThread("not_found");
    setNote(staffErrorText(r.error, "ask"));
  };

  if (!valid || thread === "not_found") {
    return (
      <FullPage title="Not found." action={<Link href="/staff/ask" className="btn btn-primary">All questions</Link>}>
        <p>It may have been removed, or it isn&apos;t in your outlets.</p>
      </FullPage>
    );
  }

  const tz = outlet?.tz ?? tenant?.home_tz ?? "UTC";
  const fmt: CellFormat | null = tenant ? { locale: SITE.locale, currency: tenant.base_currency } : null;
  const open: OpenRef = (snapshotId, refToken) => setDrawer({ snapshotId, refToken });
  const to = addressee(text, specialists, current?.specialist ?? null);
  const tooLong = text.trim().length > QUESTION_MAX;
  const listBlocks = threadId === null && threads === null;
  const canSend = !!text.trim() && !tooLong && !pending && online && !aiOff && retryAt === null && !listBlocks;
  const lastTurn = current?.turns[current.turns.length - 1] ?? null;

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="wrap staff-main space-y-4">
        <h1 className="section-title">Ask Munim</h1>
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside aria-labelledby="threads-title" className={`order-2 space-y-3 lg:order-1 ${threadId ? "hidden lg:block" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <h2 id="threads-title" className="text-[22px]">Your questions</h2>
              <button type="button" className="btn btn-plain" onClick={() => void loadThreads()}>Refresh</button>
            </div>
            {threadId && <Link href="/staff/ask" className="btn btn-secondary">New question</Link>}
            {listError && threads === null && <ErrorNote>{staffErrorText(listError, "ask")}</ErrorNote>}
            {threads === null && !listError && <div className="skeleton h-40" role="status" aria-label="Loading" />}
            {threads && threads.length === 0 && <div className="state-box"><p>Ask about your sales, stock, kitchen or staff.</p></div>}
            {threads && threads.length > 0 && (
              <ul className="grid gap-2">
                {threads.map((t) => (
                  <li key={t.thread_id}>
                    <Link href={`/staff/ask/${t.thread_id}`} aria-current={t.thread_id === threadId ? "page" : undefined} className="card card-link grid gap-1 p-4 no-underline">
                      <span className="font-semibold">{specialistName(t.specialist)}</span>
                      {firstQ.get(t.thread_id) && <span className="line-clamp-2">{firstQ.get(t.thread_id)}</span>}
                      <span className="text-[14px] text-muted">{t.created_by === me.member_id ? "" : "Started by a teammate · "}{formatWhen(t.updated_at, tz, SITE.locale)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {olderHidden && <p className="text-[14px] text-muted">Older questions aren&apos;t listed here yet.</p>}
          </aside>

          <section aria-label="Conversation" className="order-1 space-y-4 lg:order-2">
            {threadId && <Link href="/staff/ask" className="btn btn-plain lg:hidden">← All questions</Link>}
            {me.role === "staff" && <p className="text-[15px] text-muted">{STAFF_NUMBERS}</p>}
            {threadError && !current && (
              <div className="space-y-2">
                <ErrorNote>{staffErrorText(threadError, "ask")}</ErrorNote>
                <button type="button" className="btn btn-plain" onClick={() => void loadThread()}>Try again</button>
              </div>
            )}
            {threadId && !current && !threadError && <div className="skeleton h-48" role="status" aria-label="Loading" />}
            {current && fmt && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{current.specialist ? `A conversation with ${specialistName(current.specialist)}` : "A conversation with the Manager"}</p>
                  <button type="button" className="btn btn-plain" onClick={() => void loadThread()}>Refresh</button>
                </div>
                <ol className="space-y-5">
                  {current.turns.map((t) => (
                    <TurnBlock key={t.turn_id} turn={t} mine={t.member_id === me.member_id} fmt={fmt} onOpen={open}
                      onDeeper={t === lastTurn && !pending && !aiOff ? (q) => void send(q, true) : null} />
                  ))}
                </ol>
              </>
            )}

            {pending && (
              <div className="space-y-2">
                <div className="ml-auto max-w-[70ch] rounded-card border-[1.5px] border-line bg-bg-deep p-4">
                  <p className="text-[14px] font-semibold text-muted">You asked</p>
                  <p className="whitespace-pre-wrap">{pending.question}</p>
                </div>
                <div className="card p-5">
                  <p className="font-semibold" role="status">Munim is reading your books…</p>
                  <p className="text-muted"><span aria-hidden="true">{elapsed} s · </span>Answers can take up to a minute and a half. Asking never changes your books.</p>
                </div>
              </div>
            )}

            {aiOff ? (
              <p className="text-muted">Munim can&apos;t answer right now. Past answers are still here.</p>
            ) : (
              <form className="card space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
                <label className="grid gap-1 font-semibold">
                  {threadId ? "Ask a follow-up" : "Your question"}
                  <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="How did the cake tickets go this week?" disabled={pending !== null} />
                </label>
                {specialists.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] text-muted">Ask a specialist:</span>
                    {specialists.map((s) => (
                      <button key={s.id} type="button" className="chip" aria-label={`Ask ${specialistName(s.id)}`} disabled={pending !== null} onClick={() => setText((q) => withMention(q, s))}>
                        @{specialistName(s.id)}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[15px] text-muted">
                  {to.unknown ? `No specialist is called “@${to.unknown}”, so ${specialistName(to.to === "manager" ? null : to.to)} will answer.` : `To: ${specialistName(to.to === "manager" ? null : to.to)}`}
                  {text.trim().length > QUESTION_MAX - 200 && ` · ${text.trim().length} / ${QUESTION_MAX}`}
                </p>
                {tooLong && <ErrorNote>That question is too long. Keep it under {QUESTION_MAX} characters.</ErrorNote>}
                {note && <ErrorNote>{note}</ErrorNote>}
                {listBlocks && listError && (
                  <div className="flex flex-wrap items-center gap-3">
                    <ErrorNote>{staffErrorText(listError, "ask")}</ErrorNote>
                    <button type="button" className="btn btn-plain" onClick={() => void loadThreads()}>Try again</button>
                  </div>
                )}
                {retryAt !== null && <p className="text-muted" role="status">You can ask again in {waitS} s.</p>}
                <button type="submit" className="btn btn-primary" disabled={!canSend}>{pending ? "Asking…" : "Ask"}</button>
              </form>
            )}
          </section>
        </div>
        {fmt && <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />}
      </main>
    </>
  );
}
