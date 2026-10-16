# Data model

The SQL in [`db/migrations/`](../db/migrations/) is the contract. This page is a map. Counts below come from the hand-written
migration manifest, [`db/tests/manifest.ts`](../db/tests/manifest.ts), which the tests compare to the live catalog in both
directions.

## Schemas

| Schema | Tables | Holds |
|---|---|---|
| `core` | 137 (105 book, 32 operational) | Everything the business owns and does: tenancy, catalogue, orders, kitchen, stock, purchasing, finance, people, customers, compliance, approvals, audit, outbox, imports, Munim Cares |
| `evidence` | 2 | `snapshot_template` (reviewed SQL) and `snapshot` (the rows a template returned, with a hash) |
| `intel` | 18 | What the AI layer produced: runs, findings, answers, traces, claims, entities, edges, forecasts, supplier quotes, spend |
| `platform` | 12 | Country packs, plans, feature flags, model roles, AI budgets, operators, config drafts, the platform audit, Cares cities, recipients, enablement and network snapshots |
| `intel_ro` | 11 views | Read-only projections of `intel` and a few `core` names, owned by a role that does not bypass row-level security |
| `munim_meta` | 1 | `schema_migrations`: each applied file with its SHA-256 |

Conventions that hold across tables:

- `tenant_id` is the first column of every key of a tenant table (except the globally unique hash of a storefront key) and of
  every foreign key that points at one, so a row can only reference its own tenant's rows.
- Ids are UUIDs: a command carries UUIDv7 ids its client generates, and core-api mints UUIDv7 for the rows it creates itself.
- Money is an integer in minor units plus a three-letter currency. A trigger on every currency column checks it against
  the tenant's currency (`MB003`).
- Time is `timestamptz`. Business dates are computed from the outlet's IANA zone and day cutoff by one tz module
  (`packages/core-domain/tz`).
- Every book row has an `origin` JSON value that records how it was admitted: `{kind: command, ...}`, `{kind: decision, ...}`
  or `{kind: derivation, ...}` (a row a migration backfilled carries `{kind: migration}`). `origin` is set when the row is
  created and never re-stamped.

## Roles and grants

`0001_roles_schemas.sql` creates seven roles and asserts their attributes at the end of the file.

| Role | Login | Purpose |
|---|---|---|
| `munim_migrator` | no | Owns every schema and object. Used only by migrations. |
| `munim_crosstenant` | no, `BYPASSRLS` | Owns the few objects that must cross tenants (`CROSSTENANT_OBJECTS` in the manifest). |
| `munim_view_owner` | no | Owns the `intel_ro` views; does not bypass row-level security, so the views obey base-table policies. |
| `munim_core` | yes | core-api's member, storefront and approval routes. Can write book tables (through the guard). |
| `munim_svc` | yes | core-api's internal routes and core-worker. Has **no** insert or update grant on any book table. |
| `munim_platform` | yes | The operator routes under `/platform/v1`. |
| `munim_intel_ro` | yes | Reads the `intel_ro` views only. Nothing connects as it today; the tests assert it can write nothing. |

No runtime role (`munim_core`, `munim_svc`, `munim_platform`, `munim_intel_ro`) is a superuser, creates databases or
roles, owns a table, or bypasses row-level security. Only the non-login `munim_crosstenant` bypasses it. Every table has an
explicit revoke-then-grant block. Default privileges and function `EXECUTE` are revoked from `PUBLIC`. No role has `DELETE`
or `TRUNCATE` on any table.

`munim_svc` may insert into a fixed list of operational and intel tables (`SVC_INSERT_TABLES` in the manifest), such as
`core.draft`, `core.outbox`, `evidence.snapshot` and the `intel.*` tables. That is how the AI layer's output reaches the
database, always through core-api's validators.

## Row-level security

