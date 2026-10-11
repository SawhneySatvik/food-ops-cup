// Draft execution handlers (approvals runs them inside the approving transaction, under the approver's
// identity with app.decision_id set — R15, R28).
//   imports.run.commit.v1      staged rows → book rows as the approver; the run → committed under the decision.
//   imports.format.approve.v1  a tenant's mapping (renames + units only) → core.import_format.
// Settlements and bank lines go through finance's seams (recordSettlement posts and reconciles); imported
// expenses are posted with finance's postFor, exactly as finance.expense.record.v1 posts its own. POS bills (a POS
// export, or pos_bills_v2 history with lines) and waste history are written by write.ts — batched (R44c), every row
// still judged by the guard, derived rows computed by the same core-domain functions the seams use.
import type { ImportKind } from "@munim/contracts/imports";
import type { CountryPack } from "@munim/contracts/packs";
import type { TenderMethod } from "@munim/core-domain/finance";
import { orderTax } from "@munim/core-domain/packs";
import { businessDate, localToInstant } from "@munim/core-domain/tz";
import type { CommandHandler, HandlerOutput } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { type BankLineInput, postFor, recordBankLines, recordSettlement, type SettlementInput } from "../finance/index.ts";
import { builtInBySignature, checkMapping, headerSignature, type MappingEntry } from "./formats.ts";
import { type StagedCountLine, writeCounts } from "./counts.ts";
import { type StagedShift, writeShifts } from "./shifts.ts";
import { type Bill, type Waste, writeBills, writeWaste, type WriteMode } from "./write.ts";

interface Decision {
  id: string;
  draft_id: string;
  reason: string | null;
  decided_by: string;
}

/** The decision this transaction executes (approvals sets app.decision_id). None → not an approval: refused. */
async function decisionOf(c: Queryable): Promise<Decision> {
  const d = (await c.query<Decision>(
    `SELECT id, draft_id, reason, decided_by FROM core.decision WHERE id = nullif(current_setting('app.decision_id', true), '')::uuid`)).rows[0];
  if (!d) throw new ApiError("forbidden", "authority_denied");
  return d;
}

