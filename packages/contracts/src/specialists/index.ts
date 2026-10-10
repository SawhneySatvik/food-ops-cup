// Specialist desks (ledger R45 F8/F9, T-087b): `GET /v1/specialists` (the team) and `GET /v1/specialists/{id}`
// (a desk page: its open findings, proposed drafts, track record, threads). The track record is snapshot refs only
// (clause 2): core mints `intel.agent_track_record` for this viewer and returns the snapshot id plus one cell ref per
// count; the number is rendered from the cell, never carried here.
import { z } from "zod";
import { DraftView } from "../approvals/index.ts";
import { FindingView } from "../intel/index.ts";
import { SpecialistEntry } from "../intel/specialists.ts";
import { IsoDateTime, Uuid7 } from "../shared/primitives.ts";
import { SnapCellRef } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";

export const SpecialistsResponse = z.strictObject({ items: z.array(z.strictObject({ ...SpecialistEntry.shape })) });

export const TRACK_RECORD_COUNTS = ["proposed", "approved", "edited", "rejected", "stale", "abstained"] as const;

export const TrackRecord = z.strictObject({
  snapshot_id: Uuid7,
  /** One `snap:` cell ref per count; null while the specialist has no activity this viewer can see (0 rows). */
  cells: z.strictObject(Object.fromEntries(TRACK_RECORD_COUNTS.map((k) => [k, SnapCellRef])) as Record<(typeof TRACK_RECORD_COUNTS)[number], typeof SnapCellRef>).nullable(),
});

export const DeskThread = z.strictObject({ thread_id: Uuid7, last_activity_at: IsoDateTime });

export const SpecialistDesk = z.strictObject({
  specialist: z.strictObject({ ...SpecialistEntry.shape }),
  /** false where the pack is off for the viewer's outlets (kitchen on a store-only scope, kitchen.md §1); lists are then empty. */
  applicable: z.boolean(),
  /** Open findings with `pack = id` in the viewer's outlet scope, newest first. */
  findings: z.array(FindingView),
  /** Proposed drafts with `source = intel:<id>`, newest first. */
  drafts: z.array(DraftView),
  /** null for the Manager (no track record) and for a viewer below manager (the template's minimum role). */
  track_record: TrackRecord.nullable(),
  /** Threads addressed to this desk (`ai_thread.specialist` or a turn `addressed_to`), most recent first. */
  threads: z.array(DeskThread),
});

export const SCHEMAS = {
  "v1.specialists.response": SpecialistsResponse,
  "v1.specialist.desk": SpecialistDesk,
};

const read = (r: Omit<Route, "surface" | "method" | "auth" | "status">): Route => ({ surface: "public", method: "get", auth: "member", status: 200, ...r });

export const ROUTES: readonly Route[] = [
  read({ path: "/v1/specialists", operationId: "listSpecialists", summary: "The team: the eight specialists and the Manager, with what each owns", response: "v1.specialists.response" }),
  read({ path: "/v1/specialists/{id}", operationId: "getSpecialistDesk", summary: "A specialist's desk: findings, drafts, track record (snapshot refs), threads", response: "v1.specialist.desk", pathParams: [{ name: "id", uuid: false }] }),
];