Every table with a `tenant_id` has row-level security enabled and **forced**. A policy compares `tenant_id` with
`app.tenant_id`, which a transaction sets with `SET LOCAL`. With no context a query returns zero rows. 59 tables add an
outlet policy on `outlet_id`; child rows (for example settlement lines) are visible exactly when their parent is.
Customers and guests get restrictive extra policies (`customer_scope`, `guest_scope`): a shopper sees only their own
profile, orders and the rows reachable from those orders, plus public catalogue rows.

## Key tables

| Area | Tables |
|---|---|
| Tenancy | `tenant`, `outlet`, `brand`, `channel`, `member`, `membership` (roles `owner`, `manager`, `staff`, `advisor`, `judge`), `device`, `outlet_calendar`, `business_policy`, `storefront_key` (only a SHA-256 of the key is stored) |
| Catalogue | `item`, `variant`, `option_group`, `option`, `ingredient`, `recipe_version` (validity windows cannot overlap) and `recipe_line`, `price` (same), `deal`, `coupon`, `item_availability`, `prep_time`, `storefront_page_version`, `storefront_page_publish` |
| Orders and kitchen | `order`, `order_line`, `order_event`, `tender`, `void`, `refund`, `sale_return`, `shift`, `coupon_use`, `kitchen_ticket`, `pickup_window`, `order_status_transition` |
| Stock and buying | `supplier`, `supplier_price`, `batch`, `stock_movement`, `stock_count` and lines, `reorder_level`, `waste_log`, `purchase_order` and `po_line`, `goods_received` and `grn_line`, `supplier_invoice` and lines, `supplier_return`, `transfer`, `expired_sale_override`, `prep_list` |
| Finance | `account`, `journal_entry`, `posting`, `period_close`, `channel_terms`, `settlement`, `settlement_line`, `bank_line`, `dispute`, `reconciliation_break`, `budget`, `expense`, `payable`, `receivable`, `tax_return_draft` |
| People | `staff`, `roster`, `roster_shift`, `attendance`, `payroll_draft` and lines, `advance`, `tip_pool`, `training_record`, `hiring_candidate` |
| Customers | `customer`, `loyalty_entry`, `campaign`, `reservation`, `review`, `bulk_order` |
| Compliance, goals | `licence`, `checklist`, `checklist_run`, `asset`, `temp_log`, `amc`, `maintenance`, `goal`, `task`, `viability_case`, `market_signal` |
| Approvals and trail | `draft`, `decision`, `command_log`, `command_authority`, `derivation_rule`, `audit_log`, `outbox`, `ai_policy`, `ai_budget_cap`, `tick_claim` |
| AI work | `ai_thread`, `ai_thread_turn`, `investigation`, `investigation_step`, `investigation_grant`, `conversation`, `message`, `document`, `import_run`, `import_staging`, `import_quarantine`, `import_format` |
| Munim Cares | `cares_profile`, `cares_outlet`, `cares_listing` and lines, `cares_handover` and lines, `cares_claim` and lines, `cares_allocation`; `platform.cares_city`, `cares_recipient`, `cares_enablement`, `network_snapshot` |
| Intelligence | `intel.run`, `finding`, `answer`, `trace_event`, `claim`, `entity`, `alias`, `chunk`, `edge`, `wiki_page`, `wiki_version`, `forecast_run`, `forecast_point`, `supplier_quote`, `intel_spend`, `outcome`, `event_claim`, `watch_state` |

`order` statuses are `placed`, `accepted`, `rejected`, `preparing`, `ready`, `completed`, `cancelled`. The legal moves are
rows in `core.order_status_transition`, and a trigger refuses any other (`MB004`).

## Append-only books and the journal

- No role can delete. A correction is a reversal or a void with a reason and an actor. A journal entry reverses another
  through `reverses_id`, and an entry can be reversed once.
- `core.journal_entry` has at least two `core.posting` rows, each a signed `amount_minor` with a currency. A constraint
  trigger deferred to commit checks that every entry has two or more postings and that the postings sum to zero in every
  currency. Otherwise the commit fails with `MB010 books_unbalanced`.
