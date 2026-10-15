// Purchasing module (T-025): suppliers (real | simulated), price observations, purchase orders (single and
// pooled), goods received, supplier invoices (duplicate refused, then approved per authority), disputes and
// supplier returns. Mounted by modules/index.ts. Full paths:
//   GET/POST /v1/suppliers · GET /v1/suppliers/{id}
//   GET/POST /v1/purchase-orders · GET /v1/purchase-orders/{id}
//   GET/POST /v1/goods-received · GET /v1/goods-received/{id}
//   GET/POST /v1/supplier-invoices · GET /v1/supplier-invoices/{id} · POST …/{id}:approve · POST …/{id}:dispute
//   GET/POST /v1/supplier-returns
//   POST /v1/rfq-requests (T-114: a person asks the simulated suppliers for quotes — rfq.ts)
import { commandEnvelopeOf, draftable } from "@munim/contracts";
import {
  PurchasingGrnReceiveV1, PurchasingInvoiceApproveV1, PurchasingInvoiceDisputeV1, PurchasingInvoiceRecordV1, PurchasingPoCreateV1,
  PurchasingRfqRequestV1, PurchasingSupplierReturnCreateV1, PurchasingSupplierUpsertV1,
} from "@munim/contracts/purchasing";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import {
  grnReceive, invoiceApprove, invoiceDispute, invoiceRecord, poCreate, supplierReturnCreate, supplierUpsert,
} from "./handlers.ts";
import { getView, listView, type ViewName } from "./read.ts";
import { rfqConfig, rfqRequest, startNegotiation } from "./rfq.ts";

export { derivePayable } from "./handlers.ts";
export { configureRfq, createHttpNegotiatePort, DRAFT_ID_HEADER, NEGOTIATION_HEADER, type NegotiateBody, type NegotiatePort, type RfqConfig } from "./rfq.ts";
export { setSeams } from "./seams.ts";
export type { Seams } from "./seams.ts";

// Draftable commands (R16): the AI proposes, approvals executes through the same handler a person's own command
// uses. A second registration is ignored: the module can be evaluated twice in one process (by path and by URL).
// invoiceRecord: invoice vision's draft (T-056) — its numbers are document spans, so it executes only once the approver
// has typed each one (approvals refuses an unresolved ref).
for (const h of [poCreate, invoiceDispute, invoiceRecord, supplierReturnCreate]) {
  if (!draftable(h.type)) throw new Error(`purchasing: '${h.type}' is not a registered draftable (contracts)`);
  try {
    registerDraftHandler(h);
  } catch (e) {
    if (!/already has a handler/.test((e as Error).message)) throw e;
  }
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

/** Constraint/data failures from the database are the caller's problem, not a 500 (no driver text escapes). */
function mapDb(e: unknown): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "23505") return new ApiError("conflict");
  if (typeof code === "string" && /^(22|23)/.test(code)) return new ApiError("bad_request");
  return e;
}

/** `after`: work that runs only once the command has committed for the first time (never on a replay); it returns extra
 *  response headers. */
async function command(
  c: Context<AppEnv>, handler: CommandHandler, schema: Parameters<typeof commandEnvelopeOf>[1], status: 200 | 201, body: unknown,
  after?: (payload: unknown) => Promise<Record<string, string>>,
) {
  const m = member(c);
  const env = commandEnvelopeOf(handler.type, schema).safeParse(body);
  if (!env.success) throw new ApiError("invalid_payload");
  const deps = c.var.deps;
  try {
    const out = await executeCommand(
      {
        tx: (fn) => withContext(deps.pools.core, contextOf(m), fn),
        tenantId: m.tenant_id,
        actor: { kind: "member", id: m.member_id, role: m.role },
        ...(deps.publish ? { publish: deps.publish } : {}),
        onPublishDeferred: (ids) => deps.log(`purchasing: ${ids.length} event(s) left for the sweeper`),
      },
      { command_id: env.data.command_id, idempotency_key: env.data.idempotency_key, type: handler.type, payload: (env.data as { payload: Record<string, unknown> }).payload },
      handler,
    );
    const extra = after && !out.replayed ? await after(env.data.payload) : {};
    // The stored text, so a replay is byte-identical; replay is signalled by header only.
    return c.body(out.body, status, { "Content-Type": "application/json", ...replayHeaders(out), ...extra });
  } catch (e) {
    throw mapDb(e);
  }
}

const list = (name: ViewName) => async (c: Context<AppEnv>) => c.json((await listView(c.var.deps.pools, member(c), name)) as never, 200);
const one = (name: ViewName) => async (c: Context<AppEnv>) => c.json((await getView(c.var.deps.pools, member(c), name, c.req.param("id")!)) as never, 200);
const actionId = (c: Context<AppEnv>, suffix: string) => c.req.param("action")!.slice(0, -suffix.length);
/** The path id and the payload's invoice id must agree. */
const sameInvoice = (c: Context<AppEnv>, body: unknown, suffix: string) => {
  if ((body as { payload?: { supplier_invoice_id?: unknown } } | null)?.payload?.supplier_invoice_id !== actionId(c, suffix)) throw new ApiError("bad_request");
};

export const router = new Hono<AppEnv>()
  .get("/v1/suppliers", requireMember, list("supplier"))
  .get(`/v1/suppliers/:id{${ID}}`, requireMember, one("supplier"))
  .post("/v1/suppliers", requireMember, async (c) => command(c, supplierUpsert, PurchasingSupplierUpsertV1, 201, await json(c)))
  .get("/v1/purchase-orders", requireMember, list("po"))
  .get(`/v1/purchase-orders/:id{${ID}}`, requireMember, one("po"))
  .post("/v1/purchase-orders", requireMember, async (c) => command(c, poCreate, PurchasingPoCreateV1, 201, await json(c)))
  .get("/v1/goods-received", requireMember, list("grn"))
  .get(`/v1/goods-received/:id{${ID}}`, requireMember, one("grn"))
  .post("/v1/goods-received", requireMember, async (c) => command(c, grnReceive, PurchasingGrnReceiveV1, 201, await json(c)))
  .get("/v1/supplier-invoices", requireMember, list("invoice"))
  .get(`/v1/supplier-invoices/:id{${ID}}`, requireMember, one("invoice"))
  .post("/v1/supplier-invoices", requireMember, async (c) => command(c, invoiceRecord, PurchasingInvoiceRecordV1, 201, await json(c)))
  .post(`/v1/supplier-invoices/:action{${ID}:approve}`, requireMember, async (c) => {
    const body = await json(c);
    sameInvoice(c, body, ":approve");
    return command(c, invoiceApprove, PurchasingInvoiceApproveV1, 200, body);
  })
  .post(`/v1/supplier-invoices/:action{${ID}:dispute}`, requireMember, async (c) => {
    const body = await json(c);
    sameInvoice(c, body, ":dispute");
    return command(c, invoiceDispute, PurchasingInvoiceDisputeV1, 201, body);
  })
  .get("/v1/supplier-returns", requireMember, list("ret"))
  .post("/v1/supplier-returns", requireMember, async (c) => command(c, supplierReturnCreate, PurchasingSupplierReturnCreateV1, 201, await json(c)))
  .post("/v1/rfq-requests", requireMember, async (c) => {
    // No negotiation port wired → refuse before anything is written.
    const cfg = rfqConfig(c.var.deps);
    if (!cfg) throw new ApiError("unavailable");
    const body = await json(c);
    return command(c, rfqRequest, PurchasingRfqRequestV1, 201, body, (payload) => startNegotiation(c.var.deps, cfg, member(c), payload));
  });
