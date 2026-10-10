// Compliance command handlers (T-029). Each is bound to exactly one seeded command and writes only that command's
// target tables; the book guard judges role, outlet scope and pack scope (MB001/MB008/MB013). A refusal here is
// an ApiError with a fixed code — never SQL text. Logs are evidence records, never certificates.
import {
  ComplianceAmcRecordV1, ComplianceAssetUpsertV1, ComplianceChecklistCompleteV1, ComplianceChecklistUpsertV1,
  ComplianceLicenceUpsertV1, ComplianceMaintenanceRecordV1, ComplianceMaintenanceScheduleV1, ComplianceTempRecordV1,
} from "@munim/contracts/compliance";
import { localDate } from "@munim/core-domain/tz";
import type { CommandHandler } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

const TENANT = `current_setting('app.tenant_id')::uuid`;
const ME = `current_setting('app.member_id')::uuid`;

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

async function one<T extends object>(c: Queryable, sql: string, params: unknown[]): Promise<T | undefined> {
  return (await c.query<T>(sql, params)).rows[0];
}

const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new ApiError("not_found");
  return v;
};

const tenantCurrency = async (c: Queryable) =>
  (await one<{ cur: string }>(c, `SELECT base_currency AS cur FROM core.tenant WHERE tenant_id = ${TENANT}`, []))!.cur;

const nowIso = async (c: Queryable) => (await one<{ t: string }>(c, `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`, []))!.t;

/** A row of ours with this id already exists → the id is taken (a fresh idempotency key reusing an entity id). */
const taken = (inserted: number) => {
  if (inserted !== 1) throw new ApiError("conflict");
};

export const licenceUpsert: CommandHandler = {
  type: "compliance.licence.upsert.v1",
  async run(c, cmd) {
    const p = parse(ComplianceLicenceUpsertV1, cmd.payload);
    if (p.valid_to !== null && p.valid_to <= p.valid_from) throw new ApiError("invalid_payload");
    if (p.supersedes_licence_id !== null) {
      // active → superseded is the only status move a renewal makes; the guard's transition table also enforces it.
      const r = await c.query(`UPDATE core.licence SET status = 'superseded' WHERE id = $1 AND status = 'active'`, [p.supersedes_licence_id]);
      if (r.rowCount !== 1) throw new ApiError("not_found");
    }
    const r = await c.query(
      `INSERT INTO core.licence (tenant_id, id, outlet_id, kind, number, issuer, valid_from, valid_to, document_id, created_by)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME}) ON CONFLICT DO NOTHING`,
      [p.licence_id, p.outlet_id, p.kind, p.number, p.issuer, p.valid_from, p.valid_to, p.document_id]);
    taken(r.rowCount ?? 0);
    return {
      entityId: p.licence_id,
      audit: [
        { entity: "core.licence", entityId: p.licence_id, after: { kind: p.kind, outlet_id: p.outlet_id, valid_to: p.valid_to } },
        ...(p.supersedes_licence_id ? [{ entity: "core.licence", entityId: p.supersedes_licence_id, after: { status: "superseded" } }] : []),
      ],
    };
  },
};

export const checklistUpsert: CommandHandler = {
  type: "compliance.checklist.upsert.v1",
  async run(c, cmd) {
    const p = parse(ComplianceChecklistUpsertV1, cmd.payload);
    const prior = await one<{ outlet_id: string | null; name_key: string; kind: string; frequency: string }>(
      c, `SELECT outlet_id, name_key, kind, frequency FROM core.checklist WHERE id = $1`, [p.checklist_id]);
    if (prior) {
      // Only due time, items and active are mutable (column grants); identity fields must match.
      if (prior.outlet_id !== p.outlet_id || prior.name_key !== p.name_key || prior.kind !== p.kind || prior.frequency !== p.frequency) {
        throw new ApiError("conflict");
      }
      await c.query(`UPDATE core.checklist SET due_time = $2, items = $3, active = $4 WHERE id = $1`,
        [p.checklist_id, p.due_time, JSON.stringify(p.items), p.active]);
    } else {
      await c.query(
        `INSERT INTO core.checklist (tenant_id, id, outlet_id, name_key, kind, frequency, due_time, items, active, created_by)
         VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME})`,
        [p.checklist_id, p.outlet_id, p.name_key, p.kind, p.frequency, p.due_time, JSON.stringify(p.items), p.active]);
    }
    return { entityId: p.checklist_id, audit: [{ entity: "core.checklist", entityId: p.checklist_id, after: { name_key: p.name_key, active: p.active } }] };
  },
};

