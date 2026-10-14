// file: lib/munim/draft-decision.ts
// Approve, approve-with-my-edits and reject for one AI draft, each as one frozen attempt (01 §4), and what each answer
// means for the card that sent it. Used by the Cares listing card (14) and the purchase-order card (15). Nothing here
// decides anything by itself: every call starts from a person's tap. Plain TypeScript, no React.
import type { MunimError, Result } from "./client";
import { attemptFor, retryable, type CommandAttempt } from "./commands";
import type { Schemas } from "./types";

type Approve = Schemas["DraftsApproveV1"];
type Reject = Schemas["DraftsRejectV1"];
export type EditedPayload = NonNullable<Approve["edited_payload"]>;
export type RejectCode = NonNullable<Reject["reason_code"]>;
export type ApproveAttempt = CommandAttempt<"drafts.approve.v1", Approve>;
export type RejectAttempt = CommandAttempt<"drafts.reject.v1", Reject>;

/** Approve as proposed (`edited` null, `reason` null) or with the person's edits (`edited` = the payload with each
 *  changed number as { value, typed_by }, and a reason). The same inputs again = the same attempt (a retry). */
export function approveAttempt(prev: ApproveAttempt | null, draft: { draft_id: string; command_type: string }, edited: EditedPayload | null, reason: string | null): ApproveAttempt {
  return attemptFor(prev, JSON.stringify(["approve", draft.draft_id, edited, reason]), "drafts.approve.v1", () => ({
    draft_id: draft.draft_id,
    command_type: draft.command_type,
    edited_payload: edited,
    reason,
  }));
}

/** Reject always carries a reason code and a note (1–500 characters). */
export function rejectAttempt(prev: RejectAttempt | null, draftId: string, code: RejectCode, note: string): RejectAttempt {
  return attemptFor(prev, JSON.stringify(["reject", draftId, code, note]), "drafts.reject.v1", () => ({ draft_id: draftId, reason: note, reason_code: code }));
}

/** What an approve or reject answer means for the card. */
export type Outcome =
  | { kind: "done"; type: string; entityId: string }
  /** network, 429 or 5xx: the same attempt may be sent again (after error.retryAfterMs on a 429) */
  | { kind: "retry"; error: MunimError }
  /** 409 stale_draft: the cells behind it moved; the draft is now "stale" and can only be rejected or left */
  | { kind: "stale" }
  /** 409 already_decided: someone else decided first */
  | { kind: "decided_elsewhere" }
  /** 422 cannot_verify: a number no longer traces; refetch the draft, its fields show "Cannot verify" */
  | { kind: "cannot_verify" }
  /** 422 execution_failed: approved but not applied; nothing changed */
  | { kind: "failed_to_apply"; error: MunimError }
  | { kind: "signed_out"; error: MunimError }
  | { kind: "not_found" }
  /** any other refusal (403 authority_denied, a reason code from the command): show staffErrorText */
  | { kind: "refused"; error: MunimError };

export function outcomeOf(r: Result<Schemas["CommandResult"]>): Outcome {
  if (r.ok) return { kind: "done", type: r.data.type, entityId: r.data.entity_id };
  const e = r.error;
  if (e.status === 401) return { kind: "signed_out", error: e };
  if (e.kind === "not_found") return { kind: "not_found" };
  if (retryable(e)) return { kind: "retry", error: e };
  if (e.code === "stale_draft") return { kind: "stale" };
  if (e.code === "already_decided") return { kind: "decided_elsewhere" };
  if (e.code === "cannot_verify") return { kind: "cannot_verify" };
  if (e.code === "execution_failed") return { kind: "failed_to_apply", error: e };
  return { kind: "refused", error: e };
}

/** The draft card's lineage line: who proposed it and, once decided, who decided it and how. Names come from the
 *  decision (decided_by.name), never from the model. */
export function lineageText(detail: Schemas["V1DraftDetail"], proposer: string, when: (iso: string) => string): string {
  const head = `Proposed by ${proposer} · ${when(detail.draft.created_at)}`;
  const d = detail.decision;
  if (!d) return head;
  const verb = d.verdict === "approved" ? "Approved" : d.verdict === "edited" ? "Approved with edits" : "Rejected";
  return `${head} · ${verb} by ${d.decided_by.name ?? "a team member"} · ${when(d.decided_at)}`;
}
