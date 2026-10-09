# @munim/db — migrations, runner, test harness (migrator lane m-1)

Only the migrator lane writes under `db/**`. **The SQL in `migrations/` is the contract**; `docs/plan/02-schema.md`
is commentary. Never edit an applied migration — fix forward in a new file.

## Run

```bash
pnpm -F @munim/db test        # every DB gate on embedded Postgres 18 (no Docker, no .env, no network)
pnpm -F @munim/db typecheck
node db/tests/static-gate.ts  # host-specific construct scan: prints "N files scanned, M forbidden constructs"
pnpm -F @munim/db migrate     # applies to $DEVHOST_SESSION_POOLER_CONNECTION_STRING (export it yourself;
pnpm -F @munim/db seed:packs  #   these scripts never read .env — project rule 20)
node db/scripts/bootstrap-roles.ts [--out <path>]   # sets fresh LOGIN passwords for the 4 runtime roles on
                              #   $DEVHOST_SESSION_POOLER_CONNECTION_STRING and writes .run/db-roles.json (0600)
```

**Migrations (14 files).** 0001–0006 M-A (frozen). 0007 W1 riders (command→table binding, storefront keys and
the two cross-tenant lookups, outbox seq, guest order hash, outlet VPA fix, `munim_meta.assert_catalog()`),
0008 finance, 0009 documents/imports/conversations, 0010 people, 0011 customers & growth, 0012 compliance, goals,
market, intel tables, `intel_ro` views, `platform.llm_budget_spent`, 0013 embeddings (`-- requires: vector`:
skipped loudly on embedded PG), 0014 W1 fix cycle 1 (guard scope/customer/pricing rules, customer RLS, run scope,
derivation source states, status transitions, riders #17–#62) — gates see 13 applied. Every migration from 0007 ends with
`PERFORM munim_meta.assert_catalog('<n>')` (tags, guard + origin on books, guard fires first, binding lists name
book tables and no book table is unwritable, forced RLS, FK covering indexes, no cascades, no PUBLIC/DELETE
grants, definer objects, intel_ro ownership).

## Runner (`migrate.ts`)

- Files `NNNN_name.sql`, contiguous from 0001. One transaction per file; recorded in
  `munim_meta.schema_migrations (version, name, sha256, applied_at)`.
- An applied file whose sha256 changed → refused. A missing applied file → refused.
- `-- requires: <extension>` → when the server lacks it, the file is **skipped loudly and not recorded**
  (later files still apply; the skipped one applies on a server that has the extension).
- From 0002 on each file runs under `SET LOCAL ROLE munim_migrator`, so every object is owned by it. 0001 runs
  as the connecting admin (it creates the roles).

## Test harness (`@munim/db` → `startTestDb()`)

`startTestDb()` starts a private embedded cluster on a free port (data dir under the OS temp dir,
`max_connections=250`), applies all migrations, seeds the packs, sets test-only passwords on the four login
roles and returns:

| Helper | Does |
|---|---|
| `connect(role)` | a client **logged in as** `munim_core` / `munim_svc` / `munim_platform` / `munim_intel_ro`, or `"admin"` |
| `pool(role, max)` | a pg Pool logged in as that role |
| `withContext(role, ctx, fn)` | `BEGIN` → `set_config('app.<k>', v, true)` (= `SET LOCAL`) for each ctx key → `fn` → `COMMIT` (rollback on throw) |
| `admin(sql, params)` | one statement as the superuser (fixtures, red-proof mutations) |
| `clone()` | a fresh database copied from this one (`CREATE DATABASE … TEMPLATE`) |
| `stop()` | stops the cluster and deletes its data dir (a clone's `stop()` drops just the clone) |

`setContext(client, ctx)` / `inContext(client, ctx, fn)` do the same on a client you hold. In this package's
vitest run, `tests/global-setup.ts` starts one cluster and each test file works on its own clone (`tests/db.ts`).

**Stale comments in frozen files (#27).** 0001 says pgvector "arrives with 0012", 0002/0003 say intel_spend /
intel.finding arrive "0011", 0005 says core.document arrives "M-B 0008", 0006 says the finding FK is "0011". The files
are frozen; the actual numbers are 0013 (vector), 0012 (intel tables, finding FK), 0009 (documents).

**Exit codes.** `embedded-postgres` registers `async-exit-hook` when its module loads; its `beforeExit` handler
calls `process.exit(0)` (a failing vitest run exited 0 — T-004) and its `exit` handler throws. The harness loads
the module only inside `startTestDb()` and removes those two listeners (signal handlers stay). Importing
`@munim/db` no longer loads `embedded-postgres` at all. Red-proven: a planted failing test makes `make test-db`
and `make test` exit non-zero.

**Canonical world (`buildWorld(db, { country: "IN" | "AU" })`, exported from `@munim/db`).** One synthetic tenant
with a row in every tenant table: 3 outlets (outlet-scoped rows in outlets 1–2), owner + staff members, devices,
brand, channel, customer, items/variants/options, recipe, price, deal, coupon, simulated supplier, PO → GRN →
stock, orders with tenders/voids/refunds, finance (chart, terms, a balanced entry, a closed September, settlement,
bank line, dispute…), people, loyalty, compliance, documents/imports, intel rows, and two approved drafts. Every
book write runs under the command type whose `target_tables` list that table (the guard enforces it — see
below); payroll rows only for IN. `ownerCtx(world, extra)` builds an owner context; `approveDraft(db, world,
commandType, fn)` runs `fn` inside a real approval transaction (draft executing in this txid + decision +
`app.decision_id`). Lanes should build fixtures with it instead of hand-seeding book tables.

## Contract for other lanes

**Context keys (`SET LOCAL app.*`, 03-architecture §1.4).** `tenant_id`, `outlet_ids` (`'{*}'` or
`'{uuid,…}'`), `role`, `member_id`, `command_type`, `decision_id`, `posting_rule`, `source_ref`
(`'core.<table>:<uuid>'`), plus two this migration set adds: **`customer_id`** (principal when
`role = 'customer'`) and **`operator_id`** (principal when `role = 'operator'`). Policies read settings through
`nullif(current_setting(k, true), '')`: after a `SET LOCAL` transaction ends, the setting reads `''` (not NULL)
on that pooled connection, and the literal `::uuid` cast in 02-schema §0 would raise. `core.customer` adds an
own-row rule (R41): with `app.role = 'customer'` only the row `id = app.customer_id` is visible/writable.

**SQLSTATEs.**

| Code | Name | Raised by |
|---|---|---|
| `MB001` | `book_write_refused` | `core.guard_book_write()` on every book table |
| `MB002` | `country_locked` | change of country/currency/FY start/onboarded_at after onboarding (R30) |
| `MB003` | `currency_mismatch` | any currency column ≠ tenant base currency (R30) |
| `MB004` | `illegal_transition` | order, draft, purchase order, transfer status; forged `exec_txid` |
| `MB005` | `override_refused` | expired-sale override reused, or `decided_by` ≠ signed-in member (R40 C7) |
| `MB006` | `decision_refused` | `core.decision.decided_by` ≠ `app.member_id`, or `app.role` not allowed for the draft's command type |
| `MB007` | `customer_erased` | `erased_at` set outside `customers.erasure.request.v1`, or any change to an erased profile (R41) |
| `MB008` | `command_table_mismatch` | the command (own command, or the approved draft's command type) does not list the table in `core.command_authority.target_tables`, and no later branch admits the row |
| `MB009` | `period_closed` | a journal entry dated in a closed month (`core.period_close`, outlet or tenant-wide) |
| `MB010` | `books_unbalanced` | at COMMIT: an entry with < 2 postings or Σ ≠ 0 in a currency, or not visible in the committing context; a posting added outside its entry's transaction |
| `MB011` | `loyalty_refused` | a loyalty entry that would take the balance below 0 (under the customer's row lock) |
| `MB012` | `claim_quote_mismatch` | `intel.claim.quote` ≠ the source chunk/message text at `[span_start, span_end)` |
| `MB013` | `out_of_pack_scope` | a payroll draft where the pack's `payroll_scope` ≠ `drafts`; a licence kind not in the pack's `licence_kinds` |
| `MB014` | `sequence_gap` | an `intel.trace_event` seq that is not the run's last seq + 1 |

**Book guard.** A write to a `munim:book` table is admitted, in this order, by: (2) `app.decision_id` → an
`approved`/`edited` decision whose draft is `executing` with `exec_txid = txid_current()`; (3)
`app.posting_rule` + `app.source_ref` matching a `core.derivation_rule` row whose source row exists; (1)
`app.role` + its principal id + `app.command_type` listed in `core.command_authority`, `'{*}'` scope for
`tenant`-scoped commands, and the row's `outlet_id` (if any) inside `app.outlet_ids`. `origin` is stamped
`{kind: decision|derivation|command, …}`. No role bypasses it, the superuser included.
Since 0014 (W1 fix cycle 1), on top of the 0007 binding:
- **Outlet scope (F1).** `core.book_scope` says how each book row reaches its outlets (own `outlet_id`, own id for
  `core.outlet`, an `outlet_ids` set, both ends of a transfer, or a parent row such as a PO line's PO). The row —
  NEW and, on UPDATE, OLD — must lie inside `app.outlet_ids` in the own-command **and** decision branches; a
  tenant-wide row (outlet NULL or an empty set) needs `'{*}'`; tenant-level records (customer, item, supplier…)
  follow the command's scope (`tenant` needs `'{*}'`); an invisible parent never passes.
- **Customers (F2).** With `app.role = 'customer'`: never under `'{*}'`; only tables in
  `command_authority.customer_target_tables`; NEW must be the customer's own (`app.customer_id`), OLD the customer's
  own or a guest order whose `guest_access_hash` = `decode(app.guest_access_hash, 'hex')` (how
  `customers.account.link.v1` claims a guest order). Tenders are never customer writes.
- **Origin (F3).** Stamped on INSERT; an UPDATE keeps it unless a derivation rule admits it. `core."order"` money
  columns change only under `app.posting_rule = 'orders.reprice'` + `app.source_ref = 'core.order:<id>'`.
- **Derivation source state (#21).** `core.derivation_rule.source_state` must hold for the source row (e.g. invoice
  `approved`, order `completed`, settlement's import `committed`). The full list is `db/derivation-rules.json`
  (exported as `@munim/db/derivation-rules.json`; the gate asserts DB = file).
- **Status columns (#23).** Every book `status`/`stage` column moves only along `core.book_status_transition`
  (order, PO, transfer keep their own triggers); MB004 otherwise.

Since 0007 branches (2) and (1) also require the table (`schema.table`) to be in `core.command_authority.target_tables`
of the command — the draft's command type for (2) — else MB008. `core.campaign` additionally requires
`origin.kind = 'decision'` (campaigns exist only through an approved draft). The full command list with bindings:
`SELECT command_type, allowed_roles, scope, target_tables FROM core.command_authority ORDER BY 1`. M-B command
names not yet in `packages/contracts` are INFERENCE — module lanes adopt them or request a rename.

**Approval transaction (T-008).** `UPDATE core.draft SET status='executing', exec_txid=txid_current() WHERE …
AND status='proposed'` → `INSERT core.decision` (as the approver: `app.role`, `app.member_id`) →
`set_config('app.decision_id', …, true)` → the command's book writes → `UPDATE … status='executed'`, one
transaction.

**Numbers assigned by the database.** `core.order`: `business_date` (outlet tz), `ticket_no` (per outlet per
business date), `invoice_fy` + `invoice_no` (gapless per device per FY, only when `device_id` is set). Supplied
values are overwritten.

**Audit chain.** `core.audit_log` (per tenant) and `platform.platform_audit` (global): the trigger sets `seq`
(gapless, under a transaction advisory lock), `prev_hash` (64 zeros for the first), `created_at`, and
`hash = sha256_hex(utf8(join("\n", [prev_hash, tenant_id, seq, actor::text, action, entity, entity_id,
before::text|'null', after::text|'null', decision_id|'null', created_at as UTC 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'])))`
(`platform_audit` omits `tenant_id` and uses `config_draft_id` for `decision_id`). Verify by selecting those
column texts and recomputing — `tests/audit-notify.test.ts` does it in TypeScript.

**NOTIFY.** `munim_outbox` on outbox insert, `munim_inbox` on draft and `intel.finding` insert/update; payload
`'<tenant_id>:<id>'`. `munim_trace` on `intel.trace_event` insert, payload `'<tenant_id>:<run_id>:<seq>'`. Ids only;
delivered at commit.

**Outbox seq (T-006).** `core.outbox.seq` is per tenant and commit-ordered: the insert trigger takes the same
per-tenant transaction lock as the audit chain (held to commit) and sets `max + 1` (supplied values overwritten).
Replay indexes: `core.outbox (tenant_id, created_at, id)`, `core.draft (tenant_id, updated_at, id)`,
`intel.finding (tenant_id, updated_at, id)`.

**Cross-tenant lookups (munim_crosstenant, SECURITY DEFINER, EXECUTE `munim_core` only).**
`core.tenant_for_storefront_key(key_hash text) → (tenant_id, channel_id)` for an unrevoked key of an active tenant
(store only `sha256(key)` hex in `core.storefront_key`; a miss returns 0 rows — answer 404, gotcha 16).
`core.memberships_for_sub(sub text) → (tenant_id, tenant_name, role)` for active memberships. Definer objects: 5.

**Guest orders.** `core."order".guest_access_hash` = sha256 (32 bytes) of a random token returned once at placement.

**Customer requests (F4, 0014) — core-api must follow this.** Every tenant table carries a RESTRICTIVE
`customer_scope` policy: with `app.role = 'customer'` a context sees its own customer row, orders (own, or by
`app.guest_access_hash`), loyalty, reservations, bulk orders and those orders' lines/events/tenders/refunds/voids/
returns/tickets — whatever the outlet; reads (never writes) the public catalogue (tenant, outlet, brand, channel, item, variant, options,
price, deal, availability, calendar, prep time, recipe version); reads only the coupons named in
`app.coupon_codes = '{CODE,…}'`; writes the placement counters (`ticket_counter`, `pickup_window`); and sees nothing
else — journal, members, audit, outbox, command log, drafts, findings, snapshots, intel included. So inside a
customer request core-api writes `command_log`, `audit_log`, `outbox` and any derived rows (consumption, postings,
loyalty earn) only after `set_config('app.role', '', true)` (or a member role for the cashier); shoppers carry
`app.outlet_ids = '{}'`, never `'{*}'`.

**Shoppers (0014 ruling) — context keys for `contextOf`.**
- *Signed-in customer:* `app.tenant_id`, `app.role = 'customer'`, `app.customer_id`, `app.outlet_ids = '{}'`, plus
  `app.command_type` for writes; `app.coupon_codes = '{CODE,…}'` when codes are presented; `app.guest_access_hash`
  only when claiming a guest order (`customers.account.link.v1`).
- *Guest (token holder):* `app.tenant_id`, `app.role = 'guest'`, `app.guest_access_hash = hex(sha256(token))`,
  `app.outlet_ids = '{}'`; no `app.customer_id`. A RESTRICTIVE `guest_scope` policy on every tenant table shows only
  the one order with that hash and its `order_line`, `order_event`, `tender`, `kitchen_ticket` rows — never the
  customer row, never the same customer's other orders, not the catalogue — and refuses every write (`guest` is in no
  `command_authority` row either). Index: `core."order" (tenant_id, guest_access_hash) WHERE … IS NOT NULL`.
- Shoppers do not depend on outlet scope: every `tenant_outlet_isolation` policy admits `app.role IN ('customer',
  'guest')`, and the restrictive `customer_scope` / `guest_scope` policies decide what they see; the guard checks a
  customer's ownership, not outlets, and refuses a customer under `'{*}'`. Which outlet a storefront order belongs to
  is core-api's (the storefront key's channel/outlet).

**Outbox delivery (0014 rider).** `core.outbox.publish_attempts` (≥ 0) and `dead_at` (only while unpublished);
`munim_svc` may UPDATE exactly those two plus `published_at`. `core.outbox_claim()` never returns a row with `dead_at`.

**Invoice series (0014 ruling).** An order on an `aggregator:<code>` channel whose country-pack aggregator entry has
`tax_treatment = 'operator_collects_excluded'` (IN Swiggy/Zomato, Sec 9(5)) gets no `invoice_no`/`invoice_fy`, even on
a device; it keeps `ticket_no` and `external_ref`. The per-device series stays gapless for every other order.

**Runs and traces (#37).** `intel.run` is visible only when `app.outlet_ids` covers the run's `outlet_scope`; a
`'{*}'` run only to `owner`/`advisor`/`judge` (a judge owns its demo tenant) or a service context (no `app.role`)
holding `'{*}'`.
`intel.trace_event` is visible exactly when its run is.

**Imports (#22).** `import_run`: created `parsing` → `previewed` | `failed` → (`previewed`) `committed` | `rejected`;
counters, control total, currency and draft are fixed once previewed; `committed` only inside the run's approved
`imports.run.commit.v1` draft; staging/quarantine rows only while parsing. `market_signal` rows only inside that
approved draft (MB006). `reconciliation_break` and `viability_case` are books (0014).

**Expired-sale override (#49).** Issued before placement with `cart_line_id` (the order line id the client will
place), `order_line_id` and `used_at` NULL; placement (`orders.place.v1`) inserts that line and sets `used_at` and
`order_line_id = cart_line_id` once.

**Rider columns (0014).** `tender.rounding_minor` (cash only, signed); `outlet.business_day_cutoff` (default 04:00;
`business_date` = local date of now − cutoff, ticket numbers roll with it); `tenant.home_tz` (NULL = the first
outlet's zone by `created_at, id`); `draft.failure_reason` (reason code, only with status `failed`).

**intel / intel_ro (R25).** `munim_svc` inserts every `intel.*` table (core-api internal routes); `munim_intel_ro`
reads only the `intel_ro` views (owned by `munim_view_owner`, NOBYPASSRLS) and must set `app.tenant_id` and
`app.outlet_ids` from the verified run token — `finding_recent` uses the draft-style outlet overlap. Supplier quotes
reference `core.supplier (tenant_id, id, kind)` with `supplier_kind = 'simulated'`. `platform.llm_budget_spent` is a
`security_invoker` view: tenant contexts see their budget, `munim_platform` every tenant's.

**Sweeper.** `core.outbox_claim(batch_size int, min_age interval = '30 s', lease interval = '2 min')`
(SECURITY DEFINER, owner `munim_crosstenant`, EXECUTE `munim_svc` only) leases and returns unpublished rows;
mark `published_at` per row under that row's `app.tenant_id`. `core.active_tenants()` returns tenant ids.

**Snapshots (R40 C4/C5).** Exactly one of `run_id` / `minted_by_member_id` / `minted_by_operator_id`;
`munim_core` and `munim_svc` may insert. Template `columns` entries carry `numeric_source` =
`core.<table>.<column>`, `count:core.<table>`, or an entry of the column-level intel allow-list
(`tests/manifest.ts` `INTEL_NUMERIC_ALLOW`: forecast qty/lo/hi, quote price/qty/min order/payment days/round, spend
amount, `count:intel.answer`, `count:intel.outcome` — never `finding.confidence_bp`); `min_role` gates who opens it.

**Books invariants added in M-B.** Journal entries balance per currency at COMMIT (deferred constraint
triggers), are immutable (no UPDATE grant; postings only in the entry's transaction; one reversal each) and
cannot be dated in a closed period (entry and close serialise on a per-tenant-month advisory lock). The same source
posts once per rule. Loyalty balances never go below zero (customer row lock). Import format mappings are
`[{source, target, unit?}]` strings only (CHECK) and exist only through an approved draft (MB006).

## Embedded-PG vs hosted the dev host — UNVERIFIED, with fallbacks

Gates run on embedded PostgreSQL 18.4. None of the following has been run on the founder's hosted project:

1. **`ALTER ROLE munim_crosstenant BYPASSRLS`** from the hosted `postgres` role (not a true superuser;
   PG16+ lets a CREATEROLE role grant only attributes it holds). *Fallback:* create the role once in the
   dashboard SQL editor as `db_admin`-equivalent, or replace the two definer functions with
   per-tenant loops that set `app.tenant_id` (the sweeper would then need the tenant list from a
   non-RLS registry).
2. **`GRANT munim_migrator TO CURRENT_USER`** and `SET LOCAL ROLE munim_migrator` from `postgres`.
   *Fallback:* run 0002+ without the role switch and `REASSIGN OWNED` afterwards.
3. **`ALTER DEFAULT PRIVILEGES FOR ROLE munim_migrator`** (needs membership — granted in 0001).
4. **`btree_gist`** (exclusion constraints on `recipe_version`, `price`, `prep_time`): listed as available
   on the dev host and Cloud SQL, not probed. *Fallback:* a trigger that takes `pg_advisory_xact_lock` on the key
   and refuses an overlap.
5. **`pgcrypto`**: on the dev host it already lives in schema `extensions`; `CREATE EXTENSION IF NOT EXISTS` is a
   no-op there. Nothing calls pgcrypto (hashing uses built-in `sha256()`), so its schema does not matter.
6. **Server version**: no PG17/18-only syntax is used (no `uuidv7()`, `WITHOUT OVERLAPS`, virtual generated
   columns, `NULLS NOT DISTINCT`); `GRANT … WITH INHERIT/SET` is avoided for PG15.
7. **Pooler**: migrations need the session pooler (one transaction per file plus `SET LOCAL ROLE`).
8. **pgvector (0013)**: never applied anywhere yet. It runs `CREATE EXTENSION IF NOT EXISTS vector` as
   `munim_migrator`, which only succeeds if the extension is already installed (pgvector is not trusted) —
   *fallback:* enable it once in the dashboard first. `vector(768)` resolves through the session search_path
   (the dev host installs it in `extensions`; the static gate forbids naming that schema). The HNSW index cannot lead
   with tenant_id.
9. **`security_invoker` views** (`platform.llm_budget_spent`) need PG15+.
