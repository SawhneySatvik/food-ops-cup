// Purchasing read models: row fields only (One Guarantee clause 2). Every view that names a supplier uses the
// one SUPPLIER fragment below, so a simulated supplier is always labelled (project rule 12).
import { SIMULATED_SUPPLIER_LABEL } from "@munim/contracts/purchasing";
import type { Principal } from "../../auth/resolve.ts";
import { contextOf } from "../../auth/resolve.ts";
import { type Pools, withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";

type Member = Extract<Principal, { kind: "member" }>;

/** The supplier object of every view. `s` is the joined core.supplier row. */
const LABEL = `CASE WHEN s.kind = 'simulated' THEN '${SIMULATED_SUPPLIER_LABEL}' END`;
const SUPPLIER = `json_build_object('supplier_id', s.id, 'name', s.name, 'kind', s.kind, 'label', ${LABEL})`;

/** null = every outlet; otherwise the caller's outlets (possibly none). */
const scopeOf = (m: Member): string[] | null => (m.outlet_ids === "*" ? null : m.outlet_ids);

const PRICE_COLS = `json_build_object('price_id', sp.id, 'ingredient_id', sp.ingredient_id, 'unit', sp.unit, 'unit_price_minor', sp.unit_price_minor,
  'currency', sp.currency, 'observed_at', sp.observed_at, 'source_ref', sp.source_ref)`;

// Tenant-level views take [id]; outlet-reaching views take [outlet scope, id].
const VIEWS = {
  supplier: {
    sql: (m: Member) => `SELECT json_build_object('supplier_id', s.id, 'name', s.name, 'kind', s.kind, 'label', ${LABEL},
        'a2a_card_url', s.a2a_card_url, 'payment_days', (s.terms ->> 'payment_days')::int, 'notes', s.terms ->> 'notes', 'active', s.active,
        'prices', ${m.role === "staff" ? "'[]'::json" : `coalesce((SELECT json_agg(${PRICE_COLS} ORDER BY sp.observed_at, sp.id) FROM core.supplier_price sp WHERE sp.supplier_id = s.id), '[]')`}) AS v
      FROM core.supplier s WHERE ($1::uuid IS NULL OR s.id = $1) ORDER BY s.name, s.id LIMIT 200`,
    args: (_m: Member, id?: string) => [id ?? null],
  },
  po: {
    sql: () => `SELECT json_build_object('po_id', po.id, 'supplier', ${SUPPLIER}, 'outlet_ids', po.outlet_ids, 'status', po.status, 'currency', po.currency,
        'total_minor', po.total_minor, 'expected_on', po.expected_on, 'negotiation_run_id', po.negotiation_run_id, 'created_at', po.created_at,
        'lines', coalesce((SELECT json_agg(json_build_object('po_line_id', l.id, 'line_no', l.line_no, 'ingredient_id', l.ingredient_id, 'qty_milli', l.qty_milli,
          'unit', l.unit, 'unit_price_minor', l.unit_price_minor) ORDER BY l.line_no) FROM core.po_line l WHERE l.po_id = po.id), '[]')) AS v
      FROM core.purchase_order po JOIN core.supplier s ON s.tenant_id = po.tenant_id AND s.id = po.supplier_id
      WHERE ($1::uuid[] IS NULL OR po.outlet_ids && $1::uuid[]) AND ($2::uuid IS NULL OR po.id = $2)
      ORDER BY po.created_at DESC, po.id LIMIT 200`,
    args: (m: Member, id?: string) => [scopeOf(m), id ?? null],
  },
  grn: {
    sql: () => `SELECT json_build_object('grn_id', r.id, 'outlet_id', r.outlet_id, 'supplier', ${SUPPLIER}, 'po_id', r.po_id, 'received_at', r.received_at,
        'received_by', r.received_by, 'note', r.note,
        'lines', coalesce((SELECT json_agg(json_build_object('grn_line_id', g.id, 'po_line_id', g.po_line_id, 'ingredient_id', g.ingredient_id, 'batch_id', g.batch_id,
          'qty_milli', g.qty_milli, 'unit', g.unit, 'unit_cost_minor', g.unit_cost_minor, 'currency', g.currency) ORDER BY g.id) FROM core.grn_line g WHERE g.goods_received_id = r.id), '[]')) AS v
      FROM core.goods_received r JOIN core.supplier s ON s.tenant_id = r.tenant_id AND s.id = r.supplier_id
      WHERE ($1::uuid[] IS NULL OR r.outlet_id = ANY ($1::uuid[])) AND ($2::uuid IS NULL OR r.id = $2)
      ORDER BY r.received_at DESC, r.id LIMIT 200`,
    args: (m: Member, id?: string) => [scopeOf(m), id ?? null],
  },
  invoice: {
    sql: () => `SELECT json_build_object('supplier_invoice_id', i.id, 'supplier', ${SUPPLIER}, 'invoice_no', i.invoice_no, 'invoice_date', i.invoice_date, 'po_id', i.po_id,
        'subtotal_minor', i.subtotal_minor, 'tax_minor', i.tax_minor, 'total_minor', i.total_minor, 'currency', i.currency, 'status', i.status, 'created_at', i.created_at,
        'lines', coalesce((SELECT json_agg(json_build_object('line_id', l.id, 'line_no', l.line_no, 'po_line_id', l.po_line_id, 'ingredient_id', l.ingredient_id,
          'description', l.description, 'qty_milli', l.qty_milli, 'unit', l.unit, 'unit_price_minor', l.unit_price_minor, 'tax_minor', l.tax_minor,
          'line_total_minor', l.line_total_minor) ORDER BY l.line_no) FROM core.supplier_invoice_line l WHERE l.supplier_invoice_id = i.id), '[]'),
        'payable', (SELECT json_build_object('payable_id', p.id, 'due_on', p.due_on, 'amount_minor', p.amount_minor, 'status', p.status)
                      FROM core.payable p WHERE p.source_type = 'core.supplier_invoice' AND p.source_id = i.id ORDER BY p.created_at LIMIT 1)) AS v
      FROM core.supplier_invoice i JOIN core.supplier s ON s.tenant_id = i.tenant_id AND s.id = i.supplier_id
      WHERE ($1::uuid IS NULL OR i.id = $1) ORDER BY i.created_at DESC, i.id LIMIT 200`,
    args: (_m: Member, id?: string) => [id ?? null],
  },
  ret: {
    sql: () => `SELECT json_build_object('supplier_return_id', r.id, 'outlet_id', r.outlet_id, 'supplier', ${SUPPLIER}, 'goods_received_id', r.goods_received_id,
        'reason_code', r.reason_code, 'note', r.note, 'returned_by', r.returned_by, 'returned_at', r.returned_at,
        'lines', coalesce((SELECT json_agg(json_build_object('ingredient_id', l.ingredient_id, 'batch_id', l.batch_id, 'qty_milli', l.qty_milli, 'unit', l.unit,
          'unit_cost_minor', l.unit_cost_minor, 'unit_cost_per_1000_minor', l.unit_cost_per_1000_minor, 'currency', l.currency) ORDER BY l.id) FROM core.supplier_return_line l WHERE l.supplier_return_id = r.id), '[]')) AS v
      FROM core.supplier_return r JOIN core.supplier s ON s.tenant_id = r.tenant_id AND s.id = r.supplier_id
      WHERE ($1::uuid[] IS NULL OR r.outlet_id = ANY ($1::uuid[])) AND ($2::uuid IS NULL OR r.id = $2)
      ORDER BY r.returned_at DESC, r.id LIMIT 200`,
    args: (m: Member, id?: string) => [scopeOf(m), id ?? null],
  },
} as const;
export type ViewName = keyof typeof VIEWS;

async function rows(pools: Pools, m: Member, name: ViewName, id?: string): Promise<unknown[]> {
  // Supplier invoices carry costs and payables: not for staff.
  if (name === "invoice" && m.role === "staff") throw new ApiError("forbidden");
  const v = VIEWS[name];
  return withContext(pools.core, contextOf(m), async (c) => (await c.query<{ v: unknown }>(v.sql(m), v.args(m, id) as unknown[])).rows.map((r) => r.v));
}

export const listView = async (pools: Pools, m: Member, name: ViewName) => ({ items: await rows(pools, m, name) });

/** One row, or not_found — also for a row outside the caller's outlets (never a 403: gotcha 16). */
export async function getView(pools: Pools, m: Member, name: ViewName, id: string): Promise<unknown> {
  const hit = (await rows(pools, m, name, id))[0];
  if (!hit) throw new ApiError("not_found");
  return hit;
}
