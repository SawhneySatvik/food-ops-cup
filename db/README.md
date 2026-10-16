# db: migrations, runner and test harness

The SQL in [`migrations/`](./migrations/) is the contract for Munim's database. Migrations are forward-only: an applied file is
never edited, and a fix is a new file. The data-model page in [`../docs/data-model.md`](../docs/data-model.md) is a map of
the result.

## What is here

| Path | What it is |
|---|---|
| `migrations/` | 34 numbered SQL files, `0001` to `0034` |
| `migrate.ts` | The runner. Applies files in order, one transaction each, from `0002` on under `SET LOCAL ROLE munim_migrator`. Records each file's SHA-256 in `munim_meta.schema_migrations` and refuses an applied file whose bytes changed. A `-- requires: vector` header skips a file loudly where the extension is missing. |
| `seeds/packs.ts` | Seeds `platform.country_pack` from `packages/contracts/packs/*.json`. Idempotent; a changed document for a published version is refused. |
| `scripts/bootstrap-roles.ts` | Sets a fresh random password on each login role and writes `.run/db-roles.json` (mode 0600). Re-running rotates every password. |
| `derivation-rules.json` | The allow-listed derivations that `core.derivation_rule` is seeded from |
| `src/` | The test harness: `harness.ts` starts an embedded Postgres 18 and applies the migrations; `world.ts` builds a canonical world with at least one row in every tenant table, through the runtime roles and the book guard |
| `tests/` | The database gates (see below) |

## Schemas and roles

Schemas: `core` (137 tables), `evidence` (2), `intel` (18), `platform` (12), `intel_ro` (11 read-only views) and `munim_meta`
(the migration record). Every `core` table is tagged `munim:book` (105) or `munim:operational` (32) in a table comment.

| Role | Login | Purpose |
|---|---|---|
| `munim_migrator` | no | Owns every schema and object; used by migrations only |
| `munim_crosstenant` | no, bypasses row-level security | Owns the short asserted list of objects that must cross tenants |
| `munim_view_owner` | no | Owns the `intel_ro` views |
| `munim_core` | yes | core-api's member, storefront and approval routes |
| `munim_svc` | yes | core-api's internal routes and core-worker; no write grant on any book table |
| `munim_platform` | yes | The operator routes |
| `munim_intel_ro` | yes | Reads the `intel_ro` views only; the tests assert it can write nothing |

## Run

```bash
pnpm -F @munim/db test                 # every database gate on an embedded Postgres 18; no Docker, no environment file
pnpm -F @munim/db typecheck
pnpm -F @munim/db migrate              # applies to $MUNIM_DB_URL_SESSION, an admin URL you export yourself
pnpm -F @munim/db seed:packs           # seeds the country packs (after migrate)
node db/scripts/bootstrap-roles.ts     # login passwords for the runtime roles, written to .run/db-roles.json
```

None of these scripts reads an environment file. `migrate`, `seed:packs` and `bootstrap-roles` read
`MUNIM_DB_URL_SESSION` from the process environment only. Point them only at a database you mean to change.

## Migrations

Files are named `NNNN_<name>.sql` in `migrations/`.

| Migration | What it adds |
|---|---|
| `0001` | The seven roles, the schemas, default-privilege revokes, extensions |
| `0002` | Country packs, plans, feature flags, AI budgets, model roles, operators, config drafts, platform audit |
| `0003` | Tenancy, command authority, command log, drafts and decisions, audit chain, outbox, the book guard, `intel.run`, evidence |
| `0004` | Catalogue, recipes, prices, deals, coupons, orders, tenders, shifts, customers, invoice series |
| `0005` | Stock, batches, counts, waste, suppliers, purchase orders, receiving, invoices, returns, MRP, expired-sale override |
| `0006` | Foreign-key and read-path indexes and catalog post-conditions |
| `0007` | Command-to-table binding, storefront keys and their lookup, outbox sequence, catalog assertion |
| `0008` | Chart of accounts, journal entries and postings, period close, settlements, bank lines, disputes |
| `0009` | Documents, import formats, runs, staging and quarantine, conversations |
| `0010` | Staff, rosters, attendance, payroll drafts, advances, tip pools, training, hiring |
| `0011` | Loyalty ledger, campaigns, reservations, reviews, bulk orders |
| `0012` | Compliance and assets, goals and tasks, market signals, the `intel` tables, the `intel_ro` views |
| `0013` | Chunk embeddings (needs `pgvector`; skipped where it is missing) |
| `0014` | Guard outlet scope, customer-scoped writes, order pricing rule, customer policies, run scope |
| `0015` | Draft-only commands, outlet policies on compliance and goals, refund caps, derivations, model-role defaults |
| `0016` | Per-order event sequence, loyalty reversal by refund, reconcile rules |
| `0017` | Row `origin` is never re-stamped on update; payable re-open; guest-token claim |
| `0018` | Dated history through the approved-import path (POS bills, waste) |
| `0019` | Outlet-scoped policies on remaining outlet tables; the first catalogue and finance snapshot templates |
| `0020` | Ask threads, per-role AI ceilings and monthly cap, investigations, steps and standing grants |
| `0021` | Snapshot templates for every specialist; shift-log and stock-count imports |
| `0022` | The derivation binding predicate in the book guard; as-of template parameters |
| `0023` | Second versions of nine templates |
| `0024` | Unique stock counts, supplier-quote provenance, a widened chunk check |
| `0025` | Investigation cost template v2; NOTIFY on investigations |
| `0026` | Model-role prices, the owner's negotiation target and walk-away, a deal-review template version |
| `0027` | A lowered ceiling downgrades a running Auto investigation to Plan |
| `0028` | Munim Cares: platform cities, recipients, enablement, network snapshots; core listings, claims, hand-overs; public reads |
| `0029` | Owner-entered display text and diet on menu rows |
| `0030` | Display order columns on menu rows |
| `0031` | `core.tick_claim`, so a scheduled job runs once per slot |
| `0032` | Command authority for a person's request for quotes |
| `0033` | Per-outlet versions of six forecast-reading templates |
| `0034` | Storefront page versions and publishes; command authority for recording a campaign as sent on a demo business |

## Tests

`pnpm -F @munim/db test` starts an embedded Postgres 18, applies the migrations (33 apply; `0013` is skipped there) and runs the
gates. The hand-written `tests/manifest.ts` lists every table and its properties, and the gates compare the live catalog to it
in both directions.

| Test | Proves |
|---|---|
| `grants.test.ts` | Role attributes; `munim_intel_ro` and `munim_svc` write grants; the definer list; append-only grants |
| `guard.test.ts` | The book guard's three branches and its refusals |
| `isolation.test.ts` | Forced row-level security, tenant and outlet isolation |
| `books.test.ts`, `finance.test.ts`, `orders.test.ts`, `loyalty.test.ts` | Country lock, currency, journal balance, order transitions, loyalty |
| `audit-notify.test.ts` | The audit hash chain and NOTIFY payloads |
| `intel.test.ts` | Claim quotes, simulated-only supplier quotes, trace rules |
| `migrate.test.ts` | The runner's behaviour |

Many tests are named `RED-PROOF: ...`: they plant a defect in a clone of the database and expect the gate to fail.

```ts
import { startTestDb } from "@munim/db";
const db = await startTestDb();   // see tests/db.ts and tests/world.ts for the helpers the gates use
```
