// Draft execution handlers (approvals runs them inside the approving transaction, under the approver's
// identity with app.decision_id set — R15, R28).
//   imports.run.commit.v1      staged rows → book rows as the approver; the run → committed under the decision.
//   imports.format.approve.v1  a tenant's mapping (renames + units only) → core.import_format.
// Settlements and bank lines go through finance's seams (recordSettlement posts and reconciles); imported
// expenses are posted with finance's postFor, exactly as finance.expense.record.v1 posts its own.
import type { ImportKind } from "@munim/contracts/imports";
import type { CommandHandler } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { type BankLineInput, postFor, recordBankLines, recordSettlement, type SettlementInput } from "../finance/index.ts";
import { builtInBySignature, checkMapping, headerSignature, type MappingEntry } from "./formats.ts";

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

export const runCommitHandler: CommandHandler = {
  type: "imports.run.commit.v1",
  async run(c, cmd) {
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
    if (run.kind === "pos_export") {
      // Imported bills become orders + tenders, which imports.run.commit.v1 is not bound to yet (migrator request
      // in the T-030 report). Refused before any write; the draft stays proposed.
      throw new ApiError("command_table_mismatch", "authority_denied");
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
  },
};

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
