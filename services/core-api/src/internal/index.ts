// /internal/intel/v1 — intel's only write path (R25, ADR-014 §5; T-040 W1 subset + model-roles). Mounted by
// modules/index.ts. Every route: service secret + run token (auth.ts), then ONE munim_svc transaction under the
// token's tenant and outlet scope. Bodies are the contracts `internal.*` schemas; errors are the fixed error table.
//   POST events:claim   → 200 | 409 on a repeat claim       POST watch:claim → 200 {go}
//   POST snapshots      → 201 snapshot (allow-listed template, run's RLS)
//   POST findings       → 201 {outcome: stored | merged | abstained}
//   POST drafts         → 201 {status: proposed | abstained} (idempotent, open-duplicate merge, recently_rejected)
//   POST answers        → 201                               POST traces:batch → 201 {inserted, last_seq}
//   GET  model-roles    → 200 platform.model_role (R36; the board files it under T-040b)
import { MintSnapshotRequest } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";
import { mintSnapshot } from "../modules/evidence/mint.ts";
import { modelRoles } from "../platform/read.ts";
import type { OutletScope, Queryable } from "../runtoken/index.ts";
import { authenticate, type InternalConfig, type Run, runTx } from "./auth.ts";
import { writeDraft } from "./drafts.ts";
import { claimEvent, claimWatch, writeAnswer, writeFinding, writeTraces } from "./writes.ts";

export { configureInternal, type InternalConfig, SERVICE_SECRET_HEADER } from "./auth.ts";

const P = "/internal/intel/v1";
const WATCH_WINDOW_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const post = (status: 200 | 201, fn: (q: Queryable, run: Run, body: unknown, cfg: InternalConfig) => Promise<object | string>) =>
  async (c: Context<AppEnv>) => {
    const { run, cfg } = await authenticate(c);
    const body: unknown = await c.req.json().catch(() => undefined);
    if (body === undefined) throw new ApiError("bad_request");
    const out = await runTx(c.var.deps, run, (q) => fn(q, run, body, cfg));
    // drafts returns its stored text, so a replay is byte-identical to the first response.
    return typeof out === "string" ? c.body(out, status, { "Content-Type": "application/json" }) : c.json(out, status);
  };

export const router = new Hono<AppEnv>()
  .post(`${P}/:seg{events:claim}`, post(200, claimEvent))
  .post(`${P}/:seg{watch:claim}`, post(200, (q, run, body, cfg) => claimWatch(q, run, body, cfg.watchWindowMs ?? WATCH_WINDOW_MS)))
  .post(`${P}/snapshots`, async (c) => {
    const { run } = await authenticate(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) throw new ApiError("bad_request");
    const body = MintSnapshotRequest.safeParse(raw);
    if (!body.success) throw new ApiError("invalid_payload");
    // T-043 (T-040 note a): a tenant-wide run (a sweep) that mints for ONE outlet mints under that outlet's scope —
    // RLS and the stored outlet_scope both narrow — so the snapshot, and a finding cut from it, belong to that outlet
    // and its own members can open them (a '*' snapshot is visible to all-outlet members only).
    const one = body.data.params.outlet_id;
    const scope: OutletScope = run.scope[0] === "*" && typeof one === "string" && UUID.test(one) ? [one] : run.scope;
    const out = await runTx(c.var.deps, { tenantId: run.tenantId, scope }, (q) =>
      mintSnapshot(q, run.tenantId, { kind: "run", run_id: run.runId, scope }, body.data.template_id, body.data.params));
    return c.json(out, 201);
  })
  .post(`${P}/findings`, post(201, writeFinding))
  .post(`${P}/drafts`, post(201, writeDraft))
  .post(`${P}/answers`, post(201, writeAnswer))
  .post(`${P}/:seg{traces:batch}`, post(201, writeTraces))
  .get(`${P}/model-roles`, async (c) => {
    const { run } = await authenticate(c);
    return c.json(await runTx(c.var.deps, run, modelRoles), 200);
  });
