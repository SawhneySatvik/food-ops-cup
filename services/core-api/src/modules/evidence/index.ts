// Evidence module (T-040): how a person opens the ledger rows behind a ref (R15) and mints a template snapshot
// for a dashboard number (R40 C4). Mounted by modules/index.ts.
//   POST /v1/snapshots        {template_id, params} → snapshot (minted_by_member_id; scope from the member token)
//   GET  /v1/snapshots/{id}   → snapshot, or 404 when the member's role or outlet scope does not cover it
import { MintSnapshotRequest } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { mintSnapshot, readSnapshot } from "./mint.ts";

export { mintSnapshot, readSnapshot, type Minter } from "./mint.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

export const router = new Hono<AppEnv>()
  .post("/v1/snapshots", requireMember, async (c) => {
    const m = member(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) throw new ApiError("bad_request");
    const body = MintSnapshotRequest.safeParse(raw);
    if (!body.success) throw new ApiError("invalid_payload");
    const scope = m.outlet_ids === "*" ? ["*" as const] as ["*"] : m.outlet_ids;
    const snap = await withContext(c.var.deps.pools.core, contextOf(m), (q) =>
      mintSnapshot(q, m.tenant_id, { kind: "member", member_id: m.member_id, role: m.role, scope }, body.data.template_id, body.data.params));
    return c.json(snap, 201);
  })
  .get(`/v1/snapshots/:id{${ID}}`, requireMember, async (c) => {
    const m = member(c);
    const snap = await withContext(c.var.deps.pools.core, contextOf(m), (q) => readSnapshot(q, c.req.param("id"), m));
    if (!snap) throw new ApiError("not_found");
    return c.json(snap, 200);
  });