- A posting must join an entry created in the same transaction, so a committed entry is immutable.
- A journal entry in a closed month is refused (`MB009 period_closed`). `core.period_close` is permanent in v1.
- Posting rules are deterministic derivations (`core.journal_entry.posting_rule` with its source row); only one entry may
  exist per source row and rule, besides its reversal.
- `core.audit_log` is a per-tenant chain: gapless `seq`, each row carrying `prev_hash` and `hash`. The tests append
  twenty entries concurrently, check the sequence is gapless and recompute every hash, then tamper with one entry and
  delete another to show the check fails.

## Commands and approvals

`core.command_authority` (`command_type`, `allowed_roles`, `scope`, `target_tables`) says who may issue each command type
and which book tables it may write. `core.command_log` stores each command by `(tenant_id, idempotency_key)` with a hash
of the request and the result. `core.draft` has the statuses `proposed`, `executing`, `rejected`, `stale`, `executed`
and `failed`. `core.decision` holds one verdict (`approved`, `edited`, `rejected`) per draft, with the final payload for an
approval. `core.outbox` holds CloudEvents; its `seq` is assigned per tenant under the commit lock, so a stream cursor never
misses a late commit.

## Evidence and intel

- `evidence.snapshot_template` holds 73 reviewed SQL templates in 108 versions (the manifest lists every `id` and `id@N`).
  Only migrations create them; core mints the latest version. A numeric output column must name its source: a `core`
  column, a `core` row count, or an allow-listed `intel` column, which stops a template from presenting an AI-written number
  as a ledger number.
- `evidence.snapshot` has exactly one minter (an intel run, a member, or an operator), at most 500 rows, and a SHA-256 of
  its rows.
- `intel.claim` stores a quote with its source and span; a trigger refuses a quote that is not that exact span of the
  source text (`MB012`).
- `intel.supplier_quote` can reference only a supplier of kind `simulated` (a composite foreign key), and `is_simulated =
  false` is a check failure.
- `intel.trace_event` has a gapless `seq` per run (`MB014`) and a check that every payload key is snake_case and every
  string is at most 200 characters.

## Database error codes

core-api maps these SQLSTATEs to fixed error codes. The database text is never returned.

| SQLSTATE | Meaning | API `code` |
|---|---|---|
| `MB001` | Book write refused | `book_write_refused` |
| `MB002` | Country, currency or financial year changed after onboarding | `country_locked` |
| `MB003` | Currency differs from the tenant's | `currency_mismatch` |
| `MB004` | Illegal status move (orders, drafts, purchase orders, transfers, import runs, investigations and others) | `illegal_transition` |
| `MB005` | Expired-sale override reused, or an actor column is not the signed-in member | `override_refused` |
| `MB006` | Decision not made by the signed-in approver with authority | `decision_refused` |
| `MB007` | Customer profile already erased | `customer_erased` |
| `MB008` | Command not bound to this table | `command_table_mismatch` |
| `MB009` | Period closed | `period_closed` |
| `MB010` | Journal entry does not balance | `books_unbalanced` |
| `MB011` | Not enough loyalty points | `loyalty_refused` |
| `MB012` | Quote is not the source span | `claim_quote_mismatch` |
| `MB013` | Not available in the country pack | `out_of_pack_scope` |
| `MB014` | Sequence gap (trace events, thread turns, investigation steps) | `sequence_gap` |
| `MB015` | Investigation, plan approval, step or standing grant not allowed | `investigation_refused` |

## Migrations

`db/migrate.ts` applies `db/migrations/NNNN_name.sql` in order, one transaction per file, from `0002` on under
`SET LOCAL ROLE munim_migrator`. It records each file's SHA-256 and refuses an applied file whose bytes changed, so
migrations are forward-only: a fix is a new file. A file with a `-- requires: vector` header (`0013_embeddings.sql`) is
skipped loudly where the extension is missing. There are 35 files; the embedded test database applies 34 and skips that
one. [`db/README.md`](../db/README.md) lists them.
