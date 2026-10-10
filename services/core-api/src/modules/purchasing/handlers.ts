// Purchasing command handlers. Each is bound to one seeded command type and writes only that command's
// target_tables (0007/0008); derived rows (stock movements, payable, postings) are written under the seeded
// derivation rule + source row, in the same transaction. Totals are computed here, never taken from a client.
import {
  PurchasingGrnReceiveV1, PurchasingInvoiceApproveV1, PurchasingInvoiceDisputeV1, PurchasingInvoiceRecordV1, PurchasingPoCreateV1,
  PurchasingSupplierReturnCreateV1, PurchasingSupplierUpsertV1,
} from "@munim/contracts/purchasing";
import { mulDiv } from "@munim/core-domain/money";
import { type AuditEntry, type CommandHandler, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { seams } from "./seams.ts";

/** The goods-received command (seeded in core.command_authority by 0015 A4). */
export const GRN_COMMAND = "purchasing.grn.receive.v1";

const T = "current_setting('app.tenant_id')::uuid";
const ME = "nullif(current_setting('app.member_id', true), '')::uuid";
const bad = () => new ApiError("bad_request");

type Row = Record<string, unknown>;
const first = async <R extends Row>(c: Queryable, sql: string, params: unknown[] = []): Promise<R | undefined> => (await c.query<R>(sql, params)).rows[0];
const setting = async (c: Queryable, key: string) =>
  (await c.query<{ v: string | null }>(`SELECT nullif(current_setting($1, true), '') AS v`, [key])).rows[0]!.v;

/** Runs `fn` with the derivation rule and its source row set for the guard (03-arch §1.3 branch 3), then clears them. */
async function underRule<R>(c: Queryable, rule: string, source: string, fn: () => Promise<R>): Promise<R> {
  await c.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [rule, source]);
  const out = await fn();
  await c.query(`SELECT set_config('app.posting_rule', '', true), set_config('app.source_ref', '', true)`);
  return out;
}

const lineAmount = (qtyMilli: number, unitPriceMinor: number) => mulDiv(qtyMilli, unitPriceMinor, 1000);

