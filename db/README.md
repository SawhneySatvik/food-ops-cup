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

**Migrations (19 files).** 0001–0006 M-A (frozen). 0007 W1 riders (command→table binding, storefront keys and
the two cross-tenant lookups, outbox seq, guest order hash, outlet VPA fix, `munim_meta.assert_catalog()`),
0008 finance, 0009 documents/imports/conversations, 0010 people, 0011 customers & growth, 0012 compliance, goals,
market, intel tables, `intel_ro` views, `platform.llm_budget_spent`, 0013 embeddings (`-- requires: vector`:
skipped loudly on embedded PG), 0014 W1 fix cycle 1 (guard scope/customer/pricing rules, customer RLS, run scope,
derivation source states, status transitions, riders #17–#62), 0015 W2 fix Batch A (draft-only commands, settlement
needs a committed run, outlet RLS on compliance/goal tables, W2 command rows, refund caps per role, W2 derivations,
POS-export imports, order-line pricing freeze, loyalty policy, verified-email merge, model-role defaults), 0016 W2 fix
cycle 1 (order_event.seq, loyalty reversal by refund, redemption posting rule, reconcile rules need a committed run,
pricing freezes read the reprice source state, guest hash cleared on claim, merge moves coupon uses, erasure of merged
guests, unit cost per 1000 base units, D1 policy backfill, D2 dispute moves the payable), 0017 W2 fix cycle 2 (origin
never re-stamped, re-approval re-opens the payable, the guest-token claim merges an emptied guest profile, coupon discount
follows a re-price), 0018 history imports (R44 b, c: the `pos_bills` / `waste_log` kinds, what an approved import writes,
`core.write_derived`), 0019 M-C1a (outlet RLS on the outlet-data tables, the advisor rung, `numeric_source` lists, the
fourteen catalogue/finance templates) — gates see 18 applied.
Every migration from 0007 ends with
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
stock, orders with tenders/voids/refunds, finance (chart, terms, a balanced entry, a closed March 2025 at outlet 1, settlement,
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
| `MB011` | `loyalty_refused` | a loyalty entry that would take the balance below 0 (under the customer's row lock); a `reverse` entry that does not undo an entry of the same customer and order with the opposite sign and at most its points (0016) |
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
- **Origin (F3, 0017).** `origin` is **creation** provenance: stamped on INSERT and **never re-stamped by an UPDATE, in
  any branch** — own command, decision or derivation (0014–0016 re-stamped it under a derivation; 0017 O1 removed that).
  Every later change traces through `core.audit_log` only (project gotcha 34). `core."order"` money columns change only
  under `app.posting_rule = 'orders.reprice'` + `app.source_ref = 'core.order:<id>'`.
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

Since 0015 (W2 fix, Batch A), `core.command_authority` carries three more columns:
- **`draft_only`** (A1). The own-command branch (1) refuses a draft-only command with MB001 (`… is draft-only`), on
  INSERT and UPDATE alike; branch (2) — its approved draft — is unaffected. Draft-only: `customers.campaign.create.v1`,
  `imports.run.commit.v1`, `imports.format.approve.v1`, `finance.journal.adjust.v1`. `allowed_roles` of a draft-only
  command lists who may *approve* its draft (`core.decision_named_person`).
- **`role_caps`** (A5, W2-R3): `{role: max_amount_minor}`; a role absent from the map is uncapped. Seeded:
  `orders.refund.record.v1` = staff 50000, manager 500000 (INFERENCE amounts; owner and judge uncapped). Read by
  core-api's `evaluateAuthority`; the database does not enforce amounts. Keys must be roles the command allows
  (`assert_catalog`).
- **`outlet_column`** (A6): when set, branch (1) checks the row's (NEW and OLD) value of that column against
  `app.outlet_ids` instead of `core.book_scope`. `inventory.transfer.receive.v1` = `to_outlet_id`: a transfer is
  received under the destination outlet's scope (a source-only manager → MB001).

0015 command rows (A4): `tenancy.onboard.v1` (owner, tenant, = `tenancy.provision.v1`'s tables), `tenancy.member.bind.v1`
(every member role, outlet, `core.member`), `tenancy.member.role.set.v1` / `tenancy.member.deactivate.v1` (owner,
tenant), `purchasing.grn.receive.v1`, `storefront.order.cancel.v1` / `.reschedule.v1` (customer, own_order),
`orders.order.advance.v1` / `.accept.v1` / `.reject.v1`, `people.payroll_draft.status.v1` (owner). The core-api test
shims that inserted these rows (storefront, purchasing) now collide with them — C1 removes the shims.

**Journal re-post after a reversal (0015).** `journal_entry_one_per_source_rule` (0008) still allows one unreversed
entry per (rule, source). A source reversed by `finance.reverse_supplier_invoice` (invoice disputed/void) or
`finance.reverse_payroll` (payroll void) and later re-approved re-posts as **the reversal of the reversal**
(`reverses_id` = the reversal entry, `posting_rule` = the original rule) — neither unique index blocks it; a plain
second post (no `reverses_id`) is still 23505.

**W2 fix cycle 1 (0016) — shapes other lanes code against.**
- **`core.order_event.seq`** (bigint NOT NULL, ≥ 1): per order, gapless from 1, set by the insert trigger under a
  per-order transaction lock (supplied values overwritten; no UPDATE grant). Unique `(tenant_id, order_id, seq)`.
  Order an order's history by `seq`, never by `at`. Rows before 0016 were numbered by `(at, id)`.
- **Loyalty reversal (`customers.loyalty_reverse`).** Cancel path: source `core.order:<id>`, state `cancelled` /
  `rejected`, `refund_id` NULL, `order_id` = that order. Refund path: source **`core.refund:<id>`**, state = the
  refund's order is `completed`, the row carries **`loyalty_entry.refund_id`** = that refund (composite FK
  `(tenant_id, order_id, refund_id)` → `core.refund`, so the refund is of the entry's order); **one entry per refund**
  (unique `(tenant_id, refund_id)`). Every `reverse` entry undoes an entry of the same customer and order, opposite sign,
  at most its points (MB011); 0011's one-reversal-per-entry unique is unchanged, so an earn is reversed by at most one
  refund (a second partial refund cannot reverse the same earn again).
- **`finance.post_loyalty_redemption`** (source `core.order`, targets `journal_entry` + `posting`): the order is
  `completed` and has an unreversed `redeem` entry. Account **4100 "Loyalty redemptions" (income, contra-revenue)**:
  Dr 4100 / Cr 1110 by the redeemed value. 0016 adds 4100 to every existing tenant that has a chart.
- **Reconcile rules.** `finance.reconcile_settlement` / `finance.reconcile_bank` need `import_run_id` set and that run
  `committed` (as `finance.post_settlement` since 0015).
- **Pricing freezes.** `core."order"` and `core.order_line` money changes need `app.posting_rule = 'orders.reprice'`,
  `app.source_ref = 'core.order:<id>'` **and** the order in that rule's `source_state` (placed / accepted), whichever
  guard branch admitted the write.
- **D2.** `purchasing.invoice.dispute.v1` lists `core.payable` (open → disputed). Not narrowed: the dispute command may make
  any payable change `book_status_transition` allows (see 0017 P1 for the narrowed approve side).
- **Unit cost per 1000 base units (R2-S2-8).** `core.stock_movement` and `core.supplier_return_line` carry
  **`unit_cost_per_1000_minor`** = the cost of 1000 units of the row's `unit`, in minor units (₹410.01/kg → 41001 per
  1000 g). Value = round(`qty_milli` × `unit_cost_per_1000_minor` / 1 000 000). Write it instead of a per-unit
  `mulDiv(cost, 1, factor)`: for a purchase unit of `factor` base units, `unit_cost_per_1000_minor =
  round(cost_per_purchase_unit × 1000 / factor)` (exact for kg→g, L→ml). `unit_cost_minor` stays for old readers: the
  insert trigger fills whichever of the two is missing (per-1000 = minor × 1000; minor = round half up of per-1000 /
  1000); supplying both requires that relation (CHECK). `core.grn_line.unit_cost_minor` is unchanged (per purchase unit).
- **Erasure (R1-M1).** `reservation.name` and `bulk_order.contact_name` stay NOT NULL (`<> ''`): erasure writes the fixed
  redaction literal `'[erased]'` there (no schema change, no contract change) and NULLs `phone`/`contact_phone` and `note`; `order_line.note` → NULL. Guest profiles merged
  into the erased profile: `core.customer_erase_merged_guests(id)` (below).
- **D1 and other backfills.** Run per existing tenant with the book guard disabled for that transaction only; inserted
  rows (`business_policy`, account 4100) carry `origin = {"kind": "migration", "migration": "0016_w2_fix_cycle_1"}`,
  `created_by` NULL and one `core.audit_log` entry each (`actor = {"kind": "migration", "id": "0016_w2_fix_cycle_1"}`,
  action `db.migration.backfill`). The D1 policy is tenant-wide with the column defaults, valid from the earlier of the
  tenant's creation date and its first order's business date (tenant zone) — INFERENCE.

**W2 fix cycle 2 (0017) — shapes other lanes code against.**
- **O1 — origin never re-stamped.** The guard's derivation branch keeps `OLD.origin` on UPDATE (re-issued; nothing else in
  the guard changed). A re-price, merge or erasure leaves every row's creation origin as it was; audit those changes.
- **P1 — re-approval re-opens the payable.** `purchasing.invoice.approve.v1` lists `core.payable`. Trigger
  `core.payable.under_invoice_approve` narrows it: under that command (own, or the command type of the approved draft
  executing in this transaction) a payable may only be inserted by `purchasing.payable_from_invoice` (as before), or moved
  `disputed → open` with no other column changed **after** its source invoice is `approved` in the same transaction. Anything
  else → MB001 (`paid`/`void`, a `paid_on` change, a re-open while the invoice is still disputed, an own-command insert).
  core-api, in the approve handler after `UPDATE core.supplier_invoice SET status = 'approved'` of a previously disputed
  invoice: `UPDATE core.payable SET status = 'open' WHERE source_type = 'core.supplier_invoice' AND source_id = $1 AND
  status = 'disputed' RETURNING id`, one audit entry per row (`before {status: disputed}`, `after {status: open}`).
- **C1 — guest-token claim.** `SELECT entity, entity_id, from_customer_id FROM core.customer_claim_guest_token()` — no
  arguments; SECURITY DEFINER (owner munim_crosstenant), EXECUTE munim_core only. Call it **instead of** the direct
  `UPDATE core."order" SET customer_id …` inside `customers.account.link.v1`, in the customer's own context
  (`app.role = 'customer'`, `app.customer_id`, `app.command_type = 'customers.account.link.v1'`,
  `app.guest_access_hash = hex(sha256(token))`); otherwise MB001 (no hash, wrong command, a member role). It returns **0 rows**
  (answer `not_found`) unless the caller's profile is signed in (`idp_sub`), live, not a guest and not merged, exactly one
  order carries the hash, and that order has no customer or a live, unmerged, token-only guest profile (an order on a
  signed-in profile never moves — the check core-api did with `asSystem`). Then, under the rule
  `customers.claim_guest_token` (source `core.customer:<caller>`, holds only as `current_user = munim_crosstenant`):
  the order moves to the caller (hash cleared by 0016), that order's coupon uses held by the guest move with it, and — when
  the guest profile has no order, reservation or bulk order left — the guest is marked `merged_into` = caller, so
  `core.customer_erase_merged_guests(caller)` erases it with the caller (R41). Rows, ordered by (entity, entity_id), one
  audit entry each: `('core.order', order_id, previous customer_id or NULL)`, `('core.coupon_use', id, guest)` per moved
  coupon use, `('core.customer', guest, guest)` when merged (audit `before {merged_into: null}`, `after {merged_into:
  caller}`). Loyalty rows stay on the guest. A second call with the same token returns 0 rows.
- **R2-S3-7 — coupon discount follows a re-price.** Rule row `('orders.reprice', 'core.order', 'core.coupon_use')` (state as
  the rule's other rows); `GRANT UPDATE (discount_minor) ON core.coupon_use TO munim_core` (that column only). Trigger
  `core.coupon_use.pricing_frozen`: `discount_minor` changes only under `app.posting_rule = 'orders.reprice'` with
  `app.source_ref = 'core.order:<this row's order_id>'`, that order `placed`/`accepted` — whichever guard branch admitted the
  write (another order's coupon use under the same source → MB001). Write it inside the same `underRule('orders.reprice',
  'core.order:<id>')` block as the header and lines: `UPDATE core.coupon_use SET discount_minor = $2 WHERE id = $1`.
- **Red-proof:** `db/tests/redproof-0017.sh` plants a `0019` per item and requires `tests/w2fixcycle2.test.ts` to exit
  non-zero naming that item's tests (the plant is removed after each run).

**History imports (0018, R44 b, c) — shapes other lanes code against.**
- **Kinds.** `core.document.kind`, `core.import_format.kind` and `core.import_run.kind` also admit `pos_bills` (built-in parser
  `pos_bills_v2`: one row per bill line with channel, brand, customer, tender split, refund, voids) and `waste_log`
  (`waste_log_v1`). The file layouts are core-api's (`services/core-api/src/modules/imports/formats.ts`).
- **Binding.** `imports.run.commit.v1` (draft-only) now lists `core.order_line`, `core.refund`, `core.void`, `core.waste_log` on top of
  0008/0011/0015 (`bank_line, expense, order, review, settlement, settlement_line, supplier_invoice, supplier_invoice_line,
  tender`). It deliberately does **not** list `journal_entry`, `posting` or `stock_movement`: under an import decision those are
  admitted only as derivations of the approved rows (finance.post_order / post_tender / post_refund, inventory.consume_order /
  consume_sku / record_waste — each rule's source state judged per row); a plain insert there is MB008.
- **`core.write_derived(groups jsonb) → integer`** (SECURITY INVOKER, owner munim_migrator, EXECUTE munim_core only). The batched
  form of `underRule(rule, source) + INSERT`: `groups = [{rule, source_ref, journal_entry?, posting?, stock_movement?}, …]` in write
  order; per group it sets `app.posting_rule` / `app.source_ref` (transaction-local), inserts the group's rows (entries before
  postings) and, after the last group, restores the previous values. What a row derives from is the group's, never the row's: an
  entry's `posting_rule`, `source_type`, `source_id` and a movement's `ref_type`, `ref_id` are the group's rule and source; a
  posting must name an entry of its own group (22023 otherwise, before any write); unknown group keys → 22023. `tenant_id` is
  `app.tenant_id`; a movement's `created_by` is `app.member_id`. Every row passes the book guard, RLS, currency, period, balance
  and unit-cost triggers exactly as the same INSERT sent alone would (no `session_replication_role`, nothing bypassed). Columns:
  entry `{id, outlet_id, brand_id, channel_id, entry_date, reverses_id?, memo_key?}`; posting `{id, journal_entry_id, account_id,
  amount_minor, currency}`; movement `{id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, unit_cost_per_1000_minor?,
  currency?, expired_sale_override_id?, at?}`. Callers fire the deferred balance checks after it (`SET CONSTRAINTS
  core.entry_balanced, core.posting_balanced IMMEDIATE`), as finance's `checkBalancedNow` does.
- **Dates and numbers.** No new trigger: an order inserted under the approved import keeps its business date and takes no
  invoice number (0015); its ticket number comes from its own date's counter. core-api quarantines any history row dated on or
  after the outlet's current business date (`date_not_past`) or in a closed month (`period_closed`), and refuses an approval
  (409 `period_closed`, nothing written) when a month closed after the preview.
- **Labelled synthetic.** Every imported row's origin is the decision of an `imports.run.commit.v1` draft (whose payload names the
  run); a history order's `pricing_snapshot` carries `{source, synthetic: true, import_run_id}`; derived rows point at those rows.
- **Red-proof:** `db/tests/redproof-0018.sh` plants a `0020` per item (`0019` since 0019 landed) and requires
  `tests/history.test.ts` to exit non-zero naming that item's tests. `redproof-0017.sh` likewise.

**M-C1a (0019) — shapes other lanes code against.**
- **Outlet RLS (R1-m9).** Since 0019 these carry `tenant_outlet_isolation` (the 0014 predicate) instead of the tenant-only
  policy: `bulk_order, hiring_candidate, payroll_draft, price, reservation, review, roster, staff, ticket_counter, tip_pool`
  (outlet NOT NULL) and, with `outlet_id IS NULL` = tenant-wide (visible to every member), `bank_line, budget,
  business_policy, conversation, expense, journal_entry, market_signal, period_close, reconciliation_break, settlement,
  tax_return_draft`. A member scoped to some outlets now sees only those outlets' prices, staff, rosters, journal entries,
  settlements… — a read that needs another outlet's row must run under `'{*}'`. A context that sets `app.tenant_id` but no
  `app.outlet_ids` sees none of them (as for every outlet-scoped table).
- **Children through their parent** (policy `tenant_via_parent`): `settlement_line` (settlement), `payroll_draft_line`
  (payroll draft), `tip_pool_share` (tip pool), `message` (conversation) are readable exactly when their parent is. New rows of
  the three book children are checked by tenant only (the book guard refuses one under an invisible parent), so a parent and
  its children may still be written in one statement — but an `INSERT … RETURNING` on the child in that same statement is
  refused (RETURNING reads through the parent, which the statement cannot see yet). `message` checks new rows through its
  conversation too.
- **`core.posting` stays tenant-visible.** A parent policy on it made `core.journal_entry_balanced` (deferred, once per
  posting) quadratic inside a large import (worldgen seeding 3× slower, measured). So a scoped member's raw read of
  `core.posting` is tenant-wide: read postings only joined to their journal entry (`JOIN core.posting p ON p.tenant_id =
  je.tenant_id AND p.journal_entry_id = je.id`), as every template does — `tests/templates.test.ts` gates it.
- **The period check is RLS-bound.** `core.journal_entry_open_period()` reads `core.period_close` as the writer: a writer scoped
  to outlet A does not see outlet B's close. Today no scoped context writes a tenant-wide (outlet NULL) entry (every such
  command or decision needs `'{*}'`; every derivation copies an outlet-bearing source's outlet), so MB009 still holds.
- **Template `min_role`** admits `staff, advisor, manager, owner, operator`; the eight `finance.*` templates are `advisor`,
  the six `catalogue.*` `manager`. The ladder is core-api's (approvals `snapshots.ts` RANK): advisor must rank above staff
  (today it ranks with staff, so staff would open every `advisor` template — change RANK with 0019). Whether advisor ranks
  above or below manager decides whether managers open finance templates; recommended `staff 1 < manager 2 < advisor 3 <
  owner 4 = judge 4 < operator 5` (managers stay out of finance, as W2-R8 and the finance routes have it).
- **`numeric_source`** is a string or a non-empty list of strings (CHECK `snapshot_template_numeric_sourced`); every element
  must be on the allow-list (`tests/books.test.ts`). Template SQL never ends with `;` (CHECK `snapshot_template_sql_no_semicolon`).
- **Templates** (`SELECT id, params_schema, columns, min_role FROM evidence.snapshot_template`): catalogue `dish_margin,
  menu_matrix, cost_drift, deal_cost, sku_price_check, recipe_current`; finance `unapproved_deductions, settlement_vs_orders,
  missing_payouts, tender_vs_bank, pnl, gst_check, close_status` and `margin_bridge`. Every named param must be supplied
  (core-api's runTemplate refuses a missing one): nullable ones (`outlet_id`, `channel_id`, `channel_kind`) take `null` = every
  outlet / channel in the minter's scope; `outlet_id` only narrows the scope (R40 C4). `unapproved_deductions`,
  `settlement_vs_orders` and `missing_payouts` add an `outlet_id` param the pack table does not list. `finance.pnl` and
  `finance.gst_check` are core-api's FINANCE_TEMPLATES SQL with the role codes resolved; `finance.gst_summary` is not
  installed (non-pack: M-C1d). `finance.tender_vs_bank` and `finance.close_status` narrow `core.outlet` (tenant-visible) to the
  minter's outlets themselves. Σ rows (`settlement_vs_orders`, `missing_payouts`) are the last row, ids null.
- **`finance.margin_bridge`** (`period_month`, `compare_month`): rows `revenue_volume, revenue_price, deal_discount,
  cogs_supplier_price, cogs_volume_mix, waste, channel_fees, labour, other, unexplained`, then the Σ row `margin_delta_minor`;
  columns `component, prior_minor, current_minor, delta_minor, share_bp`. Each row is a component's level in each month, so
  Σ prior = last month's margin, Σ current = this month's and Σ delta = `margin_delta_minor` exactly (margin = −Σ income and
  expense postings). Revenue rows explain completed orders' sales; COGS rows explain the COGS postings (volume/mix is the rest
  after supplier price and waste); `unexplained` = income not from completed orders' sales (refunds, loyalty, rounding).
- **Gates:** `tests/templates.test.ts` (ids, columns, manager scope, bridge balance, advisor rung, CHECKs — on the canonical
  world + `tests/mc1a-fixture.ts`); `node db/tests/templates-worlds.ts` (columns and bridge balance on the worldgen
  `restaurant_group` and `store` worlds through core-api, plus answer-key checks); `db/tests/redproof-0019.sh` (its red-proofs).
  `tests/template-spec.ts` parses the expected ids, params and columns from the pack docs and ADR-014 §7.3.

**Outlet RLS on compliance and goals (0015 A3).** `licence`, `checklist`, `asset`, `goal`, `task`: the 0014 outlet
predicate plus `outlet_id IS NULL` (a tenant-wide row is visible to every member); `amc`, `maintenance`: visible
exactly when their asset is (`tenant_via_asset`). A future migration that re-issues every `tenant_outlet_isolation`
policy in a loop (as 0014 did) must keep the `outlet_id IS NULL` clause on those five.

**Imported orders (0015 A7).** An order inserted under an approved `imports.run.commit.v1` draft keeps the
`business_date` it carries (the bill's date) and never takes a device invoice number; `ticket_no` is still assigned
for that date.

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
`core.memberships_for_sub(sub text) → (tenant_id, tenant_name, role)` for active memberships.
`core.customer_claim_verified_email_guests() → (entity text, entity_id uuid, from_customer_id uuid)` (0015 A10, R41; not cross-tenant: it
filters on `app.tenant_id`, but needs BYPASSRLS to see guest profiles a customer context cannot): callable only
inside the customer's own `customers.account.link.v1` (`app.role = 'customer'`, else MB001). When the caller's profile
is signed in, live, not a guest and email-verified, every live unmerged guest profile of the tenant with the same
email (case-insensitive) hands over its orders, reservations, bulk orders and (0016) coupon uses and gets
`merged_into` = caller; loyalty rows stay. Writes pass the guard through the rule `customers.merge_verified_email`,
whose source state includes `current_user = 'munim_crosstenant'` (it admits nothing outside this function). Returns
one row per changed book row, ordered by (entity, entity_id): each moved `core.bulk_order` / `core.coupon_use` /
`core.order` / `core.reservation` with its previous customer, and each merged guest as `core.customer` (entity_id =
from_customer_id = the guest). The caller must write one audit entry per row.
`core.customer_erase_merged_guests(erased_customer_id uuid) → (entity text, entity_id uuid)` (0016, R1-M1; not
cross-tenant either): inside `customers.erasure.request.v1` only, by the customer itself (`app.role = 'customer'`,
`erased_customer_id = app.customer_id`) or an owner holding `'{*}'`, and only once that profile is erased (MB001
otherwise). Sets `erased_at` on every live guest profile `merged_into` it (`core.customer_erasure` blanks their personal
columns) through the rule `customers.erase_merged_guests` (source = the erased profile, `current_user` clause as above).
Returns one `core.customer` row per erased guest, ordered by id, for the caller's audit entries.
`core.customer_claim_guest_token() → (entity text, entity_id uuid, from_customer_id uuid)` (0017 C1, R41; not cross-tenant):
the guest-token claim of `customers.account.link.v1` — see "W2 fix cycle 2" below.
Definer objects: 8 (7 functions + `platform.tenant_registry`).

**Guest orders.** `core."order".guest_access_hash` = sha256 (32 bytes) of a random token returned once at placement.
Since 0016 the database clears it whenever the order's `customer_id` changes (the token claim in
`customers.account.link.v1`, the verified-email merge): a claimed order is reached through the profile, never the token.
munim_core has no UPDATE on the column. Since 0017 the token claim is `core.customer_claim_guest_token()` (it must read the
hash before the move clears it).

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
`munim_core` and `munim_svc` may insert. Template `columns` entries carry `numeric_source` (one string, or since 0019 a
non-empty list of them, each) = `core.<table>.<column>`, `count:core.<table>`, or an entry of the column-level intel
allow-list (`tests/manifest.ts` `INTEL_NUMERIC_ALLOW`: forecast qty/lo/hi, quote price/qty/min order/payment days/round,
spend amount, `count:intel.answer`, `count:intel.outcome` — never `finding.confidence_bp`); `min_role` gates who opens it
(the ladder: M-C1a above).

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
2a. **`NOSUPERUSER` in `ALTER ROLE`** (measured on hosted PG 17.11, 42501): on PG16+ only a superuser may name
   SUPERUSER/NOSUPERUSER at all. 0001 therefore omits the clause (CREATE ROLE already defaults to NOSUPERUSER)
   and asserts `rolsuper = false` for every `munim_*` role in a DO block instead, which needs no privilege.
   The other attributes 0001 sets (NOLOGIN/LOGIN, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS,
   BYPASSRLS, INHERIT) were probed OK on hosted. `make dev-db` probes the full set (item 0 in its output).
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
