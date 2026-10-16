# services/core-api

The system of record. A Hono (TypeScript) API and the **only writer of Postgres**. All data is synthetic, suppliers are
simulated and payments are recorded, never processed.

| Surface | Path prefix | Callers |
|---|---|---|
| Public API | `/v1` | Staff and owners (bearer token and `X-Munim-Tenant`), customers and guests (`X-Munim-Storefront-Key`) |
| Operator API | `/platform/v1` | Platform operators |
| Internal API | `/internal/intel/v1` | intel only (service secret and a run token) |
| Server-sent events | `/v1/stream` | Browsers, through the SDK |
| Health | `/health` | Anyone; a database round trip on both pools and the migration version |

The routes are generated into [`packages/contracts/generated/openapi/`](../../packages/contracts/generated/openapi/). See
[`docs/api.md`](../../docs/api.md) for the summary.

## What it guarantees

- The tenant comes only from a verified identity or a verified run token. No route takes it from a body, and no model sees it.
- Every change is a command: one transaction holds the idempotency check, the book writes, the audit entry and the outbox
  row, and events are published after commit (`src/commit/`).
- Prices and totals are re-derived on the server. Error bodies come from a fixed table (`src/lib/errors.ts`), never from an
  exception, SQL or model text.
- A draft is approved in one transaction under the approver's identity (`src/modules/approvals/decide.ts`).

## Entry points

- `src/server.ts` is the process entry (`node src/server.ts`) and the composition root: it builds the three database pools
  (`munim_core`, `munim_svc`, `munim_platform`), the identity provider and blob store from configuration, the run-token keys,
  and the ports to intel (ask, narrate, negotiate, publish).
- `src/app.ts` builds the Hono app: CORS, body limits, health, every module router, and the error handler.
- `src/modules/index.ts` lists the modules. A listed module without a `router` export stops the boot.

## Layout

| Path | What it holds |
|---|---|
| `src/modules/<module>/` | One folder per domain: accounts, ai_policy, approvals, cares, cares-network, catalogue, compliance, customers, evidence, finance, findings, goals, imports, inbox, inventory, investigations, kitchen, lineage, orders, people, purchasing, runs, specialists, storefront, tenancy, threads, traces |
| `src/internal/` | Intel's routes: snapshots, findings, drafts, answers, traces, batches, run frame, brief items |
| `src/platform/` | Operator routes: tenants, packs, model roles, budgets, config drafts |
| `src/stream/` | The `LISTEN` hub, the SSE feed and its cursors |
| `src/auth/` | Token verification (`jwt.ts`), the identity port, the local test identity provider, principal resolution |
| `src/runtoken/` | Minting and verifying Ed25519 run tokens, and the key helpers |
| `src/commit/` | `executeCommand`, the audit chain, the outbox and the HTTP publisher |
| `src/lib/` | Database context (`SET LOCAL`), errors, CORS, rate limiting, the demo guard |
| `src/cron/` | An optional HTTP tick route for a scheduler. Only the env-only boot (`src/env-root.ts`) wires it, and only when `MUNIM_CRON_SECRET` is set; otherwise it answers 404 |

## Run and test

```bash
pnpm -F @munim/core-api start        # node src/server.ts; needs MUNIM_DB_URL_*, the role passwords and MUNIM_IDP
                                     # (the service secret and run-token keys are generated under .run/ when unset)
pnpm -F @munim/core-api test         # vitest on an embedded Postgres; the models are not involved
pnpm -F @munim/core-api typecheck
```

The names of the environment variables are in `packages/config/src/index.ts` and in the table in
[`infra/gcp/README.md`](../../infra/gcp/README.md). Configuration is read through the one config module, which redacts
secrets from errors and logs.

Tests live in `test/` and beside the code (`src/commit`, `src/runtoken`, `src/modules/threads`). They drive the real app over
a real database with a local identity provider.
