// Compliance & assets commands (02-schema §2.10, packs/compliance-assets.md). Logs are evidence records, never
// certificates (spec §7). Licence kinds are NOT enumerated here: they come from the country pack (R21) and the
// database refuses a kind outside the tenant's pack (MB013). Intel may draft one command: scheduling maintenance.
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, NonEmpty, Slug, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

const Kind = z.string().regex(/^[a-z][a-z0-9_]*$/).max(60);
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const MilliC = z.int().min(-60000).max(300000);

export const ComplianceLicenceUpsertV1 = z.strictObject({
  licence_id: Uuid7,
  /** null = applies to every outlet (needs a tenant-wide scope). */
  outlet_id: Uuid7.nullable(),
  kind: Kind,
  number: NonEmpty,
  issuer: NonEmpty.nullable(),
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
  document_id: Uuid7.nullable(),
  /** A renewal retires the licence it replaces (active → superseded) in the same command. */
  supersedes_licence_id: Uuid7.nullable(),
});

export const ComplianceChecklistUpsertV1 = z.strictObject({
  checklist_id: Uuid7,
  outlet_id: Uuid7.nullable(),
  name_key: Slug,
  kind: z.enum(["opening", "closing", "hygiene", "cleaning", "other"]),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  due_time: TimeOfDay,
  /** i18n item keys. */
  items: z.array(Slug).min(1).max(100),
  active: z.boolean(),
});

export const ComplianceChecklistCompleteV1 = z.strictObject({
  run_id: Uuid7,
  checklist_id: Uuid7,
  outlet_id: Uuid7,
  /** The outlet-local date the run is for; never later than today in the outlet's time zone. */
  business_date: IsoDate,
  /** item key → ticked. Every item of the checklist must be present. */
  results: z.record(Slug, z.boolean()),
});

export const ComplianceTempRecordV1 = z.strictObject({
  log_id: Uuid7,
  outlet_id: Uuid7,
  asset_id: Uuid7,
  reading_milli_c: MilliC,
  read_at: IsoDateTime,
  note: z.string().min(1).max(500).nullable(),
});

export const ComplianceAssetUpsertV1 = z.strictObject({
  asset_id: Uuid7,
  outlet_id: Uuid7,
  kind: z.enum(["chiller", "freezer", "hot_holding", "oven", "fryer", "dishwasher", "air_conditioner", "generator", "water_purifier", "other"]),
  name: NonEmpty,
  make_model: NonEmpty.nullable(),
  serial_no: NonEmpty.nullable(),
  /** Safe range in milli-°C; both or neither. */
  safe_min_milli_c: MilliC.nullable(),
  safe_max_milli_c: MilliC.nullable(),
  installed_on: IsoDate.nullable(),
  active: z.boolean(),
});

export const ComplianceAmcRecordV1 = z.strictObject({
  amc_id: Uuid7,
  asset_id: Uuid7,
  vendor: NonEmpty,
  valid_from: IsoDate,
  valid_to: IsoDate,
  cost: z.strictObject({ amount_minor: MinorAmount.nonnegative(), currency: CurrencyCode }),
  document_id: Uuid7.nullable(),
});

export const ComplianceMaintenanceScheduleV1 = z.strictObject({
  maintenance_id: Uuid7,
  /** The asset's outlet: approvals judges authority on the payload's outlet (the pack lists no outlet field — added). */
  outlet_id: Uuid7,
  asset_id: Uuid7,
  kind: z.enum(["preventive", "inspection"]),
  due_on: IsoDate,
  /** Numeric leaf: a Ref (compliance.asset_costs.last_preventive_cost_minor) when intel proposes. */
  estimated_cost_minor: MinorAmount.nonnegative().nullable(),
  vendor_note: z.string().min(1).max(500).nullable(),
});

/** Records work done: completes a scheduled row (same maintenance_id) or logs a new one already done. */
export const ComplianceMaintenanceRecordV1 = z.strictObject({
  maintenance_id: Uuid7,
  asset_id: Uuid7,
  kind: z.enum(["preventive", "breakdown", "inspection"]),
  done_on: IsoDate,
  cost_minor: MinorAmount.nonnegative(),
  vendor: NonEmpty.nullable(),
  amc_id: Uuid7.nullable(),
  note: z.string().min(1).max(500).nullable(),
});

