// Evidence snapshots (02-schema §3, 03-architecture §1.7): the only source of numbers intel shows.
// Postgres numeric columns arrive as decimal strings so no float ever enters a cell (and the sha256 over
// canonical JSON is stable).
import { z } from "zod";
import { IsoDateTime, OutletScope, Slug, Uuid7 } from "./primitives.ts";

export const ColumnType = z.enum(["integer", "numeric", "text", "date", "timestamptz", "boolean", "uuid"]);
/** `numeric_source` is the template's declared lineage for a numeric column ('core.<table>.<column>' or a
 *  'count:'/'sum:' form, 0003): core-api returns the template's column objects as they are, so the contract names it
 *  (R3-M5: the strict schema rejected every real snapshot response). */
export const SnapshotColumn = z.strictObject({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  type: ColumnType,
  numeric_source: z.union([z.string(), z.array(z.string()).min(1)]).nullable().optional(),
});
export const Cell = z.union([z.string(), z.int(), z.boolean(), z.null()]);
export const TemplateParams = z.record(
  z.string().regex(/^[a-z_][a-z0-9_]*$/),
  z.union([z.string(), z.int(), z.boolean(), z.null(), z.array(z.string())]),
);

/** Who minted it (R40 C4): exactly one of an intel run, a member (`POST /v1/snapshots`) or a platform
 *  operator (`POST /platform/v1/snapshots`). Tenant and outlet scope always come from the verified token. */
export const Snapshot = z
  .strictObject({
    snapshot_id: Uuid7,
    template_id: Slug,
    params: TemplateParams,
    run_id: Uuid7.nullable(),
    minted_by_member_id: Uuid7.nullable(),
    minted_by_operator_id: Uuid7.nullable(),
    outlet_scope: OutletScope,
    columns: z.array(SnapshotColumn),
    rows: z.array(z.record(z.string(), Cell)).max(500),
    row_count: z.int().min(0).max(500),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: IsoDateTime,
  })
  .superRefine((s, ctx) => {
    const set = [s.run_id, s.minted_by_member_id, s.minted_by_operator_id].filter((x) => x !== null).length;
    if (set !== 1) ctx.addIssue({ code: "custom", path: ["run_id"], message: "exactly one of run_id, minted_by_member_id, minted_by_operator_id is set" });
  });

/** Mint request (intel `/internal/intel/v1/snapshots`, member `/v1/snapshots`, operator
 *  `/platform/v1/snapshots`). Template ids are allow-listed migration templates; params carry ids, dates
 *  and shape only, and are intersected with the caller's scope, never trusted alone. */
export const MintSnapshotRequest = z.strictObject({ template_id: Slug, params: TemplateParams });
export type Snapshot = z.infer<typeof Snapshot>;
