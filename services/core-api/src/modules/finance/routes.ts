// Finance read routes (T-092a; hand list rows 3-6). The books of the whole business: tenant-wide finance roles only
// (owner, advisor, judge; a manager's outlet scope cannot be applied to channel-level rows), as the Tally export.
// Every amount is the row's own field (R26: no aggregate here).
//   GET /v1/finance/settlements?channel=&from=&to=&limit=&cursor=
//   GET /v1/finance/settlement-lines?channel=&from=&to=&limit=&cursor=     (from / to overlap the settlement's period)
//   GET /v1/finance/bank-lines?from=&to=&limit=&cursor=                    (value date)
//   GET /v1/finance/disputes?status=&counterparty=&limit=&cursor= · GET /v1/finance/disputes/{id}
//   GET /v1/finance/period-closes?from=&to=&limit=&cursor=                 (period month)
import { Hono, type Context } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, ID, int, iso, limitOf, methodGuard, optDate, optEnum, optUuid, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

const ROLES = new Set(["owner", "advisor", "judge"]);

function financeReader(c: Context<AppEnv>): void {
  const p = c.var.principal;
  if (p.kind !== "member" || !ROLES.has(p.role) || p.outlet_ids !== "*") throw new ApiError("forbidden", "authority_denied");
}

function range(c: Context<AppEnv>): { from: string | null; to: string | null } {
  const from = optDate(c, "from");
  const to = optDate(c, "to");
  if (from && to && to < from) throw new ApiError("bad_request");
  return { from, to };
}

const DISPUTE = `SELECT d.id, d.counterparty, d.channel_id, d.supplier_id, d.supplier_invoice_id, d.basis, d.total_claimed_minor, d.currency, d.status,
                        d.resolved_minor, d.created_at FROM core.dispute d`;