export const checklistComplete: CommandHandler = {
  type: "compliance.checklist.complete.v1",
  async run(c, cmd) {
    const p = parse(ComplianceChecklistCompleteV1, cmd.payload);
    const cl = need(await one<{ outlet_id: string | null; items: string[]; active: boolean }>(
      c, `SELECT outlet_id, items, active FROM core.checklist WHERE id = $1`, [p.checklist_id]));
    const outlet = need(await one<{ tz: string }>(c, `SELECT tz FROM core.outlet WHERE id = $1`, [p.outlet_id]));
    if (!cl.active || (cl.outlet_id !== null && cl.outlet_id !== p.outlet_id)) throw new ApiError("conflict");
    // Every item answered, nothing extra: a run is the whole list, so coverage counts runs, not ticks.
    const keys = Object.keys(p.results).sort();
    if (keys.length !== cl.items.length || [...cl.items].sort().some((k, i) => k !== keys[i])) throw new ApiError("invalid_payload");
    // Outlet-local today: a run cannot be filed for a day that has not started there.
    if (p.business_date > localDate(await nowIso(c), outlet.tz)) throw new ApiError("invalid_payload");
    const r = await c.query(
      `INSERT INTO core.checklist_run (tenant_id, id, checklist_id, outlet_id, business_date, results, completed_by)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, ${ME}) ON CONFLICT DO NOTHING`,
      [p.run_id, p.checklist_id, p.outlet_id, p.business_date, JSON.stringify(p.results)]);
    taken(r.rowCount ?? 0); // also: one run per checklist, outlet and day
    return { entityId: p.run_id, audit: [{ entity: "core.checklist_run", entityId: p.run_id, after: { checklist_id: p.checklist_id, business_date: p.business_date } }] };
  },
};

export const tempRecord: CommandHandler = {
  type: "compliance.temp.record.v1",
  async run(c, cmd) {
    const p = parse(ComplianceTempRecordV1, cmd.payload);
    need(await one(c, `SELECT 1 FROM core.asset WHERE id = $1 AND outlet_id = $2`, [p.asset_id, p.outlet_id]));
    const ahead = await one<{ ok: boolean }>(c, `SELECT $1::timestamptz <= now() + interval '5 minutes' AS ok`, [p.read_at]);
    if (!ahead!.ok) throw new ApiError("invalid_payload");
    const r = await c.query(
      `INSERT INTO core.temp_log (tenant_id, id, outlet_id, asset_id, reading_milli_c, read_at, recorded_by, note)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, ${ME}, $6) ON CONFLICT DO NOTHING`,
      [p.log_id, p.outlet_id, p.asset_id, p.reading_milli_c, p.read_at, p.note]);
    taken(r.rowCount ?? 0);
    return { entityId: p.log_id, audit: [{ entity: "core.temp_log", entityId: p.log_id, after: { asset_id: p.asset_id, read_at: p.read_at } }] };
  },
};

export const assetUpsert: CommandHandler = {
  type: "compliance.asset.upsert.v1",
  async run(c, cmd) {
    const p = parse(ComplianceAssetUpsertV1, cmd.payload);
    const bothOrNeither = (p.safe_min_milli_c === null) === (p.safe_max_milli_c === null);
    if (!bothOrNeither || (p.safe_min_milli_c !== null && p.safe_min_milli_c >= p.safe_max_milli_c!)) throw new ApiError("invalid_payload");
    const prior = await one<{ outlet_id: string; kind: string; installed_on: string | null }>(
      c, `SELECT outlet_id, kind, installed_on::text FROM core.asset WHERE id = $1`, [p.asset_id]);
    if (prior) {
      if (prior.outlet_id !== p.outlet_id || prior.kind !== p.kind || prior.installed_on !== p.installed_on) throw new ApiError("conflict");
      await c.query(
        `UPDATE core.asset SET name = $2, make_model = $3, serial_no = $4, safe_min_milli_c = $5, safe_max_milli_c = $6, active = $7 WHERE id = $1`,
        [p.asset_id, p.name, p.make_model, p.serial_no, p.safe_min_milli_c, p.safe_max_milli_c, p.active]);
    } else {
      await c.query(
        `INSERT INTO core.asset (tenant_id, id, outlet_id, kind, name, make_model, serial_no, safe_min_milli_c, safe_max_milli_c, installed_on, active, created_by)
         VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${ME})`,
        [p.asset_id, p.outlet_id, p.kind, p.name, p.make_model, p.serial_no, p.safe_min_milli_c, p.safe_max_milli_c, p.installed_on, p.active]);
    }
    return { entityId: p.asset_id, audit: [{ entity: "core.asset", entityId: p.asset_id, after: { kind: p.kind, active: p.active } }] };
  },
};

