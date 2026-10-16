// Customers & growth module, member side (T-028; packs/customers-growth.md). Mounted by modules/index.ts.
//   GET  /v1/customers?q=&limit=&cursor=         search merchant-side customer records
//   POST /v1/customers:upsert                    customers.customer.upsert.v1 (consent can only be withdrawn)
//   GET  /v1/customers/{id}/loyalty              balance (latest balance_after) + ledger entries
//   GET  /v1/customers/{id}/coupon-uses          coupon use history
//   POST /v1/loyalty:adjust                      customers.loyalty.adjust.v1
//   GET  /v1/campaigns · POST /v1/campaigns:cancel · POST /v1/campaigns:record-sent (R67, demo businesses only)
//   GET/POST reservations, reviews, bulk-orders
// There is NO route that creates or sends a campaign. A campaign exists only once an approved draft of
// customers.campaign.create.v1 executes (registered below), is stored `queued`, and nothing in Munim sends it
// until the founder picks a channel (R15, R16, R40 C6). On a demo business the owner may record it as sent, simulated
// (campaign-sent.ts): a record, not a send. Customer self-service (own profile, consent grant, own
// loyalty) is accounts (T-035); `readLoyalty` is exported for it. Seams for orders: loyalty.ts.
import { commandEnvelopeOf } from "@munim/contracts";
import {
  CustomersBulkOrderUpsertV1, CustomersCampaignCancelV1, CustomersCampaignRecordSentV1, CustomersCustomerUpsertV1, CustomersLoyaltyAdjustV1,
  CustomersReservationUpsertV1, CustomersReviewRecordV1,
} from "@munim/contracts/customers";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import { campaignRecordSent } from "./campaign-sent.ts";
import { bulkOrderUpsert, campaignCancel, campaignCreate, customerUpsert, loyaltyAdjust, reservationUpsert, reviewRecord } from "./records.ts";
import {
  customerExists, listBulkOrders, listCampaigns, listCouponUses, listCustomers, listReservations, listReviews, readLoyalty, type Scope,
} from "./reads.ts";
import { readRoutes } from "./routes.ts";

export { loyaltyBalance, loyaltyEarnFor, loyaltyPolicy, loyaltyRedeem, loyaltyReverseFor } from "./loyalty.ts";
export { readLoyalty } from "./reads.ts";

// Loaded once by path (tests, T-022) and once by file URL (loadRouters): never register twice.
try {
  registerDraftHandler(campaignCreate);
} catch {
  // already registered by the other load of this file
}

type Member = Extract<AppEnv["Variables"]["principal"], { kind: "member" }>;
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}
/** Role gate for reads (writes are judged by the book guard against core.command_authority). */
const allow = (m: Member, ...roles: Member["role"][]) => {
  if (!roles.includes(m.role)) throw new ApiError("forbidden");
};
const scopeOf = (m: Member): Scope => (m.outlet_ids === "*" ? null : m.outlet_ids);
const read = <T>(c: Context<AppEnv>, m: Member, fn: (q: import("../../runtoken/index.ts").Queryable) => Promise<T>) =>
  withContext(c.var.deps.pools.core, contextOf(m), fn);

const limitOf = (v: string | undefined, def: number, max: number) => {
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiError("bad_request");
  return Math.min(n, max);
};
const uuidQ = (v: string | undefined) => {
  if (v !== undefined && !new RegExp(`^${ID}$`).test(v)) throw new ApiError("bad_request");
  return v;
};
const dateQ = (v: string | undefined) => {
  if (v !== undefined && Number.isNaN(Date.parse(v))) throw new ApiError("bad_request");
  return v;
};

/** Database refusals that are the caller's data, not a bug: a duplicate, a missing reference, a check. */
function dataError(e: unknown): ApiError | null {
  const s = (e as { code?: unknown } | null)?.code;
  if (s === "23505") return new ApiError("conflict");
  if (typeof s === "string" && /^(23|22)/.test(s)) return new ApiError("invalid_payload");
  return null;
}