// ---- suppliers ----
export const supplierUpsert: CommandHandler = {
  type: "purchasing.supplier.upsert.v1",
  async run(c, command) {
    const p = PurchasingSupplierUpsertV1.parse(command.payload);
    const prior = await first<{ kind: string }>(c, `SELECT kind FROM core.supplier WHERE id = $1`, [p.supplier_id]);
    if (prior) {
      // kind has no UPDATE grant: a simulated supplier cannot be relabelled real (or the reverse).
      if (prior.kind !== p.kind) throw new ApiError("conflict");
      await c.query(`UPDATE core.supplier SET name = $2, a2a_card_url = $3, terms = $4 WHERE id = $1`, [p.supplier_id, p.name, p.a2a_card_url, p.terms]);
    } else {
      await c.query(`INSERT INTO core.supplier (tenant_id, id, name, kind, a2a_card_url, terms, created_by) VALUES (${T}, $1, $2, $3, $4, $5, ${ME})`,
        [p.supplier_id, p.name, p.kind, p.a2a_card_url, p.terms]);
    }
    for (const o of p.prices) {
      await c.query(
        `INSERT INTO core.supplier_price (tenant_id, id, supplier_id, ingredient_id, unit, unit_price_minor, currency, observed_at, source_ref)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [o.price_id, p.supplier_id, o.ingredient_id, o.unit, o.unit_price_minor, o.currency, o.observed_at, o.source_ref]);
    }
    return { entityId: p.supplier_id, audit: [{ entity: "core.supplier", entityId: p.supplier_id, after: { kind: p.kind, prices: p.prices.length } }] };
  },
};

// ---- purchase orders ----
export const poCreate: CommandHandler = {
  type: "purchasing.po.create.v1",
  async run(c, command) {
    const p = PurchasingPoCreateV1.parse(command.payload);
    const outlets = [...new Set(p.outlet_ids)];
    const supplier = await first<{ active: boolean }>(c, `SELECT active FROM core.supplier WHERE id = $1`, [p.supplier_id]);
    if (!supplier?.active) throw bad();
    const found = await first<{ n: string }>(c, `SELECT count(*) AS n FROM core.outlet WHERE id = ANY ($1::uuid[])`, [outlets]);
    if (Number(found!.n) !== outlets.length) throw bad();
    const ings = [...new Set(p.lines.map((l) => l.ingredient_id))];
    const known = await first<{ n: string }>(c, `SELECT count(*) AS n FROM core.ingredient WHERE id = ANY ($1::uuid[])`, [ings]);
    if (Number(known!.n) !== ings.length) throw bad();

    const total = p.lines.reduce((t, l) => t + lineAmount(l.qty_milli, l.unit_price_minor), 0);
    await c.query(
      `INSERT INTO core.purchase_order (tenant_id, id, supplier_id, outlet_ids, currency, total_minor, expected_on, negotiation_run_id, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, ${ME})`,
      [p.po_id, p.supplier_id, outlets, p.currency, total, p.expected_on, p.negotiation_run_id]);
    for (const [i, l] of p.lines.entries()) {
      await c.query(`INSERT INTO core.po_line (tenant_id, id, po_id, line_no, ingredient_id, qty_milli, unit, unit_price_minor) VALUES (${T}, $1, $2, $3, $4, $5, $6, $7)`,
        [uuidv7(), p.po_id, i + 1, l.ingredient_id, l.qty_milli, l.unit, l.unit_price_minor]);
    }
    // Set for an approved draft's execution; null for a member's own command (event contract: decision_id nullable).
    const d = await first<{ id: string; draft_id: string }>(c, `SELECT id, draft_id FROM core.decision WHERE id = nullif(current_setting('app.decision_id', true), '')::uuid`);
    return {
      entityId: p.po_id,
      audit: [{ entity: "core.purchase_order", entityId: p.po_id, after: { status: "committed", outlet_ids: outlets } }],
      events: [{ type: "munim.purchasing.po.committed.v1", subject: p.po_id, aggregateType: "purchase_order",
        data: { po_id: p.po_id, supplier_id: p.supplier_id, outlet_ids: outlets, decision_id: d?.id ?? null, draft_id: d?.draft_id ?? null } }],
    };
  },
};

// ---- goods received ----
export const grnReceive: CommandHandler = {
  type: GRN_COMMAND,
  async run(c, command) {
    const p = PurchasingGrnReceiveV1.parse(command.payload);
    const supplier = await first<{ id: string }>(c, `SELECT id FROM core.supplier WHERE id = $1`, [p.supplier_id]);
    if (!supplier) throw bad();

    let po: { supplier_id: string; outlet_ids: string[]; status: string } | undefined;
    const poLines = new Map<string, { ingredient_id: string; unit_price_minor: number }>();
    if (p.po_id) {
      po = await first(c, `SELECT supplier_id, outlet_ids, status FROM core.purchase_order WHERE id = $1`, [p.po_id]);
      if (!po || po.supplier_id !== p.supplier_id || !po.outlet_ids.includes(p.outlet_id)) throw bad();
      if (po.status !== "committed") throw new ApiError("conflict");
      for (const l of (await c.query<{ id: string; ingredient_id: string; unit_price_minor: string }>(
        `SELECT id, ingredient_id, unit_price_minor FROM core.po_line WHERE po_id = $1`, [p.po_id])).rows) {
        poLines.set(l.id, { ingredient_id: l.ingredient_id, unit_price_minor: Number(l.unit_price_minor) });
      }
    }

    await c.query(`INSERT INTO core.goods_received (tenant_id, id, outlet_id, supplier_id, po_id, received_at, received_by, note)
                   VALUES (${T}, $1, $2, $3, $4, coalesce($5::timestamptz, now()), ${ME}, $6)`,
      [p.grn_id, p.outlet_id, p.supplier_id, p.po_id, p.received_at, p.note]);

    for (const l of p.lines) {
      const ing = await first<{ tracked_by_batch: boolean }>(c, `SELECT tracked_by_batch FROM core.ingredient WHERE id = $1`, [l.ingredient_id]);
      if (!ing) throw bad();
      // Batch-tracked stock must say which batch it is, and only tracked stock has one.
      if (ing.tracked_by_batch !== (l.batch !== null)) throw bad();
      let cost = l.unit_cost_minor;
      if (l.po_line_id) {
        const pl = poLines.get(l.po_line_id);
        if (!pl || pl.ingredient_id !== l.ingredient_id) throw bad();
        cost ??= pl.unit_price_minor;
      }
      if (cost === null) throw bad();
      if (l.batch) {
        // The batch first: its link to the line can only be set from the line's side (no UPDATE grant on batch.grn_line_id).
        await c.query(
          `INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, received_at, supplier_id, mrp_minor, currency, created_by)
           VALUES (${T}, $1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8, $9, ${ME})`,
          [l.batch.batch_id, p.outlet_id, l.ingredient_id, l.batch.batch_code, l.batch.expires_on, p.received_at, p.supplier_id,
           l.batch.mrp_minor, l.batch.mrp_minor === null ? null : l.currency]);
      }
      await c.query(
        `INSERT INTO core.grn_line (tenant_id, id, goods_received_id, po_line_id, ingredient_id, batch_id, qty_milli, unit, unit_cost_minor, currency)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [l.grn_line_id, p.grn_id, l.po_line_id, l.ingredient_id, l.batch?.batch_id ?? null, l.qty_milli, l.unit, cost, l.currency]);
    }

    const audit: Array<{ entity: string; entityId: string; after: unknown }> = [
      { entity: "core.goods_received", entityId: p.grn_id, after: { lines: p.lines.length, po_id: p.po_id } },
    ];
    if (po && p.po_id) {
      const open = await first<{ n: string }>(c,
        `SELECT count(*) AS n FROM core.po_line pl
          WHERE pl.po_id = $1 AND pl.qty_milli > coalesce((SELECT sum(g.qty_milli) FROM core.grn_line g WHERE g.po_line_id = pl.id), 0)`, [p.po_id]);
      // A PO moves to received only when its own outlets are all inside the caller's scope (the guard's rule for a
      // pooled PO); otherwise a wider role marks it. Under-counting receipts hidden by outlet scope errs towards open.
      const scope = await setting(c, "app.outlet_ids");
      const inScope = scope === "{*}" || po.outlet_ids.every((o) => (scope ?? "").replace(/[{}]/g, "").split(",").includes(o));
      if (Number(open!.n) === 0 && inScope) {
        await c.query(`UPDATE core.purchase_order SET status = 'received' WHERE id = $1`, [p.po_id]);
        audit.push({ entity: "core.purchase_order", entityId: p.po_id, after: { status: "received" } });
      }
    }

    // Receipt movements (inventory.receive_grn), then the GRN posting (finance.post_grn) — one transaction.
    await seams.deriveGoodsReceipt(c, p.grn_id);
    await seams.postFor(c, "finance.post_grn", `core.goods_received:${p.grn_id}`);
    const moves = (await c.query<{ id: string; ingredient_id: string }>(
      `SELECT id, ingredient_id FROM core.stock_movement WHERE ref_type = 'core.goods_received' AND ref_id = $1 AND outlet_id = $2 ORDER BY id`, [p.grn_id, p.outlet_id])).rows;
    return {
      entityId: p.grn_id,
      audit,
      events: moves.length === 0 ? [] : [{ type: "munim.inventory.movement.recorded.v1", subject: p.grn_id, aggregateType: "stock_movement",
        data: { outlet_id: p.outlet_id, movement_ids: moves.map((m) => m.id), ingredient_ids: [...new Set(moves.map((m) => m.ingredient_id))],
          kind: "receipt", ref_type: "core.goods_received", ref_id: p.grn_id } }],
    };
  },
};