/** Intel may propose scheduling maintenance as a draft; executing one writes the maintenance row. */
export const MAINTENANCE_SCHEDULE_DRAFT = defineDraftable("compliance.maintenance.schedule.v1", ComplianceMaintenanceScheduleV1);

// ---- Read models (T-029): rows leave with their own fields; `days_left` and `out_of_range` are per-row facts.
const Items = <T extends z.ZodType>(row: T) => z.strictObject({ items: z.array(row) });
const Status = <T extends readonly [string, ...string[]]>(v: T) => z.enum(v);
const ClockTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

export const ComplianceLicenceView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7.nullable(),
  kind: Kind,
  number: NonEmpty,
  issuer: NonEmpty.nullable(),
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
  document_id: Uuid7.nullable(),
  status: Status(["active", "superseded", "lapsed"]),
});
export const ComplianceExpiringLicenceView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7.nullable(),
  kind: Kind,
  number: NonEmpty,
  valid_to: IsoDate,
  document_id: Uuid7.nullable(),
  /** valid_to minus the outlet-local date of `as_of` (a tenant-wide licence: the pack's default zone); negative = past. */
  days_left: z.int(),
  expired: z.boolean(),
});
export const ComplianceAssetView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7,
  kind: ComplianceAssetUpsertV1.shape.kind,
  name: NonEmpty,
  make_model: NonEmpty.nullable(),
  serial_no: NonEmpty.nullable(),
  safe_min_milli_c: MilliC.nullable(),
  safe_max_milli_c: MilliC.nullable(),
  installed_on: IsoDate.nullable(),
  active: z.boolean(),
});
export const ComplianceTempLogView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7,
  asset_id: Uuid7,
  reading_milli_c: MilliC,
  read_at: IsoDateTime,
  recorded_by: Uuid7,
  note: z.string().nullable(),
  /** The outlet-local date of the reading. */
  local_date: IsoDate,
  /** Against the asset's own safe range; null when the asset has none (never "in range" by default). */
  out_of_range: z.boolean().nullable(),
});
export const ComplianceChecklistView = z.strictObject({
  id: Uuid7,
  outlet_id: Uuid7.nullable(),
  name_key: Slug,
  kind: ComplianceChecklistUpsertV1.shape.kind,
  frequency: ComplianceChecklistUpsertV1.shape.frequency,
  due_time: ClockTime,
  items: z.array(Slug),
  active: z.boolean(),
});
export const ComplianceChecklistRunView = z.strictObject({
  id: Uuid7,
  checklist_id: Uuid7,
  outlet_id: Uuid7,
  business_date: IsoDate,
  results: z.record(Slug, z.boolean()),
  completed_by: Uuid7,
  completed_at: IsoDateTime,
});
export const ComplianceAmcView = z.strictObject({
  id: Uuid7,
  asset_id: Uuid7,
  vendor: NonEmpty,
  valid_from: IsoDate,
  valid_to: IsoDate,
  cost_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
  document_id: Uuid7.nullable(),
});
export const ComplianceMaintenanceView = z.strictObject({
  id: Uuid7,
  asset_id: Uuid7,
  kind: ComplianceMaintenanceRecordV1.shape.kind,
  status: Status(["scheduled", "done", "cancelled"]),
  due_on: IsoDate.nullable(),
  done_on: IsoDate.nullable(),
  estimated_cost_minor: MinorAmount.nonnegative().nullable(),
  cost_minor: MinorAmount.nonnegative().nullable(),
  currency: CurrencyCode.nullable(),
  vendor: z.string().nullable(),
  amc_id: Uuid7.nullable(),
  note: z.string().nullable(),
});

