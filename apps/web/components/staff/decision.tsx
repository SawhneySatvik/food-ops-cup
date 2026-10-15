// file: components/staff/decision.tsx
"use client";
// The action bar of an AI draft card (02 §5), shared by the Cares listing card (14) and the purchase-order card (15):
// approve as proposed, edit then approve with my edits, or reject with a reason. Every button names the person;
// nothing happens without a tap; one attempt per thing confirmed, so a double tap or a retry never sends two decisions.
import { useRef, useState } from "react";
import { useCountdown } from "@/lib/hooks";
import type { Result } from "@/lib/munim/client";
import { approveAttempt, outcomeOf, rejectAttempt, type ApproveAttempt, type EditedPayload, type Outcome, type RejectAttempt, type RejectCode } from "@/lib/munim/draft-decision";
import type { StaffClient } from "@/lib/munim/staff";
import { REJECT_REASONS, staffErrorText, type StaffWhere } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { ErrorNote } from "../ui";

type Sent = Result<Schemas["CommandResult"]>;

/** Sends the decisions for one draft. `onOutcome` gets every settled answer; a retryable failure stays here, with
 *  "Try again" resending the same envelope. */
export function useDecision(client: StaffClient, draft: { draft_id: string; command_type: string }, where: StaffWhere, onOutcome: (o: Outcome) => void) {
  const approveRef = useRef<ApproveAttempt | null>(null);
  const rejectRef = useRef<RejectAttempt | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const wait = useCountdown(retryAt, () => setRetryAt(null));

  const run = async (which: "approve" | "reject", send: () => Promise<Sent>, clear: () => void, again: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(which);
    setError(null);
    setRetry(null);
    const o = outcomeOf(await send());
    inFlight.current = false;
    setBusy(null);
    if (o.kind === "retry") {
      setError(staffErrorText(o.error, where));
      setRetry(() => again);
      if (o.error.retryAfterMs) setRetryAt(Date.now() + o.error.retryAfterMs);
      return;
    }
    clear();
    if (o.kind === "failed_to_apply" || o.kind === "refused") setError(staffErrorText(o.error, where));
    onOutcome(o);
  };

  const approve = (edited: EditedPayload | null, reason: string | null): void => {
    void run("approve", () => {
      const a = approveAttempt(approveRef.current, draft, edited, reason);
      approveRef.current = a;
      return client.approveDraft(draft.draft_id, a.body);
    }, () => { approveRef.current = null; }, () => approve(edited, reason));
  };
  const reject = (code: RejectCode, note: string): void => {
    void run("reject", () => {
      const a = rejectAttempt(rejectRef.current, draft.draft_id, code, note);
      rejectRef.current = a;
      return client.rejectDraft(draft.draft_id, a.body);
    }, () => { rejectRef.current = null; }, () => reject(code, note));
  };
  return { busy, error, retry, wait, approve, reject };
}

export function DecisionBar({ name, unverified, editing, onEdit, editsReady, busy, error, retry, wait, onApprove, onApproveEdited, onReject }: {
  /** The signed-in person's name: every button says it. */
  name: string;
  /** True while any field of the draft does not trace: "Approve" is hidden. */
  unverified: boolean;
  editing: boolean;
  onEdit: (on: boolean) => void;
  /** Every unverified field has a typed value, and at least one field was typed. */
  editsReady: boolean;
  busy: "approve" | "reject" | null;
  error: string | null;
  retry: (() => void) | null;
  /** Seconds left before a rate-limited retry may go. */
  wait: number;
  onApprove: () => void;
  onApproveEdited: (reason: string) => void;
  onReject: (code: RejectCode, note: string) => void;
}) {
  const [why, setWhy] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [code, setCode] = useState<RejectCode>(REJECT_REASONS[0].code);
  const [note, setNote] = useState("");
  const label = (which: "approve" | "reject", text: string) => (busy === which ? "Saving…" : text);
  const off = busy !== null;
  return (
    <div className="space-y-3 border-t-[1.5px] border-bg-deep pt-4">
      {unverified && <p className="font-semibold">Some numbers in this draft don&apos;t trace to your books. Type the values you checked, or reject it.</p>}
      {editing && (
        <label className="block font-semibold">
          Why you changed it
          <textarea rows={2} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
        </label>
      )}
      {rejecting && (
        <div className="grid gap-3">
          <label className="block font-semibold">
            Why are you rejecting it?
            <select value={code} onChange={(e) => setCode(e.target.value as RejectCode)}>
              {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
          <label className="block font-semibold">
            What&apos;s wrong?
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {!unverified && !editing && !rejecting && (
          <button type="button" className="btn btn-primary" disabled={off} onClick={onApprove}>{label("approve", `Approve as ${name}`)}</button>
        )}
        {editing && (
          <>
            <button type="button" className="btn btn-primary" disabled={off || !editsReady || why.trim() === ""} onClick={() => onApproveEdited(why.trim())}>
              {label("approve", `Approve with my edits as ${name}`)}
            </button>
            <button type="button" className="btn btn-plain" disabled={off} onClick={() => onEdit(false)}>Cancel</button>
          </>
        )}
        {!editing && !rejecting && (
          <>
            <button type="button" className="btn btn-plain" disabled={off} onClick={() => onEdit(true)}>Edit</button>
            <button type="button" className="btn btn-plain text-danger" disabled={off} onClick={() => setRejecting(true)}>Reject</button>
          </>
        )}
        {rejecting && (
          <>
            <button type="button" className="btn btn-plain text-danger" disabled={off || note.trim() === ""} onClick={() => onReject(code, note.trim())}>{label("reject", `Reject as ${name}`)}</button>
            <button type="button" className="btn btn-plain" disabled={off} onClick={() => setRejecting(false)}>Cancel</button>
          </>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {retry && (
        <button type="button" className="btn btn-plain" disabled={off || wait > 0} onClick={retry}>{wait > 0 ? `Try again in ${wait} s` : "Try again"}</button>
      )}
    </div>
  );
}
