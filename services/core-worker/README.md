# services/core-worker

One long-running process that does the scheduled and background work core-api does not do inside a request. It logs in to
Postgres as `munim_svc`, which has no write grant on any book table, and refuses to start under any other role, so nothing it
runs can change the books. Run **exactly one instance**.

## Jobs

All seven run on one cron registry (`src/cron.ts`): `src/worker.ts` registers the first four, and `composeWorker` in
`src/main.ts` adds the last three. A job whose previous run is still going skips the boundary. A host without this
process can instead run the jobs through core-api's `/internal/cron/v1/tick` (`Worker.tick`; core-api's env-only boot
with `MUNIM_CRON_SECRET` set). Each tick runs every job once for its slot (`MUNIM_TICK_PERIOD_MIN`, default a day), and
each (job, slot) is claimed in `core.tick_claim`, so a repeated or retried tick never runs a slot twice.

| Job | Every | What it does |
|---|---|---|
| `outbox-sweep` | 1 minute | Publishes outbox rows that the request which wrote them could not (`src/sweeper.ts`). Delivery is at least once; a row that fails five times is dead-lettered. |
| `fanout-watch` | 15 minutes | For each active tenant, mints a run token and calls intel's `/watch:sweep` (`src/fanout.ts`) |
| `fanout-brief` | 15 minutes | For tenants whose local time is 06:00, calls intel's `/brief` (`src/local-time.ts`) |
| `nightly` | 15 minutes | Runs the per-outlet tasks it is given at each outlet's business-day cutoff. `main.ts` registers none today. |
| `imports-parse` | 1 minute | Parses uploaded files into staging rows (`src/imports/`); a person still approves the import |
| `investigations-auto-imports` | 1 minute | Resumes an Auto investigation that was waiting on data when an import is approved (`src/investigations/`) |
| `investigations-auto-daily` | 24 hours (00:00 UTC) | Steps each open or waiting Auto investigation that has new data since its last step, within its creator's grant, ceiling and the month's AI budget |

## Entry points

- `src/main.ts` is the process entry (`node src/main.ts`) and the composition root (`composeWorker`). It wires the publisher,
  the run-token minter, the intel client, the blob store and the jobs, then runs until `SIGTERM` (`src/process.ts`).
- `src/ports.ts` holds the ports the worker depends on, so tests can inject a fake clock and a fake intel.

## Run and test

```bash
pnpm -F @munim/core-worker test         # vitest on an embedded Postgres, with a fake clock and a stub intel
pnpm -F @munim/core-worker typecheck
node src/main.ts                        # from services/core-worker; needs MUNIM_DB_URL_TRANSACTION, munim_svc's password
                                        # (it shares core-api's .run/ secret and keys; MUNIM_INTEL_URL: 127.0.0.1:8081)
```

The environment names are in `packages/config/src/index.ts` and in the table in
[`infra/gcp/README.md`](../../infra/gcp/README.md). On Google Cloud the entry is `infra/gcp/entries/core-worker.mjs`.

## Key files

| Path | What it does |
|---|---|
| `src/worker.ts` | The `Worker`: pool, role check, the cron jobs |
| `src/cron.ts` | The cron registry, and the slot-claim interface a tick uses |
| `src/sweeper.ts` | The outbox sweep, with an advisory lock so only one sweeper runs |
| `src/fanout.ts` | Per-tenant fan-out to intel with bounded concurrency |
| `src/local-time.ts` | Which tenants and outlets are due at a local time, across time zones |
| `test/` | Cron, sweeper, fan-out, poison-row, local-time, tick, investigations and worker tests |