// ---- supplier invoices ----
export const invoiceRecord: CommandHandler = {
  type: "purchasing.invoice.record.v1",
  async run(c, command) {
    const p = PurchasingInvoiceRecordV1.parse(command.payload);
    if (!(await first(c, `SELECT 1 FROM core.supplier WHERE id = $1`, [p.supplier_id]))) throw bad();
    // A repeated supplier + number is refused (409); near-duplicates ("INV-1" / "INV1") are findings, not refusals.
    if (await first(c, `SELECT 1 FROM core.supplier_invoice WHERE supplier_id = $1 AND invoice_no = $2`, [p.supplier_id, p.invoice_no])) throw new ApiError("conflict", "duplicate_invoice");
    if (p.po_id) {
      const po = await first<{ supplier_id: string }>(c, `SELECT supplier_id FROM core.purchase_order WHERE id = $1`, [p.po_id]);
      if (!po || po.supplier_id !== p.supplier_id) throw bad();
    }
    let subtotal = 0;
    let tax = 0;
    const lines = p.lines.map((l, i) => {
      if (l.ingredient_id === null && l.description === null) throw bad();
      const sub = lineAmount(l.qty_milli, l.unit_price_minor);
      subtotal += sub;
      tax += l.tax_minor;
      return { ...l, line_no: i + 1, line_total_minor: sub + l.tax_minor };
    });
    await c.query(
      `INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, po_id, subtotal_minor, tax_minor, total_minor, currency, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, ${ME})`,
      [p.supplier_invoice_id, p.supplier_id, p.invoice_no, p.invoice_date, p.po_id, subtotal, tax, subtotal + tax, p.currency]);
    for (const l of lines) {
      if (l.po_line_id && !(await first(c, `SELECT 1 FROM core.po_line WHERE id = $1 AND po_id IS NOT DISTINCT FROM $2`, [l.po_line_id, p.po_id]))) throw bad();
      await c.query(
        `INSERT INTO core.supplier_invoice_line (tenant_id, id, supplier_invoice_id, line_no, po_line_id, ingredient_id, description, qty_milli, unit, unit_price_minor, tax_minor, line_total_minor)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [l.line_id, p.supplier_invoice_id, l.line_no, l.po_line_id, l.ingredient_id, l.description, l.qty_milli, l.unit, l.unit_price_minor, l.tax_minor, l.line_total_minor]);
    }
    return { entityId: p.supplier_invoice_id, audit: [{ entity: "core.supplier_invoice", entityId: p.supplier_invoice_id, after: { status: "recorded", lines: lines.length } }] };
  },
};

/** purchasing.payable_from_invoice: the payable of an APPROVED supplier invoice. Refuses any other status here;
 *  the guard enforces it independently (derivation_rule.source_state, MB001). */
export async function derivePayable(c: Queryable, invoiceId: string): Promise<{ payableId: string } | null> {
  const inv = await first<{ status: string; total_minor: string }>(c, `SELECT status, total_minor FROM core.supplier_invoice WHERE id = $1`, [invoiceId]);
  if (!inv) throw new ApiError("not_found");
  if (inv.status !== "approved") throw new ApiError("illegal_transition");
  if (Number(inv.total_minor) <= 0) return null;
  const payableId = uuidv7();
  await underRule(c, "purchasing.payable_from_invoice", `core.supplier_invoice:${invoiceId}`, () => c.query(
    `INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency, created_by)
     SELECT i.tenant_id, $2, i.supplier_id, 'core.supplier_invoice', i.id,
            i.invoice_date + coalesce((s.terms ->> 'payment_days')::int, 0), i.total_minor, i.currency, ${ME}
       FROM core.supplier_invoice i JOIN core.supplier s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
      WHERE i.id = $1`, [invoiceId, payableId]));
  return { payableId };
}

export const invoiceApprove: CommandHandler = {
  type: "purchasing.invoice.approve.v1",
  async run(c, command) {
    const p = PurchasingInvoiceApproveV1.parse(command.payload);
    const inv = await first<{ status: string }>(c, `SELECT status FROM core.supplier_invoice WHERE id = $1`, [p.supplier_invoice_id]);
    if (!inv) throw new ApiError("not_found");
    // recorded → approved (or disputed → approved) only; approving twice would raise a second payable.
    if (inv.status !== "recorded" && inv.status !== "disputed") throw new ApiError("conflict");
    await c.query(`UPDATE core.supplier_invoice SET status = 'approved' WHERE id = $1`, [p.supplier_invoice_id]);
    // A dispute resolved back to approved keeps the payable it already raised, which the dispute held (disputed → open,
    // D2; 0017 lets this command write core.payable); its entry, reversed by the dispute, is re-posted by finance as the
    // reversal of that reversal.
    const raised = await first(c, `SELECT 1 FROM core.payable WHERE source_type = 'core.supplier_invoice' AND source_id = $1`, [p.supplier_invoice_id]);
    const payable = raised ? null : await derivePayable(c, p.supplier_invoice_id);
    const released = inv.status === "disputed"
      ? (await c.query<{ id: string }>(
          `UPDATE core.payable SET status = 'open' WHERE source_type = 'core.supplier_invoice' AND source_id = $1 AND status = 'disputed' RETURNING id`,
          [p.supplier_invoice_id])).rows
      : [];
    await seams.postFor(c, "finance.post_supplier_invoice", `core.supplier_invoice:${p.supplier_invoice_id}`);
    return {
      entityId: p.supplier_invoice_id,
      audit: [
        { entity: "core.supplier_invoice", entityId: p.supplier_invoice_id, before: { status: inv.status }, after: { status: "approved" } },
        ...(payable ? [{ entity: "core.payable", entityId: payable.payableId, after: { status: "open", source: "core.supplier_invoice" } }] : []),
        ...released.map((r) => ({ entity: "core.payable", entityId: r.id, before: { status: "disputed" }, after: { status: "open" } })),
      ],
    };
  },
};

export const invoiceDispute: CommandHandler = {
  type: "purchasing.invoice.dispute.v1",
  async run(c, command) {
    const p = PurchasingInvoiceDisputeV1.parse(command.payload);
    const inv = await first<{ supplier_id: string; currency: string; status: string }>(c,
      `SELECT supplier_id, currency, status FROM core.supplier_invoice WHERE id = $1 FOR UPDATE`, [p.supplier_invoice_id]);
    if (!inv) throw bad();
    if (inv.status === "void") throw new ApiError("conflict");
    let total = 0;
    for (const l of p.lines) {
      const row = await first<{ line_total_minor: string }>(c, `SELECT line_total_minor FROM core.supplier_invoice_line WHERE id = $1 AND supplier_invoice_id = $2`, [l.invoice_line_id, p.supplier_invoice_id]);
      // A claim cannot exceed what the line billed.
      if (!row || l.claimed_minor > Number(row.line_total_minor)) throw new ApiError("invalid_payload");
      total += l.claimed_minor;
    }
    await c.query(
      `INSERT INTO core.dispute (tenant_id, id, counterparty, supplier_id, supplier_invoice_id, basis, total_claimed_minor, currency, created_by)
       VALUES (${T}, $1, 'supplier', $2, $3, $4, $5, $6, ${ME})`, [p.dispute_id, inv.supplier_id, p.supplier_invoice_id, p.basis, total, inv.currency]);
    for (const [i, l] of p.lines.entries()) {
      await c.query(`INSERT INTO core.dispute_line (tenant_id, id, dispute_id, line_no, supplier_invoice_line_id, claimed_minor, currency) VALUES (${T}, $1, $2, $3, $4, $5, $6)`,
        [uuidv7(), p.dispute_id, i + 1, l.invoice_line_id, l.claimed_minor, inv.currency]);
    }
    const audit: AuditEntry[] = [{ entity: "core.dispute", entityId: p.dispute_id, after: { basis: p.basis, status: "recorded" } }];
    // 0015 A8: the dispute moves the invoice to disputed; an approved invoice's entry is reversed under
    // finance.reverse_supplier_invoice (source state disputed) in this transaction, and its open payable moves to
    // disputed with it (D2, 0016: the dispute command may write core.payable).
    if (inv.status !== "disputed") {
      await c.query(`UPDATE core.supplier_invoice SET status = 'disputed' WHERE id = $1`, [p.supplier_invoice_id]);
      if (inv.status === "approved") await seams.reverseSource!(c, "finance.reverse_supplier_invoice", `core.supplier_invoice:${p.supplier_invoice_id}`);
      audit.push({ entity: "core.supplier_invoice", entityId: p.supplier_invoice_id, before: { status: inv.status }, after: { status: "disputed" } });
      const held = await c.query<{ id: string }>(
        `UPDATE core.payable SET status = 'disputed' WHERE source_type = 'core.supplier_invoice' AND source_id = $1 AND status = 'open' RETURNING id`, [p.supplier_invoice_id]);
      for (const r of held.rows) audit.push({ entity: "core.payable", entityId: r.id, before: { status: "open" }, after: { status: "disputed" } });
    }
    return { entityId: p.dispute_id, audit };
  },
};

// ---- supplier returns ----
// Stock lives in the ingredient's base unit. A return line in kg against a g ingredient is ×1000 (l → ml likewise);
// any other mismatch is refused, never guessed. Same table as inventory's toBaseFactor (not exported across modules).
const BASE_FACTORS: Record<string, Record<string, number>> = { kg: { g: 1000 }, l: { ml: 1000 } };
const factorToBase = (unit: string, base: string): number | null => (unit === base ? 1 : BASE_FACTORS[unit]?.[base] ?? null);

export const supplierReturnCreate: CommandHandler = {
  type: "purchasing.supplier_return.create.v1",
  async run(c, command) {
    const p = PurchasingSupplierReturnCreateV1.parse(command.payload);
    if (!(await first(c, `SELECT 1 FROM core.supplier WHERE id = $1`, [p.supplier_id]))) throw bad();
    if (p.goods_received_id && !(await first(c, `SELECT 1 FROM core.goods_received WHERE id = $1 AND outlet_id = $2 AND supplier_id = $3`, [p.goods_received_id, p.outlet_id, p.supplier_id]))) throw bad();

    // The unit cost is what was paid on the receipt, never the payload: the batch's own receipt line, else the
    // named receipt, else the supplier's latest receipt of the ingredient. None → cannot verify.
    // Lines are stored and moved in the ingredient's base unit, at the cost of 1000 base units (R2-S2-8, 0016: exact for
    // a per-kg / per-l price; the database fills the rounded per-unit column).
    const costed: Array<(typeof p.lines)[number] & { unit_cost_per_1000_minor: number; currency: string }> = [];
    for (const l of p.lines) {
      if (l.batch_id && !(await first(c, `SELECT 1 FROM core.batch WHERE id = $1 AND outlet_id = $2 AND ingredient_id = $3`, [l.batch_id, p.outlet_id, l.ingredient_id]))) throw bad();
      const ing = await first<{ base_unit: string }>(c, `SELECT base_unit FROM core.ingredient WHERE id = $1`, [l.ingredient_id]);
      if (!ing) throw bad();
      const cost = await first<{ unit_cost_minor: string; currency: string; unit: string }>(c,
        `SELECT g.unit_cost_minor, g.currency, g.unit FROM core.grn_line g JOIN core.goods_received r ON r.tenant_id = g.tenant_id AND r.id = g.goods_received_id
          WHERE g.ingredient_id = $1 AND r.supplier_id = $2
            AND ($3::uuid IS NULL OR g.batch_id = $3) AND ($4::uuid IS NULL OR g.goods_received_id = $4)
          ORDER BY r.received_at DESC LIMIT 1`, [l.ingredient_id, p.supplier_id, l.batch_id, p.goods_received_id]);
      if (!cost) throw new ApiError("cannot_verify", "cost_price_missing");
      const qf = factorToBase(l.unit, ing.base_unit);
      const cf = factorToBase(cost.unit, ing.base_unit);
      if (qf === null || cf === null) throw new ApiError("bad_request", "unit_mismatch");
      costed.push({ ...l, qty_milli: l.qty_milli * qf, unit: ing.base_unit, unit_cost_per_1000_minor: mulDiv(Number(cost.unit_cost_minor), 1000, cf), currency: cost.currency });
    }
    await c.query(
      `INSERT INTO core.supplier_return (tenant_id, id, outlet_id, supplier_id, goods_received_id, reason_code, note, returned_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, ${ME})`, [p.supplier_return_id, p.outlet_id, p.supplier_id, p.goods_received_id, p.reason_code, p.note]);
    for (const l of costed) {
      await c.query(
        `INSERT INTO core.supplier_return_line (tenant_id, id, supplier_return_id, ingredient_id, batch_id, qty_milli, unit, unit_cost_per_1000_minor, currency)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8)`, [uuidv7(), p.supplier_return_id, l.ingredient_id, l.batch_id, l.qty_milli, l.unit, l.unit_cost_per_1000_minor, l.currency]);
    }
    // inventory.supplier_return: the outgoing movements, derived from the return row just written.
    const movementIds: string[] = [];
    await underRule(c, "inventory.supplier_return", `core.supplier_return:${p.supplier_return_id}`, async () => {
      for (const l of costed) {
        const id = uuidv7();
        movementIds.push(id);
        await c.query(
          `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id, unit_cost_per_1000_minor, currency)
           VALUES (${T}, $1, $2, $3, $4, $5, $6, 'supplier_return', 'core.supplier_return', $7, $8, $9)`,
          [id, p.outlet_id, l.ingredient_id, l.batch_id, -l.qty_milli, l.unit, p.supplier_return_id, l.unit_cost_per_1000_minor, l.currency]);
      }
    });
    return {
      entityId: p.supplier_return_id,
      audit: [{ entity: "core.supplier_return", entityId: p.supplier_return_id, after: { lines: costed.length, reason_code: p.reason_code } }],
      events: [{ type: "munim.inventory.movement.recorded.v1", subject: p.supplier_return_id, aggregateType: "stock_movement",
        data: { outlet_id: p.outlet_id, movement_ids: movementIds, ingredient_ids: [...new Set(costed.map((l) => l.ingredient_id))],
          kind: "supplier_return", ref_type: "core.supplier_return", ref_id: p.supplier_return_id } }],
    };
  },
};
