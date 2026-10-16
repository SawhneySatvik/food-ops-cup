# db: migrations, runner and test harness

The SQL in [`migrations/`](./migrations/) is the contract for Munim's database. Migrations are forward-only: an applied file is
never edited, and a fix is a new file. The data-model page in [`../docs/data-model.md`](../docs/data-model.md) is a map of
the result.

## What is here

| Path | What it is |
|---|---|
| `migrations/` | 35 numbered SQL files, `0001` to `0035` |
| `migrate.ts` | The runner. Applies files in order, one transaction each, from `0002` on under `SET LOCAL ROLE munim_migrator`. Records each file's SHA-256 in `munim_meta.schema_migrations` and refuses an applied file whose bytes changed. A `-- requires: vector` header skips a file loudly where the extension is missing. |
| `seeds/packs.ts` | Seeds `platform.country_pack` from `packages/contracts/packs/*.json`. Idempotent; a changed document for a published version is refused. |
| `scripts/bootstrap-roles.ts` | Sets a fresh random password on each login role and writes `.run/db-roles.json` (mode 0600). Re-running rotates every password. |
| `derivation-rules.json` | A hand-written list of every `core.derivation_rule` row the migrations seed; a test asserts the database equals it |
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

## Errors the database raises

Book-guard and integrity triggers raise these SQLSTATEs; core-api maps each to one API error code
(`services/core-api/src/lib/errors.ts`, tested in `services/core-api/test/envelope.test.ts`).

| Code | Name | Raised by |
|---|---|---|
| `MB001` | `book_write_refused` | `core.guard_book_write()` on every book table |
| `MB002` | `country_locked` | change of country/currency/FY start/onboarded_at after onboarding |
| `MB003` | `currency_mismatch` | any currency column ≠ tenant base currency |
| `MB004` | `illegal_transition` | order, draft, purchase order, transfer status; forged `exec_txid` |
| `MB005` | `override_refused` | expired-sale override reused, or `decided_by` ≠ signed-in member; a Cares actor column (`published_by`, `recorded_by`, `voided_by`, `created_by`, `decided_by`) ≠ signed-in member (0028) |
| `MB006` | `decision_refused` | `core.decision.decided_by` ≠ `app.member_id`, or `app.role` not allowed for the draft's command type |
| `MB007` | `customer_erased` | `erased_at` set outside `customers.erasure.request.v1`, or any change to an erased profile |
| `MB008` | `command_table_mismatch` | the command (own command, or the approved draft's command type) does not list the table in `core.command_authority.target_tables`, and no later branch admits the row |
| `MB009` | `period_closed` | a journal entry dated in a closed month (`core.period_close`, outlet or tenant-wide) |
| `MB010` | `books_unbalanced` | at COMMIT: an entry with < 2 postings or Σ ≠ 0 in a currency, or not visible in the committing context; a posting added outside its entry's transaction |
| `MB011` | `loyalty_refused` | a loyalty entry that would take the balance below 0 (under the customer's row lock); a `reverse` entry that does not undo an entry of the same customer and order with the opposite sign and at most its points (0016) |
| `MB012` | `claim_quote_mismatch` | `intel.claim.quote` ≠ the source chunk/message text at `[span_start, span_end)` |
| `MB013` | `out_of_pack_scope` | a payroll draft where the pack's `payroll_scope` ≠ `drafts`; a licence kind not in the pack's `licence_kinds` |
| `MB014` | `sequence_gap` | an `intel.trace_event` seq that is not the run's last seq + 1; since 0020 also a `core.ai_thread_turn.turn_no` / `core.investigation_step.step_no` that is not the next one |
| `MB015` | `investigation_refused` | (0020) an investigation not created by the signed-in member; a plan approved twice or by someone else; a step whose trigger is not who it claims (member / plan / auto — below); a standing grant not the creator's own for the investigation's scope, or revoked twice / by someone else; an `auto_step` run without a live grant of its actor covering its scope |

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
| `0021` | Snapshot templates for the remaining specialist packs (44); shift-log and stock-count imports and the count-adjust derivation |
| `0022` | The derivation binding predicate in the book guard; as-of template parameters |
| `0023` | Second versions of nine templates |
| `0024` | Unique stock counts, agent cards on simulated suppliers only, supplier-quote provenance, a widened chunk check, settlement-vs-orders template v3 |
| `0025` | Investigation cost template v2; NOTIFY on investigations |
| `0026` | Model-role prices, the owner's negotiation target and walk-away, new versions of the labour-vs-demand and deal-inputs templates |
| `0027` | A lowered ceiling downgrades a running Auto investigation to Plan |
| `0028` | Munim Cares: platform cities, recipients, enablement, network snapshots; core profiles, listings, hand-overs, claims, allocations; five cross-tenant read functions; five templates |
| `0029` | Owner-entered display text and diet on menu rows; the outlet's phone |
| `0030` | Display order columns on menu rows |
| `0031` | `core.tick_claim`, so a job run through core-api's tick route runs once per slot |
| `0032` | Command authority for a person's request for quotes |
| `0033` | Per-outlet versions of six forecast-reading templates |
| `0034` | Storefront page versions and publishes and their two commands; command authority for recording a campaign as sent on a demo business |
| `0035` | Version 2 of the consented-audience template: a general "Send me offers" counts as email consent only; a channel's own flag wins; non-boolean values never count |

## Tests

`pnpm -F @munim/db test` starts an embedded Postgres 18, applies the migrations (34 apply; `0013` is skipped there) and runs the
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
