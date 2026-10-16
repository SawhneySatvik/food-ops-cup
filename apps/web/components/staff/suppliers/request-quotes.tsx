"use client";
// "Request quotes" on an ingredient that is running low (owner home's Low stock, the suppliers screen's Running low). The
// person picks outlets from their own scope and asks the simulated suppliers to quote it (purchasing.rfq.request.v1). No
// quantity is typed: core reads the shortfall itself, and a purchase order comes back only as a draft a person approves.
// The negotiation runs while the person waits; what came of it is said in plain words, with the draft one tap away.
// A lost answer keeps the same envelope (a second tap is a replay, never a second negotiation); after an answer or a
// refusal, the next tap is a new request.
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { useCountdown } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { retryable } from "@/lib/munim/commands";
import type { StaffClient } from "@/lib/munim/staff";
import { rfqAttempt, rfqErrorText, rfqOutcome, type RfqAttempt, type RfqOutcome } from "@/lib/munim/supply-flow";
import { ErrorNote } from "../../ui";
import { SimulatedSupplier } from "../source";

export function RequestQuotes({ ingredientId, ingredientName, outlets, current, client, onAuth }: {
  ingredientId: string;
  ingredientName: string;
  /** The outlets in the person's scope (the only ones offered). */
  outlets: readonly { id: string; name: string }[];
  /** The outlet the screen shows, chosen to start with. */
  current: string;
  client: StaffClient;
  onAuth: (e: MunimError) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([current]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RfqOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const wait = useCountdown(retryAt, () => setRetryAt(null));
  const attempt = useRef<RfqAttempt | null>(null);
  const id = useId();

  const pick = (outletId: string, on: boolean) => {
    setChosen((c) => (on ? [...c, outletId] : c.filter((x) => x !== outletId)));
    setOutcome(null);
    setError(null);
  };

  const send = async () => {
    if (busy || chosen.length === 0) return;
    const a = rfqAttempt(attempt.current, ingredientId, chosen);
    attempt.current = a;
    setBusy(true);
    setOutcome(null);
    setError(null);
    const r = await client.requestQuotes(a.body);
    setBusy(false);
    if (r.result.ok) {
      attempt.current = null;
      setOutcome(rfqOutcome(r.negotiation, r.draftId));
      return;
    }
    const e = r.result.error;
    if (onAuth(e)) return;
    // 503: core recorded the request but never reached the negotiation, so the same envelope would only replay it.
    if (!retryable(e) || e.status === 503) attempt.current = null;
    setError(rfqErrorText(e));
    if (e.retryAfterMs) setRetryAt(Date.now() + e.retryAfterMs);
  };

  if (!open) return <button type="button" className="btn btn-plain" onClick={() => setOpen(true)}>Request quotes</button>;
  return (
    <div className="card w-full space-y-3 p-4" role="group" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="font-semibold">Ask the simulated suppliers to quote {ingredientName}</p>
      <p className="text-[15px] text-muted">
        <SimulatedSupplier /> Only simulated suppliers are asked; nothing goes to a real business. Munim works out how much is short, and a
        purchase order comes back as a draft for a person to approve.
      </p>
      <fieldset className="space-y-2" disabled={busy}>
        <legend className="mb-1 text-[15px] font-semibold">For</legend>
        {outlets.map((o) => (
          <label key={o.id} className="choice">
            <input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => pick(o.id, e.target.checked)} />
            <span>{o.name}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={busy || chosen.length === 0 || retryAt !== null} onClick={() => void send()}>
          {busy ? "Asking…" : outcome ? "Ask again" : "Send request"}
        </button>
        <button type="button" className="btn btn-plain" disabled={busy} onClick={() => setOpen(false)}>Close</button>
      </div>
      {chosen.length === 0 && <p className="text-muted">Choose at least one outlet.</p>}
      {busy && <p className="text-muted" role="status">The simulated suppliers are quoting. This can take a minute.</p>}
      {outcome && (
        <p className="font-semibold" role="status">
          {outcome.text}{" "}
          {outcome.draftId ? <Link href={`/staff/inbox/${outcome.draftId}`}>Open the purchase order draft</Link>
            : outcome.inbox ? <Link href="/staff/inbox">Open the inbox</Link> : null}
        </p>
      )}
      {error && <ErrorNote>{error}{retryAt !== null ? ` You can ask again in ${wait} s.` : ""}</ErrorNote>}
    </div>
  );
}