async function command(c: Context<AppEnv>, type: string, schema: Parameters<typeof commandEnvelopeOf>[1], handler: CommandHandler) {
  const m = member(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
  const env = commandEnvelopeOf(type, schema).safeParse(body);
  if (!env.success) throw new ApiError("invalid_payload");
  const { deps } = c.var;
  try {
    const out = await executeCommand(
      { tx: (fn) => withContext(deps.pools.core, contextOf(m), fn), tenantId: m.tenant_id, actor: { kind: "member", id: m.member_id, role: m.role }, ...(deps.publish ? { publish: deps.publish } : {}) },
      env.data as Parameters<typeof executeCommand>[1], handler);
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  } catch (e) {
    throw dataError(e) ?? e;
  }
}

export const router = new Hono<AppEnv>()
  .get("/v1/customers", requireMember, async (c) => {
    const m = member(c);
    allow(m, "owner", "manager", "staff", "judge");
    const f = { q: c.req.query("q"), limit: limitOf(c.req.query("limit"), 50, 200), cursor: uuidQ(c.req.query("cursor")), full: m.role !== "staff" };
    return c.json(await read(c, m, (q) => listCustomers(q, f)), 200);
  })
  .post("/v1/customers:upsert", requireMember, (c) => command(c, "customers.customer.upsert.v1", CustomersCustomerUpsertV1, customerUpsert))
  .get(`/v1/customers/:id{${ID}}/loyalty`, requireMember, async (c) => {
    const m = member(c);
    allow(m, "owner", "manager", "staff", "judge");
    const id = c.req.param("id");
    return c.json(await read(c, m, async (q) => {
      if (!(await customerExists(q, id))) throw new ApiError("not_found");
      return readLoyalty(q, id);
    }), 200);
  })
  .get(`/v1/customers/:id{${ID}}/coupon-uses`, requireMember, async (c) => {
    const m = member(c);
    allow(m, "owner", "manager", "staff", "judge");
    const id = c.req.param("id");
    return c.json({ coupon_uses: await read(c, m, async (q) => {
      if (!(await customerExists(q, id))) throw new ApiError("not_found");
      return listCouponUses(q, id);
    }) }, 200);
  })
  .post("/v1/loyalty:adjust", requireMember, (c) => command(c, "customers.loyalty.adjust.v1", CustomersLoyaltyAdjustV1, loyaltyAdjust))
  .get("/v1/campaigns", requireMember, async (c) => {
    const m = member(c);
    allow(m, "owner", "manager", "judge");
    return c.json({ campaigns: await read(c, m, listCampaigns) }, 200);
  })
  .post("/v1/campaigns:cancel", requireMember, (c) => command(c, "customers.campaign.cancel.v1", CustomersCampaignCancelV1, campaignCancel))
  .post("/v1/campaigns:record-sent", requireMember, (c) => command(c, "customers.campaign.record_sent.v1", CustomersCampaignRecordSentV1, campaignRecordSent))
  .get("/v1/reservations", requireMember, async (c) => {
    const m = member(c);
    allow(m, "owner", "manager", "staff", "judge");
    const f = { outlet_id: uuidQ(c.req.query("outlet_id")), from: dateQ(c.req.query("from")), to: dateQ(c.req.query("to")) };
    return c.json({ reservations: await read(c, m, (q) => listReservations(q, scopeOf(m), f)) }, 200);
  })
  .post("/v1/reservations:upsert", requireMember, (c) => command(c, "customers.reservation.upsert.v1", CustomersReservationUpsertV1, reservationUpsert))
  .get("/v1/reviews", requireMember, async (c) => {
    const m = member(c);
    const f = { outlet_id: uuidQ(c.req.query("outlet_id")), limit: limitOf(c.req.query("limit"), 100, 500) };
    return c.json({ reviews: await read(c, m, (q) => listReviews(q, scopeOf(m), f)) }, 200);
  })
  .post("/v1/reviews:record", requireMember, (c) => command(c, "customers.review.record.v1", CustomersReviewRecordV1, reviewRecord))
  .get("/v1/bulk-orders", requireMember, async (c) => {
    const m = member(c);
    allow(m, "owner", "manager", "judge");
    return c.json({ bulk_orders: await read(c, m, (q) => listBulkOrders(q, scopeOf(m), { outlet_id: uuidQ(c.req.query("outlet_id")) })) }, 200);
  })
  .post("/v1/bulk-orders:upsert", requireMember, (c) => command(c, "customers.bulk_order.upsert.v1", CustomersBulkOrderUpsertV1, bulkOrderUpsert))
  .route("/", readRoutes);