export const amcRecord: CommandHandler = {
  type: "compliance.amc.record.v1",
  async run(c, cmd) {
    const p = parse(ComplianceAmcRecordV1, cmd.payload);
    if (p.valid_to <= p.valid_from) throw new ApiError("invalid_payload");
    if (p.cost.currency !== (await tenantCurrency(c))) throw new ApiError("currency_mismatch");
    need(await one(c, `SELECT 1 FROM core.asset WHERE id = $1`, [p.asset_id]));
    // Overlapping AMCs are allowed on purpose: the overlap is a finding, not an error (pack A3).
    const r = await c.query(
      `INSERT INTO core.amc (tenant_id, id, asset_id, vendor, valid_from, valid_to, cost_minor, currency, document_id, created_by)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME}) ON CONFLICT DO NOTHING`,
      [p.amc_id, p.asset_id, p.vendor, p.valid_from, p.valid_to, p.cost.amount_minor, p.cost.currency, p.document_id]);
    taken(r.rowCount ?? 0);
    return { entityId: p.amc_id, audit: [{ entity: "core.amc", entityId: p.amc_id, after: { asset_id: p.asset_id, valid_from: p.valid_from, valid_to: p.valid_to } }] };
  },
};

/** Draftable (R16): intel proposes, a named person approves; the row is written only under the approval. */
export const maintenanceSchedule: CommandHandler = {
  type: "compliance.maintenance.schedule.v1",
  async run(c, cmd) {
    const p = parse(ComplianceMaintenanceScheduleV1, cmd.payload);
    need(await one(c, `SELECT 1 FROM core.asset WHERE id = $1 AND outlet_id = $2`, [p.asset_id, p.outlet_id]));
    const currency = p.estimated_cost_minor === null ? null : await tenantCurrency(c);
    const r = await c.query(
      `INSERT INTO core.maintenance (tenant_id, id, asset_id, kind, status, due_on, estimated_cost_minor, currency, vendor, created_by)
       VALUES (${TENANT}, $1, $2, $3, 'scheduled', $4, $5, $6, $7, ${ME}) ON CONFLICT DO NOTHING`,
      [p.maintenance_id, p.asset_id, p.kind, p.due_on, p.estimated_cost_minor, currency, p.vendor_note]);
    taken(r.rowCount ?? 0);
    return { entityId: p.maintenance_id, audit: [{ entity: "core.maintenance", entityId: p.maintenance_id, after: { asset_id: p.asset_id, kind: p.kind, due_on: p.due_on, status: "scheduled" } }] };
  },
};

export const maintenanceRecord: CommandHandler = {
  type: "compliance.maintenance.record.v1",
  async run(c, cmd) {
    const p = parse(ComplianceMaintenanceRecordV1, cmd.payload);
    const currency = await tenantCurrency(c);
    if (p.amc_id !== null) need(await one(c, `SELECT 1 FROM core.amc WHERE id = $1 AND asset_id = $2`, [p.amc_id, p.asset_id]));
    const prior = await one<{ asset_id: string; kind: string; status: string }>(
      c, `SELECT asset_id, kind, status FROM core.maintenance WHERE id = $1`, [p.maintenance_id]);
    if (prior) {
      if (prior.asset_id !== p.asset_id || prior.kind !== p.kind || prior.status !== "scheduled") throw new ApiError("conflict");
      await c.query(
        `UPDATE core.maintenance SET status = 'done', done_on = $2, cost_minor = $3, currency = $4, vendor = $5, amc_id = $6, note = $7 WHERE id = $1`,
        [p.maintenance_id, p.done_on, p.cost_minor, currency, p.vendor, p.amc_id, p.note]);
    } else {
      need(await one(c, `SELECT 1 FROM core.asset WHERE id = $1`, [p.asset_id]));
      await c.query(
        `INSERT INTO core.maintenance (tenant_id, id, asset_id, kind, status, done_on, cost_minor, currency, vendor, amc_id, note, created_by)
         VALUES (${TENANT}, $1, $2, $3, 'done', $4, $5, $6, $7, $8, $9, ${ME})`,
        [p.maintenance_id, p.asset_id, p.kind, p.done_on, p.cost_minor, currency, p.vendor, p.amc_id, p.note]);
    }
    return { entityId: p.maintenance_id, audit: [{ entity: "core.maintenance", entityId: p.maintenance_id, after: { asset_id: p.asset_id, kind: p.kind, status: "done", done_on: p.done_on } }] };
  },
};
