// Lineage and the action catalogue (T-084a, ADR-014 §2.3, §8). Read-only. Lineage joins through core.audit_log, never
// through a row's `origin` (gotcha 34): row → audit → decision → draft → finding → run, plus the snapshots the draft
// cites. A hop the viewer cannot open is null and its refs are listed in `unverified_refs`. Ids, statuses and refs
// only: no audit before/after text and no amounts, so every number still comes from a snapshot cell (R25).
import { z } from "zod";
import { RejectReasonCode } from "../approvals/index.ts";
import { draftable, draftableTypes } from "../shared/draftables.ts";
import { CommandType, IsoDateTime, Slug, Uuid7 } from "../shared/primitives.ts";
import { Ref, SnapCellRef } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";

const Actor = z.strictObject({ member_id: Uuid7.nullable(), kind: z.string().min(1), role: z.string().min(1) });

export const AuditHop = z.strictObject({
  seq: z.int().min(1),
  action: z.string().min(1),
  entity: z.string().regex(/^[a-z_]+\.[a-z_][a-z0-9_]*$/),
  entity_id: z.string().min(1),
  at: IsoDateTime,
  actor: Actor,
  decision_id: Uuid7.nullable(),
}).meta({ title: "LineageAuditHop" });

export const DecisionHop = z.strictObject({
  decision_id: Uuid7,
  verdict: z.enum(["approved", "edited", "rejected"]),
  /** The person's own note: untrusted text, rendered as text. */
  reason: z.string().nullable(),
  reason_code: RejectReasonCode.nullable(),
  decided_by: z.strictObject({ member_id: Uuid7, name: z.string().nullable() }),
  decided_at: IsoDateTime,
}).meta({ title: "LineageDecisionHop" });

/** What became of the draft: `changes` (stale) and `sqlstate` (failed) come from the draft's audit entries. */
export const DraftOutcome = z.strictObject({
  status: z.enum(["proposed", "executing", "executed", "failed", "rejected", "stale"]),
  reason: z.string().nullable(),
  reason_code: RejectReasonCode.nullable(),
  changes: z.array(z.strictObject({ ref: SnapCellRef, now_ref: SnapCellRef.nullable() })),
  sqlstate: z.string().regex(/^[0-9A-Z]{5}$/).nullable(),
  failure_reason: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable(),
}).meta({ title: "LineageDraftOutcome" });

export const DraftHop = z.strictObject({
  draft_id: Uuid7,
  command_type: CommandType,
  source: z.string().regex(/^(intel:[a-z_]+|import|member)$/),
  outlet_ids: z.array(Uuid7),
  created_at: IsoDateTime,
  outcome: DraftOutcome,
}).meta({ title: "LineageDraftHop" });

export const FindingHop = z.strictObject({
  finding_id: Uuid7,
  pack: z.string().min(1),
  type: z.string().min(1),
  status: z.enum(["open", "dismissed", "resolved"]),
  created_at: IsoDateTime,
}).meta({ title: "LineageFindingHop" });

export const RunHop = z.strictObject({
  run_id: Uuid7,
  trigger: z.string().min(1),
  actor: z.string().min(1),
  issued_at: IsoDateTime,
}).meta({ title: "LineageRunHop" });

export const SnapshotHop = z.strictObject({ snapshot_id: Uuid7, template_id: Slug, template_version: z.int().min(1), refs: z.array(Ref) }).meta({ title: "LineageSnapshotHop" });

/** One path up from a book change: every hop the viewer may see (null/empty where there is none, or none they can open). */
export const LineageChain = z.strictObject({
  audit: AuditHop.nullable(),
  decision: DecisionHop.nullable(),
  draft: DraftHop.nullable(),
  finding: FindingHop.nullable(),
  run: RunHop.nullable(),
  snapshots: z.array(SnapshotHop),
  unverified_refs: z.array(z.string().min(1).max(300)),
});

export const RowLineageResponse = z.strictObject({
  row: z.strictObject({ table: z.string().regex(/^[a-z_]+\.[a-z_][a-z0-9_]*$/), id: Uuid7 }),
  /** Oldest first: one chain per audit entry that touched the row. */
  chains: z.array(LineageChain).min(1),
});

export const DraftLineageResponse = z.strictObject({
  /** `audit` = the draft's own executing/executed/stale/failed entry, null while it is only proposed or was rejected. */
  chain: LineageChain,
  /** Down: the rows its approval touched (audit entries under its decision). */
  touched: z.array(z.strictObject({ table: z.string().regex(/^[a-z_]+\.[a-z_][a-z0-9_]*$/), id: z.string().min(1), action: z.string().min(1), seq: z.int().min(1) })),
});

export const Draftable = z.strictObject({
  command_type: CommandType,
  /** JSON Schema of what intel may propose: numeric leaves are refs only. */
  proposal_schema: z.record(z.string(), z.unknown()),
  /** JSON Schema of what executes after approval. */
  command_schema: z.record(z.string(), z.unknown()),
});
export const DraftablesResponse = z.strictObject({ items: z.array(Draftable) });

const jsonSchema = (s: z.ZodType) => z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
/** The registered draftable types as served by `GET /v1/draftables` (call after the registry is loaded, gotcha 28). */
export function draftablesView(): z.infer<typeof DraftablesResponse> {
  return {
    items: draftableTypes().map((t) => {
      const d = draftable(t)!;
      return { command_type: t, proposal_schema: jsonSchema(d.proposal), command_schema: jsonSchema(d.command) };
    }),
  };
}

export const SCHEMAS = {
  "v1.lineage.row": RowLineageResponse,
  "v1.lineage.draft": DraftLineageResponse,
  "v1.draftables": DraftablesResponse,
};

export const ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/lineage", operationId: "getRowLineage", summary: "Lineage of one book row via core.audit_log (row=<schema>.<table>:<uuid>); a row outside the caller's scope is 404", auth: "member", response: "v1.lineage.row", status: 200,
    query: [{ name: "row", required: true, schema: { type: "string", pattern: "^[a-z_]+\\.[a-z_][a-z0-9_]*:[0-9a-f-]{36}$" } }] },
  { surface: "public", method: "get", path: "/v1/drafts/{id}/lineage", operationId: "getDraftLineage", summary: "A draft up (finding, run, snapshots) and down (decision, touched rows), including rejected, stale and failed ones", auth: "member", response: "v1.lineage.draft", status: 200, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "get", path: "/v1/draftables", operationId: "listDraftables", summary: "The draftable command types, for forms and the SDK", auth: "member", response: "v1.draftables", status: 200 },
];