export const SCHEMAS = {
  "compliance.licence.upsert.v1": ComplianceLicenceUpsertV1,
  "compliance.checklist.upsert.v1": ComplianceChecklistUpsertV1,
  "compliance.checklist.complete.v1": ComplianceChecklistCompleteV1,
  "compliance.temp.record.v1": ComplianceTempRecordV1,
  "compliance.asset.upsert.v1": ComplianceAssetUpsertV1,
  "compliance.amc.record.v1": ComplianceAmcRecordV1,
  "compliance.maintenance.schedule.v1": ComplianceMaintenanceScheduleV1,
  "compliance.maintenance.record.v1": ComplianceMaintenanceRecordV1,
  "proposal.compliance.maintenance.schedule.v1": MAINTENANCE_SCHEDULE_DRAFT.proposal,
  "v1.compliance.licences": Items(ComplianceLicenceView),
  "v1.compliance.licences-expiring": Items(ComplianceExpiringLicenceView),
  "v1.compliance.assets": Items(ComplianceAssetView),
  "v1.compliance.temp-logs": Items(ComplianceTempLogView),
  "v1.compliance.checklists": Items(ComplianceChecklistView),
  "v1.compliance.checklist-runs": Items(ComplianceChecklistRunView),
  "v1.compliance.amcs": Items(ComplianceAmcView),
  "v1.compliance.maintenance": Items(ComplianceMaintenanceView),
};

const UUID_Q = { type: "string", format: "uuid" } as const;
const DATE_Q = { type: "string", format: "date" } as const;
const q = (name: string, schema: Record<string, unknown> = UUID_Q) => ({ name, required: false, schema });
const LIMIT = q("limit", { type: "integer", minimum: 1, maximum: 500 });
const read = (path: string, operationId: string, summary: string, response: string, query: ReturnType<typeof q>[] = []): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...(query.length ? { query } : {}) });
const write = (path: string, operationId: string, command: string, summary: string): Route =>
  ({ surface: "public", method: "post", path, operationId, summary: `${command} — ${summary}`, auth: "member", command, response: "command-result", status: 200, conflict: true });

export const ROUTES: readonly Route[] = [
  read("/v1/compliance/licences", "listLicences", "Licences (active by default), tenant-wide and in the caller's outlets", "v1.compliance.licences",
    [q("outlet"), q("status", { type: "string", enum: ["active", "superseded", "lapsed"] })]),
  read("/v1/compliance/licences/expiring", "listExpiringLicences", "Active licences expiring within N days of as_of (outlet-local date)", "v1.compliance.licences-expiring",
    [q("within_days", { type: "integer", minimum: 0, maximum: 9999 }), q("as_of", { type: "string", format: "date-time" }), q("outlet")]),
  write("/v1/compliance/licences", "upsertLicence", "compliance.licence.upsert.v1", "record or renew a licence"),
  read("/v1/compliance/assets", "listAssets", "Assets in the caller's outlets", "v1.compliance.assets", [q("outlet")]),
  write("/v1/compliance/assets", "upsertAsset", "compliance.asset.upsert.v1", "add or change an asset"),
  read("/v1/compliance/checklists", "listChecklists", "Checklists", "v1.compliance.checklists", [q("outlet")]),
  write("/v1/compliance/checklists", "upsertChecklist", "compliance.checklist.upsert.v1", "add or change a checklist"),
  read("/v1/compliance/checklist-runs", "listChecklistRuns", "Completed checklist runs, newest first", "v1.compliance.checklist-runs",
    [q("outlet"), q("checklist"), q("from", DATE_Q), q("to", DATE_Q), LIMIT]),
  write("/v1/compliance/checklist-runs", "completeChecklist", "compliance.checklist.complete.v1", "complete a checklist for a business date"),
  read("/v1/compliance/temp-logs", "listTempLogs", "Temperature readings with the asset's own range applied", "v1.compliance.temp-logs",
    [q("outlet"), q("asset"), q("from", DATE_Q), q("to", DATE_Q), LIMIT]),
  write("/v1/compliance/temp-logs", "recordTemp", "compliance.temp.record.v1", "record a temperature reading (evidence, not a certificate)"),
  read("/v1/compliance/amcs", "listAmcs", "Annual maintenance contracts", "v1.compliance.amcs", [q("asset")]),
  write("/v1/compliance/amcs", "recordAmc", "compliance.amc.record.v1", "record an AMC"),
  read("/v1/compliance/maintenance", "listMaintenance", "Maintenance rows", "v1.compliance.maintenance",
    [q("asset"), q("status", { type: "string", enum: ["scheduled", "done", "cancelled"] })]),
  write("/v1/compliance/maintenance", "scheduleMaintenance", "compliance.maintenance.schedule.v1", "schedule maintenance (intel may draft it)"),
  write("/v1/compliance/maintenance/record", "recordMaintenance", "compliance.maintenance.record.v1", "record maintenance done"),
];
