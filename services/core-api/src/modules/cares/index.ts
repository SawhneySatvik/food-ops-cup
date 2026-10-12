// Munim Cares member module (T-095a; ADR-015 §1.3, §3, §5). Every write is the member's own typed command through
// executeCommand (idempotency, audit chain, outbox after commit); `cares.listing.publish.v1` is also an approvable draft
// (intel proposes, a person approves; nothing auto-applies, R16). None of these routes reads the AI kill switch.
//   GET/POST /v1/cares/profile                     cares.profile.set.v1
//   GET      /v1/cares/recipients?outlet=
//   GET/POST /v1/cares/listings                    cares.listing.publish.v1 (draftable)
//   GET      /v1/cares/listings/{id} · /v1/cares/listings/{id}/claims
//   POST     /v1/cares/listings/{id}:withdraw       cares.listing.withdraw.v1
//   POST     /v1/cares/listings/{id}:decide         cares.claim.decide.v1
//   POST     /v1/cares/handovers                    cares.handover.record.v1
//   POST     /v1/cares/handovers/{id}:void          cares.handover.void.v1
//   GET      /v1/cares/market?listing=
//   GET/POST /v1/cares/claims                       cares.claim.create.v1
//   POST     /v1/cares/claims/{id}:cancel|close|receive
import { commandEnvelopeOf, type CommandEnvelope } from "@munim/contracts";
import { SCHEMAS } from "@munim/contracts/cares";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, ID, inScope, limitOf, memberOf, methodGuard, optEnum, optUuid, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import * as cmd from "./commands.ts";
import * as read from "./read.ts";

// Loaded twice in one process (vitest by path, loadRouters by URL): register once.
const ONCE = Symbol.for("munim.cares.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[ONCE]) {
  registerDraftHandler(cmd.listingPublish);
  g[ONCE] = true;
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

/** The member's own command; `idOf` ties a path id to the payload field it names (a mismatch is invalid_payload). */
function post(handler: CommandHandler, idOf?: { field: string; suffix: string }) {
  const Envelope = commandEnvelopeOf(handler.type, SCHEMAS[handler.type as keyof typeof SCHEMAS]);
  return async (c: Context<AppEnv>) => {
    const m = memberOf(c);
    const env = Envelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    if (idOf && (env.data.payload as Record<string, unknown>)[idOf.field] !== c.req.param("action")!.slice(0, -idOf.suffix.length)) throw new ApiError("invalid_payload");
    const deps = c.var.deps;
    const out = await executeCommand({
      tx: (fn) => withContext(deps.pools.core, contextOf(m), fn),
      tenantId: m.tenant_id,
      actor: { kind: "member", id: m.member_id, role: m.role },
      ...(deps.publish ? { publish: deps.publish } : {}),
      onPublishDeferred: (ids) => deps.log(`cares: ${ids.length} event(s) left for the sweeper`),
    }, env.data as CommandEnvelope, handler);
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  };
}

/** A filter outlet must be in the member's scope (404 otherwise, like RLS). */
function scopedOutlet(c: Context<AppEnv>): string | null {
  const outlet = optUuid(c, "outlet");
  if (outlet !== null) inScope(memberOf(c), outlet);
  return outlet;
}

const action = (suffix: string) => `/:action{${ID}:${suffix}}`;

export const router = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/cares/profile", requireMember, async (c) => c.json(await readAs(c, read.profile), 200))
    .post("/v1/cares/profile", requireMember, post(cmd.profileSet))
    .get("/v1/cares/recipients", requireMember, async (c) => {
      const outlet = scopedOutlet(c);
      if (outlet === null) throw new ApiError("bad_request");
      return c.json(await readAs(c, (db) => read.recipients(db, outlet)), 200);
    })
    .get("/v1/cares/listings", requireMember, async (c) => {
      const q = { outlet: scopedOutlet(c), kind: optEnum(c, "kind", ["donation", "offer"] as const), status: optEnum(c, "status", ["published", "allocated", "closed", "withdrawn"] as const),
        cursor: cursorOf(c), limit: limitOf(c) };
      return c.json(await readAs(c, (db) => read.listings(db, q)), 200);
    })
    .post("/v1/cares/listings", requireMember, post(cmd.listingPublish))
    .get(`/v1/cares/listings/:id{${ID}}`, requireMember, async (c) => c.json(await readAs(c, (db) => read.listing(db, c.req.param("id"))), 200))
    .get(`/v1/cares/listings/:id{${ID}}/claims`, requireMember, async (c) => c.json(await readAs(c, (db) => read.inboundClaims(db, c.req.param("id"))), 200))
    .post(`/v1/cares/listings${action("withdraw")}`, requireMember, post(cmd.listingWithdraw, { field: "listing_id", suffix: ":withdraw" }))
    .post(`/v1/cares/listings${action("decide")}`, requireMember, post(cmd.claimDecide, { field: "listing_id", suffix: ":decide" }))
    .post("/v1/cares/handovers", requireMember, post(cmd.handoverRecord))
    .post(`/v1/cares/handovers${action("void")}`, requireMember, post(cmd.handoverVoid, { field: "handover_id", suffix: ":void" }))
    .get("/v1/cares/market", requireMember, async (c) => {
      const listing = optUuid(c, "listing");
      return c.json(await readAs(c, (db) => read.market(db, listing)), 200);
    })
    .get("/v1/cares/claims", requireMember, async (c) => {
      const outlet = scopedOutlet(c);
      return c.json(await readAs(c, (db) => read.claims(db, outlet)), 200);
    })
    .post("/v1/cares/claims", requireMember, post(cmd.claimCreate))
    .post(`/v1/cares/claims${action("cancel")}`, requireMember, post(cmd.claimCancel, { field: "claim_id", suffix: ":cancel" }))
    .post(`/v1/cares/claims${action("close")}`, requireMember, post(cmd.claimClose, { field: "claim_id", suffix: ":close" }))
    .post(`/v1/cares/claims${action("receive")}`, requireMember, post(cmd.claimReceive, { field: "claim_id", suffix: ":receive" })),
  [
    ["/v1/cares/profile", "GET, POST"], ["/v1/cares/recipients", "GET"], ["/v1/cares/listings", "GET, POST"], [`/v1/cares/listings/:id{${ID}}`, "GET"],
    [`/v1/cares/listings/:id{${ID}}/claims`, "GET"], ["/v1/cares/market", "GET"], ["/v1/cares/claims", "GET, POST"],
  ],
);

export { cmd as handlers };