interface StagedRow {
  row_no: number;
  data: Record<string, unknown>;
  amount_minor: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** The commit handler. `mode` is "batched" for every approval; "seams" (the per-row reference path through the
 *  owners' seams) exists for the equivalence gate only. */
export async function commitRun(c: Queryable, cmd: Parameters<CommandHandler["run"]>[1], mode: WriteMode = "batched"): Promise<HandlerOutput> {
  const { import_run_id } = cmd.payload as { import_run_id: string };
  const dec = await decisionOf(c);
  const run = (await c.query<{ id: string; kind: string; status: string; draft_id: string | null; document_id: string;
    rows_ok: number; control_total_minor: string | null; base_currency: string }>(
    `SELECT r.id, r.kind, r.status, r.draft_id, r.document_id, r.rows_ok, r.control_total_minor, t.base_currency
       FROM core.import_run r JOIN core.tenant t ON t.tenant_id = r.tenant_id
      WHERE r.id = $1 FOR UPDATE OF r`, [import_run_id])).rows[0];
  // Only the run this very draft was created for, and only from the preview the person saw.
  if (!run || run.draft_id !== dec.draft_id || run.status !== "previewed") throw new ApiError("invalid_payload");
  const staged = (await c.query<StagedRow>(
    `SELECT row_no, data, amount_minor FROM core.import_staging WHERE import_run_id = $1 ORDER BY row_no`, [run.id])).rows;
  if (staged.length !== run.rows_ok) throw new Error("imports: staged rows differ from the run's rows_ok");
  // A file whose ready rows do not add up to its printed total may still be approved — with a reason (G-IMP-2).
  if (run.control_total_minor !== null) {
    const sum = staged.reduce((a, s) => a + BigInt(s.amount_minor ?? 0), 0n);
    if (sum !== BigInt(run.control_total_minor) && !dec.reason?.trim()) throw new ApiError("invalid_payload");
  }
  const currency = run.base_currency;
  const by = dec.decided_by;
  const written: Record<string, number> = {};
  // Committed FIRST, in this same transaction: finance's seams and derivation rules (source_state) admit
  // settlement and bank rows only for a committed run, and the row's decision_id names this approval.
  await c.query(`UPDATE core.import_run SET status = 'committed', decision_id = $2 WHERE id = $1`, [run.id, dec.id]);

  switch (run.kind) {
    case "payout_statement": {
      const payouts = new Map<string, StagedRow[]>();
      for (const s of staged) {
        const ref = String(s.data.payout_ref);
        payouts.set(ref, [...(payouts.get(ref) ?? []), s]);
      }
      for (const [ref, rows] of payouts) {
        const head = rows[0]!.data;
        const orderRefs = rows.map((r) => str(r.data.order_ref)).filter((x): x is string => x !== null);
        const matched = new Map((await c.query<{ id: string; external_ref: string }>(
          `SELECT id, external_ref FROM core."order" WHERE channel_id = $1 AND external_ref = ANY($2::text[])`,
          [head.channel_id, orderRefs])).rows.map((o) => [o.external_ref, o.id]));
        const lines: SettlementInput["lines"] = rows.map((r, i) => ({
          line_id: uuidv7(),
          line_no: i + 1,
          line_kind: r.data.line_kind as SettlementInput["lines"][number]["line_kind"],
          external_order_ref: str(r.data.order_ref),
          matched_order_id: r.data.line_kind === "order" ? matched.get(String(r.data.order_ref)) ?? null : null,
          gross_minor: Number(r.data.gross_minor), commission_minor: Number(r.data.commission_minor),
          ad_fee_minor: Number(r.data.ad_fee_minor), promo_share_minor: Number(r.data.promo_share_minor),
          tax_withheld_minor: Number(r.data.tax_withheld_minor), net_minor: Number(r.data.net_minor),
        }));
        // The payout's net is the sum of its lines' nets — each the file's own figure, checked against its parts.
        const net = lines.reduce((a, l) => a + l.net_minor, 0);
        await recordSettlement(c, {
          settlement_id: uuidv7(), channel_id: String(head.channel_id), outlet_id: str(head.outlet_id),
          period_from: String(head.period_from), period_to: String(head.period_to), paid_on: str(head.paid_on), external_ref: ref,
          net_minor: net, currency, import_run_id: run.id, lines,
        });
        written.settlements = (written.settlements ?? 0) + 1;
        written.settlement_lines = (written.settlement_lines ?? 0) + lines.length;
      }
      break;
    }
    case "bank_statement": {
      await recordBankLines(c, run.id, staged.map((s) => ({
        bank_line_id: uuidv7(), outlet_id: str(s.data.outlet_id), account_ref: String(s.data.account_ref),
        value_date: String(s.data.value_date), amount_minor: Number(s.data.amount_minor), currency,
        method: s.data.method as BankLineInput["method"], payee_vpa: str(s.data.payee_vpa), narration: str(s.data.narration),
        external_ref: String(s.data.external_ref),
      })));
      written.bank_lines = staged.length;
      break;
    }
    case "tally_export": {
      const rows = staged.map((s) => ({ ...s.data, id: uuidv7() }));
      await c.query(
        `INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, tax_minor, currency, payee, note, document_id, created_by)
         SELECT current_setting('app.tenant_id')::uuid, x.id, x.outlet_id, x.category, x.incurred_on, x.amount_minor, x.tax_minor, $1, x.payee,
                x.note, $2, $3
           FROM jsonb_to_recordset($4::jsonb) AS x (id uuid, outlet_id uuid, category text, incurred_on date, amount_minor bigint, tax_minor bigint,
                payee text, note text)`,
        [currency, run.document_id, by, JSON.stringify(rows)]);
      // Each expense is posted as finance posts its own recorded expenses (finance.post_expense).
      for (const r of rows) await postFor(c, "finance.post_expense", `core.expense:${r.id}`);
      written.expenses = staged.length;
      break;
    }
    case "pos_export": {
      // Another POS's bills: completed orders on the counter channel, numbered by that POS (external_ref = the bill
      // number; the database assigns no invoice number and keeps the bill's business date), each with the tender its
      // payment mode names, taken at noon of the bill's date. Amounts are the file's own (checked: total = subtotal −
      // discount + tax); there are no lines, so no stock is consumed.
      const channel = (await c.query<{ id: string }>(
        `SELECT id FROM core.channel WHERE kind = 'counter' AND active ORDER BY created_at, id LIMIT 1`)).rows[0];
      if (!channel) throw new ApiError("invalid_payload");
      const tz = await outletZones(c);
      await refuseClosed(c, staged.map((s) => ({ outlet_id: String(s.data.outlet_id), date: String(s.data.bill_date) })));
      const bills: Bill[] = staged.map((s) => {
        const d = s.data as { bill_no: string; bill_date: string; outlet_id: string; order_type: string; payment_mode: TenderMethod | null;
          subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number };
        return {
          bill_no: d.bill_no, business_date: d.bill_date, at: localToInstant(d.bill_date, "12:00", tz.get(d.outlet_id)!.tz).toISOString(),
          outlet_id: d.outlet_id, channel_id: channel.id, channel_kind: "counter", brand_id: null, kind: d.order_type, customer_id: null,
          status: "completed", subtotal_minor: d.subtotal_minor, discount_minor: d.discount_minor, tax_minor: d.tax_minor, total_minor: d.total_minor,
          lines: [], tenders: d.payment_mode && d.total_minor > 0 ? [{ method: d.payment_mode, amount_minor: d.total_minor }] : [], refund: null,
          void_reason: null, snapshot: { source: "pos_export", synthetic: true, import_run_id: run.id, row_no: s.row_no },
        };
      });
      await writeBills(c, bills, { by, currency }, mode);
      written.orders = bills.length;
      break;
    }
    case "pos_bills": {
      const bills = await billsOf(c, staged, run.id);
      await writeBills(c, bills, { by, currency }, mode);
      written.orders = bills.length;
      written.order_lines = staged.length;
      break;
    }
    case "waste_log": {
      await refuseClosed(c, staged.map((s) => ({ outlet_id: String(s.data.outlet_id), date: String(s.data.waste_date) })));
      const rows: Waste[] = staged.map((s) => {
        const d = s.data as unknown as Waste;
        return { at: d.at, outlet_id: d.outlet_id, ingredient_id: d.ingredient_id, qty_milli: d.qty_milli, unit: d.unit, reason: d.reason, note: d.note };
      });
      await writeWaste(c, rows, { by, currency }, mode);
      written.waste = rows.length;
      break;
    }
    case "shift_log": {
      await refuseClosed(c, staged.map((s) => ({ outlet_id: String(s.data.outlet_id), date: String(s.data.shift_date) })));
      await writeShifts(c, staged.map((s) => s.data as unknown as StagedShift), currency);
      written.shifts = staged.length;
      break;
    }
    case "stock_count": {
      await refuseClosed(c, staged.map((s) => ({ outlet_id: String(s.data.outlet_id), date: String(s.data.count_date) })));
      const w = await writeCounts(c, staged.map((s) => s.data as unknown as StagedCountLine));
      written.stock_counts = w.counts;
      written.stock_count_lines = w.lines;
      written.count_adjustments = w.adjustments;
      break;
    }
    case "market_signal": {
      // Operational rows that exist only inside this approval (0014 market_signal_from_import).
      await c.query(
        `INSERT INTO core.market_signal (tenant_id, id, outlet_id, on_date, kind, label, value_milli, unit, source, import_run_id, created_by)
         SELECT current_setting('app.tenant_id')::uuid, x.id, x.outlet_id, x.on_date, x.kind, x.label, x.value_milli, x.unit, x.source, $1, $2
           FROM jsonb_to_recordset($3::jsonb) AS x (id uuid, outlet_id uuid, on_date date, kind text, label text, value_milli bigint, unit text, source text)`,
        [run.id, by, JSON.stringify(staged.map((s) => ({ ...s.data, id: uuidv7() })))]);
      written.market_signals = staged.length;
      break;
    }
  }
  return { entityId: run.id, audit: [{ entity: "core.import_run", entityId: run.id, after: { status: "committed", kind: run.kind, written } }] };
}

export const runCommitHandler: CommandHandler = {
  type: "imports.run.commit.v1",
  run: (c, cmd) => commitRun(c, cmd, "batched"),
};

async function outletZones(c: Queryable) {
  return new Map((await c.query<{ id: string; tz: string; cutoff: string }>(
    `SELECT id, tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff FROM core.outlet`)).rows.map((o) => [o.id, o]));
}

/** A period closed since the preview: the approval is refused before anything is written (the rows were checked
 *  open when parsed; journal entries would meet MB009 anyway, waste entries would not). */
async function refuseClosed(c: Queryable, dated: ReadonlyArray<{ outlet_id: string; date: string }>): Promise<void> {
  const hit = await c.query(
    `SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x (outlet_id uuid, date date)
       JOIN core.period_close pc ON pc.period_month = date_trunc('month', x.date)::date AND (pc.outlet_id IS NULL OR pc.outlet_id = x.outlet_id)
      LIMIT 1`, [JSON.stringify(dated)]);
  if (hit.rowCount) throw new ApiError("period_closed", "period_closed");
}

type BillRow = {
  bill_no: string; bill_date: string; at: string; outlet_id: string; channel_id: string; channel_kind: string; brand_id: string | null; kind: string;
  customer_id: string | null; status: "completed" | "cancelled"; line_no: number; item_id: string; variant_id: string | null; qty_milli: number;
  unit_price_minor: number; tax_class: string; line_discount_minor: number; line_tax_minor: number; line_total_minor: number; void_reason: string | null;
  cash_minor: number; card_minor: number; upi_minor: number; refund_minor: number; refund_method: TenderMethod | null; refund_reason: string | null;
  refund_at: string | null;
};

/** pos_bills_v2 staged lines → bills. Tax and totals are derived again here with the pack and item MRPs in force now
 *  (rule 9: never the file's, never the client's); a figure that moved since the preview the person approved makes the
 *  draft stale (R-A 6) rather than commit numbers they did not see. */
async function billsOf(c: Queryable, staged: readonly StagedRow[], runId: string): Promise<Bill[]> {
  const pack = (await c.query<{ doc: CountryPack }>(
    `SELECT p.doc FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = current_setting('app.tenant_id')::uuid ORDER BY p.version DESC LIMIT 1`)).rows[0]!.doc;
  const groups = new Map<string, BillRow[]>();
  for (const s of staged) {
    const d = s.data as BillRow;
    groups.set(d.bill_no, [...(groups.get(d.bill_no) ?? []), d]);
  }
  const mrp = new Map((await c.query<{ id: string; mrp_minor: string | null }>(
    `SELECT id, mrp_minor::text FROM core.item WHERE id = ANY ($1::uuid[])`, [[...new Set(staged.map((s) => String(s.data.item_id)))]])).rows
    .map((i) => [i.id, i.mrp_minor === null ? null : Number(i.mrp_minor)]));
  const zones = await outletZones(c);
  const dated: Array<{ outlet_id: string; date: string }> = [];
  const bills = [...groups.values()].map((rows) => {
    const h = rows[0]!;
    const priced = orderTax(pack, { channel_kind: h.channel_kind, lines: rows.map((r) => ({
      name: String(r.line_no), qty_milli: r.qty_milli, unit_price_minor: r.unit_price_minor, line_discount_minor: r.line_discount_minor, tax_class: r.tax_class,
      mrp_minor: mrp.get(r.item_id) ?? null })) });
    if (!priced.ok) throw new ApiError("invalid_payload");
    if (priced.tax.lines.some((t, i) => t.tax_minor !== rows[i]!.line_tax_minor || t.total_minor !== rows[i]!.line_total_minor)) {
      throw new ApiError("stale_draft", "stale_draft");
    }
    const t = priced.tax;
    const discount = t.lines.reduce((a, l) => a + l.discount_minor, 0);
    dated.push({ outlet_id: h.outlet_id, date: h.bill_date });
    if (h.refund_at) dated.push({ outlet_id: h.outlet_id, date: businessDate(h.refund_at, zones.get(h.outlet_id)!.tz, zones.get(h.outlet_id)!.cutoff) });
    const bill: Bill = {
      bill_no: h.bill_no, business_date: h.bill_date, at: h.at, outlet_id: h.outlet_id, channel_id: h.channel_id, channel_kind: h.channel_kind,
      brand_id: h.brand_id, kind: h.kind, customer_id: h.customer_id, status: h.status,
      // The order header as placement writes it (orders/pricing.ts): subtotal = total + discount − tax.
      subtotal_minor: t.total_minor + discount - t.tax_minor, discount_minor: discount, tax_minor: t.tax_minor, total_minor: t.total_minor,
      lines: rows.map((r, i) => ({ item_id: r.item_id, variant_id: r.variant_id, qty_milli: r.qty_milli, unit_price_minor: r.unit_price_minor,
        line_discount_minor: t.lines[i]!.discount_minor, tax_minor: t.lines[i]!.tax_minor, total_minor: t.lines[i]!.total_minor,
        void_reason: h.status === "completed" ? r.void_reason : null })),
      tenders: (["cash", "card", "upi"] as const).flatMap((m) => (h[`${m}_minor`] > 0 ? [{ method: m, amount_minor: h[`${m}_minor`] }] : [])),
      refund: h.refund_minor > 0 ? { method: h.refund_method!, amount_minor: h.refund_minor, reason_code: h.refund_reason!, at: h.refund_at! } : null,
      void_reason: h.status === "cancelled" ? h.void_reason : null,
      snapshot: { source: "pos_bills_v2", synthetic: true, import_run_id: runId, bill_no: h.bill_no, tax: t.components },
    };
    return bill;
  });
  await refuseClosed(c, dated);
  return bills;
}

export const formatApproveHandler: CommandHandler = {
  type: "imports.format.approve.v1",
  async run(c, cmd) {
    const p = cmd.payload as { format_id: string; kind: ImportKind; name: string; header: string[]; header_signature: string; mapping: MappingEntry[] };
    const dec = await decisionOf(c);
    // The approved payload is checked again here: whoever proposed it (a member or intel), the saved mapping is
    // renames + units over this exact header, and a layout a built-in already reads is not re-mapped.
    if (headerSignature(p.header) !== p.header_signature || checkMapping(p.kind, p.header, p.mapping) || builtInBySignature(p.header_signature)) {
      throw new ApiError("invalid_payload");
    }
    await c.query(
      `INSERT INTO core.import_format (tenant_id, id, kind, name, header_signature, mapping, decision_id, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
      [p.format_id, p.kind, p.name, p.header_signature, JSON.stringify(p.mapping), dec.id, dec.decided_by]);
    return { entityId: p.format_id, audit: [{ entity: "core.import_format", entityId: p.format_id, after: { kind: p.kind, header_signature: p.header_signature } }] };
  },
};
