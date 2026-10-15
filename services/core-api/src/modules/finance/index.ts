// Finance module (T-026). Mounted by modules/index.ts.
//   POST /v1/finance/channel-terms     finance.channel_terms.set.v1 (own command)
//   POST /v1/finance/expenses          finance.expense.record.v1 (own command; posts finance.post_expense)
//   POST /v1/finance/budgets           finance.budget.set.v1 (own command, owner/judge; one per outlet or business, category, month)
//   POST /v1/finance/disputes          finance.dispute.draft.v1 (own command; also draftable)
//   POST /v1/finance/period-closes     finance.period.close.v1 (own command; also draftable)
//   GET  /v1/finance/exports/tally     journal vouchers as CSV (owner, advisor, judge)
//   GET  /v1/finance/channel-terms     recorded channel terms (owner, advisor, judge)
//   GET  /v1/finance/settlements · settlement-lines · bank-lines · disputes (+ /{id}) · period-closes   row lists (T-092a, routes.ts)
// finance.journal.adjust.v1 has NO route: it executes only through an approved draft.
// Seams for other modules (W2 brief), each inside the caller's transaction: postFor / reverseFor (every seeded
// finance.post_* rule), seedChart (T-020), recordSettlement / recordBankLines (T-030's approved import commit),
// reconcileSettlement. Supplier agents and payments are simulated / recorded only (project rule 5).
import { commandEnvelopeOf } from "@munim/contracts";
import { FinanceBudgetSetV1, FinanceChannelTermsSetV1, FinanceDisputeDraftV1, FinanceExpenseRecordV1, FinancePeriodCloseV1 } from "@munim/contracts/finance";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import { budgetSet, channelTermsSet, disputeDraft, expenseRecord, journalAdjust, periodClose } from "./commands.ts";
import { listChannelTerms, tallyExport } from "./read.ts";
import { readRoutes } from "./routes.ts";

export { seedChart } from "./chart.ts";
export { postFor, reverseFor, reverseSource, type PostResult, type ReversalRuleId } from "./post.ts";
export { recordBankLines, recordSettlement, reconcileSettlement, type BankLineInput, type SettlementInput } from "./settle.ts";
export { FINANCE_TEMPLATES } from "./read.ts";
export { budgetSet, channelTermsSet, disputeDraft, expenseRecord, journalAdjust, periodClose } from "./commands.ts";

// Draftable handlers register once per process even if this file is loaded twice (loadRouters imports by
// file URL; tests may import by path).
const REGISTERED = Symbol.for("munim.finance.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[REGISTERED]) {
  g[REGISTERED] = true;
  for (const h of [disputeDraft, journalAdjust, periodClose]) registerDraftHandler(h);
}

/** A table rule the payload broke (not a guard verdict) as an API refusal; anything else is rethrown for the
 *  app's error mapper (MB SQLSTATEs → their codes; the rest → internal, never raw text). */
function tableRefusal(e: unknown): never {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "23P01" || code === "23505") throw new ApiError("conflict");
  if (code === "23514" || code === "23503") throw new ApiError("invalid_payload");
  throw e;
}

function ownCommand(type: string, schema: Parameters<typeof commandEnvelopeOf>[1], handler: CommandHandler) {
  const Envelope = commandEnvelopeOf(type, schema);
  return async (c: Context<AppEnv>) => {
    const p = c.var.principal;
    if (p.kind !== "member") throw new ApiError("forbidden");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("bad_request");
    }
    const env = Envelope.safeParse(body);
    if (!env.success) throw new ApiError("invalid_payload");
    const { pools, publish } = c.var.deps;
    const out = await executeCommand({
      tx: <T>(fn: (q: Queryable) => Promise<T>) => withContext(pools.core, contextOf(p), fn),
      tenantId: p.tenant_id,
      actor: { kind: "member", id: p.member_id, role: p.role },
      ...(publish ? { publish } : {}),
    }, env.data as Parameters<typeof executeCommand>[1], handler).catch(tableRefusal);
    return c.body(out.body, 201, { "Content-Type": "application/json", ...replayHeaders(out) });
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXPORT_ROLES = new Set(["owner", "advisor", "judge"]);

/** The books of the whole business: tenant-wide finance roles only (a manager's outlet scope cannot be applied to
 *  tenant-level rows). */
function financeReader(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member" || !EXPORT_ROLES.has(p.role) || p.outlet_ids !== "*") throw new ApiError("forbidden", "authority_denied");
  return p;
}

export const router = new Hono<AppEnv>()
  .post("/v1/finance/channel-terms", requireMember, ownCommand("finance.channel_terms.set.v1", FinanceChannelTermsSetV1, channelTermsSet))
  .post("/v1/finance/expenses", requireMember, ownCommand("finance.expense.record.v1", FinanceExpenseRecordV1, expenseRecord))
  .post("/v1/finance/budgets", requireMember, ownCommand("finance.budget.set.v1", FinanceBudgetSetV1, budgetSet))
  .post("/v1/finance/disputes", requireMember, ownCommand("finance.dispute.draft.v1", FinanceDisputeDraftV1, disputeDraft))
  .post("/v1/finance/period-closes", requireMember, ownCommand("finance.period.close.v1", FinancePeriodCloseV1, periodClose))
  .get("/v1/finance/channel-terms", requireMember, async (c) => {
    const p = financeReader(c);
    const channel = c.req.query("channel_id") ?? null;
    if (channel !== null && !UUID.test(channel)) throw new ApiError("bad_request");
    return c.json(await withContext(c.var.deps.pools.core, contextOf(p), (q) => listChannelTerms(q, channel)), 200);
  })
  .get("/v1/finance/exports/tally", requireMember, async (c) => {
    const p = financeReader(c);
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || to < from) throw new ApiError("bad_request");
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new ApiError("bad_request");
    return c.json(await withContext(c.var.deps.pools.core, contextOf(p), (q) => tallyExport(q, from, to)), 200);
  })
  .route("/", readRoutes);