const disputeView = (d: Record<string, any>) => ({
  dispute_id: d.id, counterparty: d.counterparty, channel_id: d.channel_id, supplier_id: d.supplier_id, supplier_invoice_id: d.supplier_invoice_id,
  basis: d.basis, total_claimed_minor: Number(d.total_claimed_minor), currency: d.currency, status: d.status,
  resolved_minor: int(d.resolved_minor), created_at: d.created_at.toISOString(),
});

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/finance/settlements", requireMember, async (c) => {
      financeReader(c);
      const channel = optUuid(c, "channel");
      const { from, to } = range(c);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, channel_id, outlet_id, period_from::text AS period_from, period_to::text AS period_to, paid_on::text AS paid_on, external_ref,
                net_minor, currency, created_at
           FROM core.settlement
          WHERE ($1::uuid IS NULL OR channel_id = $1) AND ($2::date IS NULL OR period_to >= $2) AND ($3::date IS NULL OR period_from <= $3)
            AND ($4::uuid IS NULL OR id < $4)
          ORDER BY id DESC LIMIT $5`, [channel, from, to, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (s) => ({
        settlement_id: s.id, channel_id: s.channel_id, outlet_id: s.outlet_id, period_from: s.period_from, period_to: s.period_to, paid_on: s.paid_on,
        external_ref: s.external_ref, net_minor: Number(s.net_minor), currency: s.currency, created_at: s.created_at.toISOString(),
      })), 200);
    })
    .get("/v1/finance/settlement-lines", requireMember, async (c) => {
      financeReader(c);
      const channel = optUuid(c, "channel");
      const { from, to } = range(c);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT l.id, l.settlement_id, s.channel_id, l.line_no, l.line_kind, l.external_order_ref, l.matched_order_id, l.gross_minor, l.commission_minor,
                l.ad_fee_minor, l.promo_share_minor, l.tax_withheld_minor, l.net_minor, l.currency
           FROM core.settlement_line l JOIN core.settlement s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id
          WHERE ($1::uuid IS NULL OR s.channel_id = $1) AND ($2::date IS NULL OR s.period_to >= $2) AND ($3::date IS NULL OR s.period_from <= $3)
            AND ($4::uuid IS NULL OR l.id < $4)
          ORDER BY l.id DESC LIMIT $5`, [channel, from, to, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (l) => ({
        settlement_line_id: l.id, settlement_id: l.settlement_id, channel_id: l.channel_id, line_no: l.line_no, line_kind: l.line_kind,
        // An aggregator's own order reference: untrusted text, returned as text.
        external_order_ref: l.external_order_ref, matched_order_id: l.matched_order_id,
        gross_minor: Number(l.gross_minor), commission_minor: Number(l.commission_minor), ad_fee_minor: Number(l.ad_fee_minor),
        promo_share_minor: Number(l.promo_share_minor), tax_withheld_minor: Number(l.tax_withheld_minor), net_minor: Number(l.net_minor), currency: l.currency,
      })), 200);
    })
    .get("/v1/finance/bank-lines", requireMember, async (c) => {
      financeReader(c);
      const { from, to } = range(c);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, outlet_id, account_ref, value_date::text AS value_date, amount_minor, currency, method, payee_vpa, narration, external_ref, created_at
           FROM core.bank_line
          WHERE ($1::date IS NULL OR value_date >= $1) AND ($2::date IS NULL OR value_date <= $2) AND ($3::uuid IS NULL OR id < $3)
          ORDER BY id DESC LIMIT $4`, [from, to, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (b) => ({
        bank_line_id: b.id, outlet_id: b.outlet_id, account_ref: b.account_ref, value_date: b.value_date, amount_minor: Number(b.amount_minor),
        currency: b.currency, method: b.method, payee_vpa: b.payee_vpa,
        // Bank narration is imported text: untrusted, returned as text.
        narration: b.narration, external_ref: b.external_ref, created_at: b.created_at.toISOString(),
      })), 200);
    })
    .get("/v1/finance/disputes", requireMember, async (c) => {
      financeReader(c);
      const status = optEnum(c, "status", ["recorded", "sent", "resolved", "rejected", "withdrawn"] as const);
      const counterparty = optEnum(c, "counterparty", ["channel", "supplier"] as const);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `${DISPUTE} WHERE ($1::text IS NULL OR d.status = $1) AND ($2::text IS NULL OR d.counterparty = $2) AND ($3::uuid IS NULL OR d.id < $3)
          ORDER BY d.id DESC LIMIT $4`, [status, counterparty, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, disputeView), 200);
    })
    .get(`/v1/finance/disputes/:id{${ID}}`, requireMember, async (c) => {
      financeReader(c);
      const out = await readAs(c, async (db) => {
        const d = (await db.query<Record<string, any>>(`${DISPUTE} WHERE d.id = $1`, [c.req.param("id")])).rows[0];
        if (!d) throw new ApiError("not_found");
        const lines = (await db.query<Record<string, any>>(
          `SELECT id, line_no, settlement_line_id, order_id, supplier_invoice_line_id, claimed_minor, currency
             FROM core.dispute_line WHERE dispute_id = $1 ORDER BY line_no`, [d.id])).rows;
        return {
          ...disputeView(d),
          lines: lines.map((l) => ({
            dispute_line_id: l.id, line_no: l.line_no, settlement_line_id: l.settlement_line_id, order_id: l.order_id,
            supplier_invoice_line_id: l.supplier_invoice_line_id, claimed_minor: Number(l.claimed_minor), currency: l.currency,
          })),
        };
      });
      return c.json(out, 200);
    })
    .get("/v1/finance/period-closes", requireMember, async (c) => {
      financeReader(c);
      const { from, to } = range(c);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, outlet_id, period_month::text AS period_month, checklist, net_minor, currency, closed_by, closed_at
           FROM core.period_close
          WHERE ($1::date IS NULL OR period_month >= $1) AND ($2::date IS NULL OR period_month <= $2) AND ($3::uuid IS NULL OR id < $3)
          ORDER BY id DESC LIMIT $4`, [from, to, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (p) => ({
        period_close_id: p.id, outlet_id: p.outlet_id, period_month: p.period_month, checklist: p.checklist,
        net_minor: Number(p.net_minor), currency: p.currency, closed_by: p.closed_by, closed_at: iso(p.closed_at),
      })), 200);
    }),
  [
    ["/v1/finance/settlements", "GET"], ["/v1/finance/settlement-lines", "GET"], ["/v1/finance/bank-lines", "GET"],
    ["/v1/finance/disputes", "GET, POST"], [`/v1/finance/disputes/:id{${ID}}`, "GET"], ["/v1/finance/period-closes", "GET, POST"],
  ],
);
