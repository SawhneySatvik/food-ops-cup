// /internal/intel/v1 — intel's only write path (R25, ADR-014 §5; T-040 W1 subset + model-roles). Mounted by
// modules/index.ts. Every route: service secret + run token (auth.ts), then ONE munim_svc transaction under the
// token's tenant and outlet scope. Bodies are the contracts `internal.*` schemas; errors are the fixed error table.
//   POST events:claim   → 200 | 409 on a repeat claim       POST watch:claim → 200 {go}
//   POST snapshots      → 201 snapshot (allow-listed template, run's RLS)
//   POST findings       → 201 {outcome: stored | merged | abstained}
//   POST drafts         → 201 {status: proposed | abstained} (idempotent, open-duplicate merge, recently_rejected)
//   POST answers        → 201                               POST traces:batch → 201 {inserted, last_seq}
//   GET  model-roles    → 200 platform.model_role + the operator's per-1M-token prices (R36, R47 D1; the board files it under T-040b)
// T-040b (batches.ts, frame.ts):
//   POST entities:batch · aliases:batch · chunks:batch · claims:batch · edges:batch · quotes:batch · spend
//                       → 201 {inserted, existing} (idempotent by id; same id + other body → 409)
//   traces:batch and spend also take a run core ended up to ENDED_GRACE_S ago (auth.ts); every other route refuses it
//   POST embeddings:batch → 201, or 503 where 0013 (pgvector) is not applied
//   POST wiki:batch      → 201 {pages[{status: stored | existing | abstained}]}
//   POST forecasts:batch → 201 {run_inserted, inserted, existing}
//   GET  run-frame      → 200 pack, thresholds, outlets, budget, narration, negotiation bounds (R47 D7)
//   GET  brief-items    → 200 the ranked inbox (brief runs only; no dedupe key)
//   POST graph:query    → 200 {rows} — one of five core-owned graph templates, tenant from the token (graph/index.ts)
import { MintSnapshotRequest } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";
import { mintSnapshot } from "../modules/evidence/mint.ts";
import { modelRoles } from "../platform/read.ts";
import type { OutletScope, Queryable } from "../runtoken/index.ts";
import { authenticate, type InternalConfig, type Run, runTx } from "./auth.ts";
import {
  refusing, writeAliases, writeChunks, writeClaims, writeEdges, writeEmbeddings, writeEntities, writeForecasts, writeQuotes, writeSpend, writeWiki,
} from "./batches.ts";
import { briefItems } from "./brief.ts";
import { writeDraft } from "./drafts.ts";
import { graphQuery } from "./graph/index.ts";
import { runFrame } from "./frame.ts";
import { claimEvent, claimWatch, writeAnswer, writeFinding, writeTraces } from "./writes.ts";

export { configureInternal, type InternalConfig, SERVICE_SECRET_HEADER } from "./auth.ts";

const P = "/internal/intel/v1";
const WATCH_WINDOW_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const post = (status: 200 | 201, fn: (q: Queryable, run: Run, body: unknown, cfg: InternalConfig) => Promise<object | string>, auth: { afterEnd?: boolean } = {}) =>
  async (c: Context<AppEnv>) => {
    const { run, cfg } = await authenticate(c, auth);
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
  // A run's spend and traces are taken for ENDED_GRACE_S after core ends it (auth.ts); nothing else is.
  .post(`${P}/:seg{traces:batch}`, post(201, writeTraces, { afterEnd: true }))
  .get(`${P}/model-roles`, async (c) => {
    const { run } = await authenticate(c);
    return c.json(await runTx(c.var.deps, run, modelRoles), 200);
  })
  .post(`${P}/:seg{entities:batch}`, post(201, refusing(writeEntities)))
  .post(`${P}/:seg{aliases:batch}`, post(201, refusing(writeAliases)))
  .post(`${P}/:seg{chunks:batch}`, post(201, refusing(writeChunks)))
  .post(`${P}/:seg{claims:batch}`, post(201, refusing(writeClaims)))
  .post(`${P}/:seg{edges:batch}`, post(201, refusing(writeEdges)))
  .post(`${P}/:seg{embeddings:batch}`, post(201, refusing(writeEmbeddings)))
  .post(`${P}/:seg{wiki:batch}`, post(201, refusing(writeWiki)))
  .post(`${P}/:seg{forecasts:batch}`, post(201, refusing(writeForecasts)))
  .post(`${P}/:seg{quotes:batch}`, post(201, refusing(writeQuotes)))
  .post(`${P}/spend`, post(201, refusing(writeSpend), { afterEnd: true }))
  .post(`${P}/:seg{graph:query}`, post(200, graphQuery))
  .get(`${P}/brief-items`, async (c) => {
    const { run, cfg } = await authenticate(c);
    // Only a brief run reads the ranked inbox (an event or sweep token must not).
    if (run.trigger !== "brief") throw new ApiError("not_found");
    const at = (cfg.clock ?? (() => new Date()))();
    return c.json(await runTx(c.var.deps, run, (q) => briefItems(q, run, at)), 200);
  })
  .get(`${P}/run-frame`, async (c) => {
    const { run, cfg } = await authenticate(c);
    const at = (cfg.clock ?? (() => new Date()))();
    return c.json(await runTx(c.var.deps, run, (q) => runFrame(q, run, at)), 200);
  });
