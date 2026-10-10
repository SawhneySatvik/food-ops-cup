// Kitchen module (T-023). Mounted by modules/index.ts.
//   GET  /v1/kitchen/board?outlet=&station=            KDS read model (restaurants and cloud kitchens only)
//   POST /v1/kitchen/tickets/{id}:advance              kitchen.ticket.advance.v1
//   POST /v1/kitchen/prep-times                        kitchen.prep_time.set.v1   (draftable)
//   POST /v1/kitchen/prep-lists                        kitchen.prep_list.create.v1 (draftable)
//   GET  /v1/kitchen/prep-list?outlet=&business_date=  K3 state
// Seam for T-022: `createTicketsFor(tx, order_id)`. Shops: the kitchen does not apply — routes refuse 400
// bad_request / not_applicable, the seam returns applicable=false.
import { commandEnvelopeOf, type CommandEnvelope } from "@munim/contracts";
import { KitchenPrepListCreateV1, KitchenPrepTimeSetV1, KitchenTicketAdvanceV1 } from "@munim/contracts/kitchen";
import { evaluateAuthority } from "@munim/core-domain/authority";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import { prepListHandler, prepListView, prepTimeHandler } from "./prep.ts";
import { advanceHandler, buildBoard } from "./tickets.ts";

export { createTicketsFor } from "./tickets.ts";
export type { CreatedTicket, CreateTicketsResult } from "./tickets.ts";
export { buildBoard } from "./tickets.ts";
export { isLegalAdvance, ticketColour, NEXT, AMBER_LEAD_MS } from "./rules.ts";

// The two draftable commands: approvals executes these under the approver's decision.
// A module loaded twice in one process (test import + router load) finds the type already registered: that is fine.
for (const h of [prepTimeHandler, prepListHandler]) {
  try {
    registerDraftHandler(h);
  } catch {
    /* already registered */
  }
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Member = Extract<AppEnv["Variables"]["principal"], { kind: "member" }>;
function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

/** The outlet must be in the member's scope (404 otherwise, like RLS) and must be a kitchen: shops refuse. */
async function kitchenOutlet(c: Context<AppEnv>, m: Member, outlet: string | undefined): Promise<string> {
  if (!outlet || !UUID.test(outlet)) throw new ApiError("bad_request");
  if (m.outlet_ids !== "*" && !m.outlet_ids.includes(outlet)) throw new ApiError("not_found");
  const kind = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
    (await db.query<{ kind: string }>(`SELECT kind FROM core.outlet WHERE id = $1`, [outlet])).rows[0]?.kind);
  if (!kind) throw new ApiError("not_found");
  if (kind === "store") throw new ApiError("bad_request", "not_applicable");
  return outlet;
}

/** Role + outlet scope from core.command_authority before anything runs (prep_time.set is operational, so the
 *  book guard would not catch a staff member; the draft path is judged by approvals). */
async function authorise(c: Context<AppEnv>, m: Member, type: string, outlet: string): Promise<void> {
  const row = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
    (await db.query<{ command_type: string; allowed_roles: string[]; scope: string; max_amount_minor: string | null }>(
      `SELECT command_type, allowed_roles, scope, max_amount_minor FROM core.command_authority WHERE command_type = $1`, [type])).rows[0]);
  const verdict = row && evaluateAuthority(
    { command_type: type, role: m.role, outlet_scope: m.outlet_ids === "*" ? ["*"] : m.outlet_ids, target_outlet_id: outlet },
    [{ ...row, max_amount_minor: row.max_amount_minor === null ? null : Number(row.max_amount_minor) }]);
  if (!verdict?.allow) throw new ApiError("forbidden", "authority_denied");
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

async function runCommand(c: Context<AppEnv>, m: Member, env: CommandEnvelope, handler: CommandHandler) {
  const deps = c.var.deps;
  const out = await executeCommand({
    tx: (fn) => withContext(deps.pools.core, contextOf(m), fn),
    tenantId: m.tenant_id,
    actor: { kind: "member", id: m.member_id, role: m.role },
    ...(deps.publish ? { publish: deps.publish } : {}),
    onPublishDeferred: (ids) => deps.log(`kitchen: ${ids.length} event(s) left for the sweeper`),
  }, env, handler);
  return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
}

const AdvanceEnvelope = commandEnvelopeOf("kitchen.ticket.advance.v1", KitchenTicketAdvanceV1);
const PrepTimeEnvelope = commandEnvelopeOf("kitchen.prep_time.set.v1", KitchenPrepTimeSetV1);
const PrepListEnvelope = commandEnvelopeOf("kitchen.prep_list.create.v1", KitchenPrepListCreateV1);

export const router = new Hono<AppEnv>()
  .get("/v1/kitchen/board", requireMember, async (c) => {
    const m = member(c);
    const outlet = await kitchenOutlet(c, m, c.req.query("outlet"));
    const station = c.req.query("station");
    if (station !== undefined && !/^[a-z][a-z0-9_]*$/.test(station)) throw new ApiError("bad_request");
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (db) => buildBoard(db, outlet, new Date(), station)), 200);
  })
  .post(`/v1/kitchen/tickets/:action{${ID}:advance}`, requireMember, async (c) => {
    const m = member(c);
    const env = AdvanceEnvelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    if (env.data.payload.ticket_id !== c.req.param("action")!.slice(0, -":advance".length)) throw new ApiError("invalid_payload");
    // The ticket's outlet decides scope: RLS hides another outlet's ticket (404); a shop has no tickets.
    const t = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
      (await db.query<{ outlet_id: string }>(`SELECT outlet_id FROM core.kitchen_ticket WHERE id = $1`, [env.data.payload.ticket_id])).rows[0]);
    if (!t) throw new ApiError("not_found");
    await authorise(c, m, "kitchen.ticket.advance.v1", t.outlet_id);
    return runCommand(c, m, env.data, advanceHandler);
  })
  .post("/v1/kitchen/prep-times", requireMember, async (c) => {
    const m = member(c);
    const env = PrepTimeEnvelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    await kitchenOutlet(c, m, env.data.payload.outlet_id);
    await authorise(c, m, "kitchen.prep_time.set.v1", env.data.payload.outlet_id);
    return runCommand(c, m, env.data, prepTimeHandler);
  })
  .post("/v1/kitchen/prep-lists", requireMember, async (c) => {
    const m = member(c);
    const env = PrepListEnvelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    await kitchenOutlet(c, m, env.data.payload.outlet_id);
    await authorise(c, m, "kitchen.prep_list.create.v1", env.data.payload.outlet_id);
    return runCommand(c, m, env.data, prepListHandler);
  })
  .get("/v1/kitchen/prep-list", requireMember, async (c) => {
    const m = member(c);
    const outlet = await kitchenOutlet(c, m, c.req.query("outlet"));
    const date = c.req.query("business_date");
    if (!date || !DATE.test(date)) throw new ApiError("bad_request");
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (db) => prepListView(db, outlet, date)), 200);
  });
