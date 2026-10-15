// file: components/staff/decision.tsx
"use client";
// The action bar of an AI draft (02 §5), the one way any screen decides a draft: the draft page (12), the Cares
// proposal card (14) and the purchase-order proposal card (15). Approve as proposed, edit then approve with my edits,
// or reject with a reason; which of these show comes from approveGate (lib/munim/drafts.ts). Every button names the
// person; nothing happens without a tap; one attempt per thing confirmed, so a double tap or a retry never sends two
// decisions.
import { useRef, useState } from "react";
import { useCountdown } from "@/lib/hooks";
import type { Result } from "@/lib/munim/client";
import { approveAttempt, editsReady, gateLine, outcomeOf, rejectAttempt, type ApproveAttempt, type ApproveGate, type EditedPayload, type Outcome, type RejectAttempt, type RejectCode } from "@/lib/munim/drafts";
import type { StaffClient } from "@/lib/munim/staff";
import { REJECT_REASONS, staffWriteErrorText, type StaffWhere } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { ErrorNote } from "../ui";

type Sent = Result<Schemas["CommandResult"]>;

/** Sends the decisions for one draft. `onOutcome` gets every settled answer (refetch there); the error line for a
 *  failure stays here. A retryable failure keeps its attempt: "Try again" (or the same button) resends the same envelope. */
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
      setError(staffWriteErrorText(o.error, where));
      setRetry(() => again);
      if (o.error.retryAfterMs) setRetryAt(Date.now() + o.error.retryAfterMs);
      return;
    }
    clear();
    if (o.kind === "cannot_verify" || o.kind === "failed_to_apply" || o.kind === "refused") setError(staffWriteErrorText(o.error, where));
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

export function DecisionBar({ name, gate, commandType, edits, editing, onEdit, busy, error, retry, wait, onApprove, onApproveEdited, onReject }: {
  /** The signed-in person's name: every button says it. */
  name: string;
  /** approveGate(detail, numericFields(detail), me): which buttons show. */
  gate: ApproveGate;
  commandType: string;
  /** What the person typed, by JSON Pointer path (in each field's own units). */
  edits: Readonly<Record<string, number>>;
  editing: boolean;
  /** false = "Cancel": the screen drops its typed values. */
  onEdit: (on: boolean) => void;
  busy: "approve" | "reject" | null;
  error: string | null;
  retry: (() => void) | null;
  /** Seconds left before a rate-limited retry may go: every button waits. */
  wait: number;
  onApprove: () => void;
  onApproveEdited: (reason: string) => void;
  onReject: (code: RejectCode, note: string) => void;
}) {
  const [why, setWhy] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [code, setCode] = useState<RejectCode | "">("");
  const [note, setNote] = useState("");
  if (gate.kind === "closed") return null;
  const line = gateLine(gate, commandType);
  const off = busy !== null || wait > 0;
  const label = (which: "approve" | "reject", text: string) => (busy === which ? "Saving…" : text);
  const mayEdit = gate.kind === "open" || gate.kind === "type_first";
  return (
    <div className="space-y-3 border-t-[1.5px] border-bg-deep pt-4">
      {line && !(rejecting && gate.kind === "type_first") && <p className="font-semibold">{line}</p>}
      {editing && mayEdit && (
        <label className="block font-semibold">
          Why you changed it
          <textarea rows={2} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} disabled={off} />
        </label>
      )}
      {rejecting && (
        <div className="grid gap-3">
          <label className="block font-semibold">
            Why reject it?
            <select value={code} onChange={(e) => setCode(e.target.value as RejectCode | "")} disabled={off}>
              <option value="">Choose a reason</option>
              {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
          <label className="block font-semibold">
            What&apos;s wrong?
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={off} />
          </label>
        </div>
      )}
      {gate.kind !== "not_for_you" && (
        <div className="flex flex-wrap gap-3">
          {gate.kind === "open" && !editing && !rejecting && (
            <button type="button" className="btn btn-primary" disabled={off} onClick={onApprove}>{label("approve", `Approve as ${name}`)}</button>
          )}
          {editing && mayEdit && (
            <>
              <button type="button" className="btn btn-primary" disabled={off || !editsReady(gate, edits, why)} onClick={() => onApproveEdited(why.trim())}>
                {label("approve", `Approve with my edits as ${name}`)}
              </button>
              <button type="button" className="btn btn-plain" disabled={off} onClick={() => { setWhy(""); onEdit(false); }}>Cancel</button>
            </>
          )}
          {!editing && !rejecting && (
            <>
              {mayEdit && <button type="button" className="btn btn-plain" disabled={off} onClick={() => onEdit(true)}>Edit</button>}
              <button type="button" className="btn btn-plain text-danger" disabled={off} onClick={() => setRejecting(true)}>Reject</button>
            </>
          )}
          {rejecting && (
            <>
              <button type="button" className="btn btn-plain text-danger" disabled={off || code === "" || note.trim() === ""} onClick={() => code !== "" && onReject(code, note.trim())}>
                {label("reject", `Reject as ${name}`)}
              </button>
              <button type="button" className="btn btn-plain" disabled={off} onClick={() => { setRejecting(false); setCode(""); setNote(""); }}>Cancel</button>
            </>
          )}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {retry && (
        <button type="button" className="btn btn-plain" disabled={off} onClick={retry}>{wait > 0 ? `Try again in ${wait} s` : "Try again"}</button>
      )}
    </div>
  );
}
