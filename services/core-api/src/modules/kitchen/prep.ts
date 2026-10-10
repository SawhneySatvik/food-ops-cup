// Prep times and prep lists (T-023). A prep list is a draft until a manager approves it (R16): intel proposes
// kitchen.prep_list.create.v1 / kitchen.prep_time.set.v1 as core.draft rows, nothing here writes a quantity until
// approvals executes the handler under the approver's decision (or a manager runs the command as their own).
import type { CommandHandler } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

/** kitchen.prep_time.set.v1 — operational (core.prep_time): closes the open row, then inserts the new one. */
export const prepTimeHandler: CommandHandler = {
  type: "kitchen.prep_time.set.v1",
  async run(c, cmd) {
    const p = cmd.payload as { outlet_id: string; item_id: string; station: string; prep_sec: number; valid_from: string };
    const prior = await c.query<{ id: string; valid_from: string }>(
      `SELECT id, valid_from::text AS valid_from FROM core.prep_time
        WHERE outlet_id = $1 AND item_id = $2 AND station = $3 ORDER BY valid_from DESC LIMIT 1 FOR UPDATE`,
      [p.outlet_id, p.item_id, p.station]);
    const last = prior.rows[0];
    // The new row must start after the latest one (history is never rewritten; the exclusion constraint agrees).
    if (last && last.valid_from >= p.valid_from) throw new ApiError("conflict");
    if (last) await c.query(`UPDATE core.prep_time SET valid_to = $2::date WHERE id = $1 AND (valid_to IS NULL OR valid_to > $2::date)`, [last.id, p.valid_from]);
    const id = uuidv7();
    await c.query(
      `INSERT INTO core.prep_time (tenant_id, id, outlet_id, item_id, station, prep_sec, valid_from, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, nullif(current_setting('app.member_id', true), '')::uuid)`,
      [id, p.outlet_id, p.item_id, p.station, p.prep_sec, p.valid_from]);
    return {
      entityId: id,
      audit: [{ entity: "core.prep_time", entityId: id, before: last ? { prev_valid_from: last.valid_from } : null,
        after: { outlet_id: p.outlet_id, item_id: p.item_id, station: p.station, prep_sec: p.prep_sec, valid_from: p.valid_from } }],
    };
  },
};

/** kitchen.prep_list.create.v1 — writes exactly core.prep_list + one prep_list_line per payload line. */
export const prepListHandler: CommandHandler = {
  type: "kitchen.prep_list.create.v1",
  async run(c, cmd) {
    const p = cmd.payload as { prep_list_id: string; outlet_id: string; business_date: string; lines: Array<{ ingredient_id: string; qty_milli: number; unit: string }> };
    // One live list per outlet and business date.
    const dup = await c.query(`SELECT 1 FROM core.prep_list WHERE outlet_id = $1 AND business_date = $2::date AND status <> 'cancelled'`, [p.outlet_id, p.business_date]);
    if (dup.rowCount) throw new ApiError("conflict");
    // draft_id is the approved draft this list came from (null for a manager's own list).
    const draft = await c.query<{ draft_id: string }>(
      `SELECT draft_id FROM core.decision WHERE id = nullif(current_setting('app.decision_id', true), '')::uuid`);
    await c.query(
      `INSERT INTO core.prep_list (tenant_id, id, outlet_id, business_date, status, draft_id, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'open', $4, nullif(current_setting('app.member_id', true), '')::uuid)`,
      [p.prep_list_id, p.outlet_id, p.business_date, draft.rows[0]?.draft_id ?? null]);
    for (const l of p.lines) {
      await c.query(
        `INSERT INTO core.prep_list_line (tenant_id, id, prep_list_id, ingredient_id, qty_milli, unit, created_by)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, nullif(current_setting('app.member_id', true), '')::uuid)`,
        [uuidv7(), p.prep_list_id, l.ingredient_id, l.qty_milli, l.unit]);
    }
    return {
      entityId: p.prep_list_id,
      audit: [{ entity: "core.prep_list", entityId: p.prep_list_id,
        after: { outlet_id: p.outlet_id, business_date: p.business_date, lines: p.lines.length, draft_id: draft.rows[0]?.draft_id ?? null } }],
    };
  },
};

export interface PrepListView {
  outlet_id: string;
  business_date: string;
  state: "approved" | "waiting" | "none" | "cannot_verify";
  reason_code: "forecast_stale" | null;
  prep_list: null | {
    prep_list_id: string; status: "open" | "done" | "cancelled"; draft_id: string | null;
    lines: Array<{ ingredient_id: string | null; item_id: string | null; qty_milli: number; unit: string }>;
  };
}

/** K3 states. Quantities appear only for an existing (approved/own) list; a proposed draft shows no numbers. A
 *  date with no list, no draft and no forecast cannot be verified (`forecast_stale`) — never a guess. */
export async function prepListView(c: Queryable, outletId: string, businessDate: string): Promise<PrepListView> {
  const base = { outlet_id: outletId, business_date: businessDate };
  const list = (await c.query<{ id: string; status: "open" | "done" | "cancelled"; draft_id: string | null }>(
    `SELECT id, status, draft_id FROM core.prep_list WHERE outlet_id = $1 AND business_date = $2::date AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`,
    [outletId, businessDate])).rows[0];
  if (list) {
    const lines = (await c.query<{ ingredient_id: string | null; item_id: string | null; qty_milli: string; unit: string }>(
      `SELECT ingredient_id, item_id, qty_milli::text AS qty_milli, unit FROM core.prep_list_line WHERE prep_list_id = $1 ORDER BY created_at, id`, [list.id])).rows;
    return { ...base, state: "approved", reason_code: null,
      prep_list: { prep_list_id: list.id, status: list.status, draft_id: list.draft_id, lines: lines.map((l) => ({ ...l, qty_milli: Number(l.qty_milli) })) } };
  }
  const waiting = await c.query(
    `SELECT 1 FROM core.draft WHERE command_type = 'kitchen.prep_list.create.v1' AND status = 'proposed'
        AND command_payload->>'outlet_id' = $1 AND command_payload->>'business_date' = $2 LIMIT 1`, [outletId, businessDate]);
  if (waiting.rowCount) return { ...base, state: "waiting", reason_code: null, prep_list: null };
  const forecast = await c.query(`SELECT 1 FROM intel.forecast_point WHERE outlet_id = $1 AND business_on = $2::date LIMIT 1`, [outletId, businessDate]);
  return forecast.rowCount
    ? { ...base, state: "none", reason_code: null, prep_list: null }
    : { ...base, state: "cannot_verify", reason_code: "forecast_stale", prep_list: null };
}
