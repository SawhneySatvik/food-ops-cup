// /v1 W1 read paths over what intel produced (03-architecture §1.9): findings, the inbox (findings +
// drafts awaiting a person), snapshots (how a person "opens the ledger rows", R15; member/operator mint
// per R40 C4), runs and their traces.
// Named after the `intel` / `evidence` schemas these rows live in; served by core-api with a member token.
import { z } from "zod";
import { DraftView, ResolvedRef } from "../approvals/index.ts";
import { Severity } from "../internal/index.ts";
import { FindingEnvelope } from "../shared/envelope.ts";
import { BasisPoints, IsoDateTime, OutletScope, Slug, UUID7_PATTERN, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";
import { RunTrigger } from "../shared/run-token.ts";
import { MintSnapshotRequest } from "../shared/snapshot.ts";
import { TraceEvent } from "../shared/trace.ts";
import { SpecialistRegistry } from "./specialists.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

export { SPECIALIST_REGISTRY, SpecialistEntry, SpecialistRegistry } from "./specialists.ts";

export const FindingStatus = z.enum(["open", "dismissed", "resolved"]);

export const FindingView = z.strictObject({
  finding_id: Uuid7,
  run_id: Uuid7,
  pack: Slug,
  type: Slug,
  severity: Severity,
  status: FindingStatus,
  confidence_bp: BasisPoints,
  dedupe_key: z.string(),
  envelope: FindingEnvelope,
  /** Every ref in the envelope with the value core resolved for it. */
  resolved_refs: z.array(ResolvedRef),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});

export const FindingsListResponse = z.strictObject({ items: z.array(FindingView), next_cursor: z.string().nullable() });

export const InboxItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("finding"), finding: FindingView }),
  z.strictObject({ kind: z.literal("draft"), draft: DraftView }),
]);
export const InboxResponse = z.strictObject({ items: z.array(InboxItem), next_cursor: z.string().nullable() });

export const RunView = z.strictObject({
  run_id: Uuid7,
  trigger: RunTrigger,
  actor: z.string().min(1).max(100),
  outlet_scope: OutletScope,
  issued_at: IsoDateTime,
  expires_at: IsoDateTime,
  ended_at: IsoDateTime.nullable(),
});

/** `GET /v1/runs` (back-office run picker, G-OFF-1); `?finding=` narrows it to the run that produced that finding. */
export const RunsListResponse = z.strictObject({ items: z.array(RunView), next_cursor: z.string().nullable() });

export const TracesResponse = z.strictObject({
  run_id: Uuid7,
  events: z.array(TraceEvent),
  /** Pass as `after_seq` to page; null when the run has no more events yet. */
  next_after_seq: z.int().min(0).nullable(),
});

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "v1.finding": FindingView,
  "v1.findings.response": FindingsListResponse,
  "v1.inbox.response": InboxResponse,
  "v1.run.response": RunView,
  "v1.runs.response": RunsListResponse,
  "v1.traces.response": TracesResponse,
  /** Same shape as the intel mint request; a distinct schema object so each registry name owns one. */
  "intel.specialists.registry": SpecialistRegistry,
  "v1.snapshots.request": z.strictObject({ ...MintSnapshotRequest.shape }),
};

const uuid = { type: "string", pattern: `^${UUID7_PATTERN}$` };
const cursor: QueryParam = { name: "cursor", required: false, schema: { type: "string" } };
const limit: QueryParam = { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } };
const read = (r: Omit<Route, "surface" | "method" | "auth" | "status">): Route => ({ surface: "public", method: "get", auth: "member", status: 200, ...r });

export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  read({ path: "/v1/findings", operationId: "listFindings", summary: "Findings in the caller's outlet scope; pack = the specialist (T-092a)", response: "v1.findings.response", query: [cursor, limit, { name: "status", required: false, schema: { type: "string", enum: FindingStatus.options } }, { name: "pack", required: false, schema: { type: "string", pattern: "^[a-z_]{1,40}$" } }] }),
  read({ path: "/v1/inbox", operationId: "listInbox", summary: "Findings and drafts awaiting a person", response: "v1.inbox.response", query: [cursor, limit] }),
  {
    surface: "public",
    method: "post",
    path: "/v1/snapshots",
    operationId: "mintMemberSnapshot",
    summary: "A member mints an allow-listed template snapshot (R40 C4); scope from the member token",
    auth: "member",
    request: "v1.snapshots.request",
    response: "snapshot",
    status: 201,
  },
  read({ path: "/v1/snapshots/{id}", operationId: "getSnapshot", summary: "Open the rows behind a ref", response: "snapshot", pathParams: [{ name: "id", uuid: true }] }),
  read({ path: "/v1/runs/{id}", operationId: "getRun", summary: "A run by id", response: "v1.run.response", pathParams: [{ name: "id", uuid: true }] }),
  read({ path: "/v1/runs", operationId: "listRuns", summary: "Runs in the caller's scope, newest first; ?finding= gives the run that produced it", response: "v1.runs.response", query: [{ name: "finding", required: false, schema: uuid }, cursor, limit] }),
  read({ path: "/v1/traces/{run}", operationId: "getTrace", summary: "Trace events of a run, in seq order", response: "v1.traces.response", pathParams: [{ name: "run", uuid: true }], query: [{ name: "after_seq", required: false, schema: { type: "integer", minimum: 0 } }, limit] }),
];
