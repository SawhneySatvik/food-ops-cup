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
};
export const ROUTES: readonly Route[] = [];
