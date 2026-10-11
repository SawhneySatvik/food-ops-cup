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

**Migrations (26 files).** 0001–0006 M-A (frozen). 0007 W1 riders (command→table binding, storefront keys and
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
fourteen catalogue/finance templates), 0020 M-C23 (specialist threads, the AI policy books, investigations with modes, the
standing grant behind Auto and the `auto_step` run trigger, three intel templates), 0021 M-C1bc + T-093 (the remaining packs'
44 templates; the `shift_log` / `stock_count` history kinds, what an approved import writes for them, `inventory.count_adjust`),
0022 M-C1d (the guard binds every derived row to its source record, F8 draft sources, `as_of` template versions,
`finance.gst_summary`, `inventory.count_variance`), 0023 M-C1e (version 2 of nine templates the pack lanes asked for: Σ rows
first, requested columns, gst_check's outlet filter; the `findings.dismiss.v1` command row), 0024 W3.2 review fixes (one
stock count per outlet per instant, A2A endpoints only on simulated suppliers, quote spans into the supplier's reply,
the `ingest` run trigger, `finance.settlement_vs_orders` v3), 0025 W3 close (`intel.investigation_cost_estimate` v2 per
remaining step, the investigation inbox NOTIFY, the operator's spend-row `id`), 0026 W3 founder decisions (R47: per-role AI
prices on `platform.model_role`, negotiation bounds on `core.business_policy`, `people.labour_vs_demand` v2 at the extra staff's
rate, `purchasing.deal_inputs` v3 with shop SKU margins) — gates see 25 applied.
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
| `MB014` | `sequence_gap` | an `intel.trace_event` seq that is not the run's last seq + 1; since 0020 also a `core.ai_thread_turn.turn_no` / `core.investigation_step.step_no` that is not the next one |
| `MB015` | `investigation_refused` | (0020) an investigation not created by the signed-in member; a plan approved twice or by someone else; a step whose trigger is not who it claims (member / plan / auto — below); a standing grant not the creator's own for the investigation's scope, or revoked twice / by someone else; an `auto_step` run without a live grant of its actor covering its scope |

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
- **Binding (0022, R45 F11).** The written row must also belong to the source: `core.derivation_rule.binding` (NOT NULL) is a
  predicate over the source `s`, the written row `n` and, on UPDATE, its old version `o` (below, M-C1d). A row that fails it
  is not admitted by the derivation branch (MB001 alone; MB008 inside a decision that does not list the table).
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
- **Red-proof:** `db/tests/redproof-0017.sh` plants a `0026` per item (renumbered as later files landed) and requires `tests/w2fixcycle2.test.ts` to exit
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
- **Red-proof:** `db/tests/redproof-0018.sh` plants a `0026` per item (renumbered as later files landed) and requires
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
  `finance.gst_check` are core-api's FINANCE_TEMPLATES SQL with the role codes resolved; `finance.gst_summary` (non-pack)
  arrives with 0022. `finance.tender_vs_bank` and `finance.close_status` narrow `core.outlet` (tenant-visible) to the
  minter's outlets themselves. Σ rows (`settlement_vs_orders`, `missing_payouts`) are the last row, ids null — in version 1;
  since 0023 their version 2 (the one core-api mints) puts one Σ row per settlement / channel FIRST (M-C1e below).
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

**M-C23 (0020) — shapes other lanes code against.** All seven tables lead with `tenant_id`, carry forced RLS and the
restrictive `customer_scope` / `guest_scope` (deny) policies; `intel_ro` cannot write them.
- **Threads (F9, operational).** `core.ai_thread (tenant_id, id, specialist NULL | one of the 8 F8 ids, created_by → member,
  outlet_scope text[] (intel.run's form: '{*}' or uuids), summary jsonb, created_at, updated_at)`. `core.ai_thread_turn
  (tenant_id, thread_id, turn_no, id (unique), member_id, answer_id → intel.answer (unique) NULL, addressed_to NULL | F8 id,
  tainted, created_at)`. Turns are **insert-once** (no UPDATE grant: write the turn after the answer is stored, with its
  `tainted`), gapless per thread: insert `turn_no` NULL → the next number (concurrent asks land consecutively under a
  per-thread lock); a supplied number must be the next (MB014). `summary` = ≤ 8 objects, each with an integer `turn_no` ≥ 1
  (other keys free, e.g. `refs`); every cited turn must exist in the thread, be answered and untainted (23514
  `thread_summary_refused`) — B1. munim_core: INSERT, UPDATE (summary); munim_svc: SELECT (run-frame).
- **AI policy (F10, F11 O-2; books).** `core.ai_policy (tenant_id, id, role ∈ owner|manager|staff|advisor|judge, mode_ceiling ∈
  step|plan|auto, …, origin)`, one per role; `core.ai_budget_cap (tenant_id, id, monthly_cap_minor ≥ 0, currency = tenant base
  (MB003), …, origin)`, one per tenant. Written only by the owner's own commands `ai_policy.ceiling.set.v1` → `core.ai_policy`,
  `ai_policy.cap.set.v1` → `core.ai_budget_cap` (allowed_roles owner only — judge, manager, staff → MB001; scope tenant →
  '{*}'); munim_svc SELECT only. UPDATE: `mode_ceiling` / `monthly_cap_minor`. No rows are backfilled (code defaults); the
  "cap ≤ operator limit" refusal is core's (422 `cap_above_platform_budget`).
- **Investigations (ADR-014 §7.2, F10; operational).** `core.investigation (tenant_id, id, playbook_id, params jsonb, outlet_scope
  text[], created_by, mode ∈ step|plan|auto (default step), status ∈ open|waiting|done|no_driver_found|cannot_verify|cancelled|
  exhausted, checklist jsonb [], steps_done, max_steps 1–10 (default 10), plan_approved_by NULL, plan_approved_at NULL,
  stop_reason NULL | draft|abstain|budget|scope|waiting, created_at, updated_at)`. `created_by` = the signed-in member (MB015);
  `plan_approved_by` is set once, to the signed-in member, and stamps `plan_approved_at := now()` (MB015); `mode = 'auto'`
  needs `plan_approved_by` (23514); a terminal status never changes (MB004). munim_core: INSERT, UPDATE (status, checklist,
  steps_done, stop_reason, mode, plan_approved_by, plan_approved_at, updated_at); munim_svc: UPDATE exactly (status, checklist,
  steps_done, stop_reason, updated_at) — never mode, scope or creator.
  `core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by ∈ member|plan|auto, grant_id (set iff
  auto), run_id NULL, started_at, item_updates jsonb [], summary_answer_id NULL, tainted)`: gapless (MB014; NULL → next), only
  while the investigation is open/waiting and `step_no ≤ max_steps` (MB004). Who (MB015): `member` — munim_core,
  `member_id` = app.member_id; `plan` — munim_core, `member_id` = app.member_id = `plan_approved_by`, mode plan|auto; `auto` —
  **munim_svc** (core-worker), mode auto, `grant_id` = this investigation's live grant given by `member_id`, whose member and
  membership are active and whose current membership covers the grant's scope. `run_id` / `summary_answer_id` are set once
  and `tainted` never returns to false (MB004); an auto step's run must be an `auto_step` run of the same grant, any other
  step's run must not be one (MB015). munim_core and munim_svc: INSERT, UPDATE (run_id, summary_answer_id, tainted).
- **The standing grant (F11 O-1; operational).** `core.investigation_grant (tenant_id, id, investigation_id, member_id,
  outlet_scope, created_at, revoked_at NULL, revoked_by NULL)`: inserted by the investigation's creator in their own request
  (`member_id` = app.member_id = `created_by`), `outlet_scope` = the investigation's, covered by their membership now (MB015);
  at most one live grant per investigation (23505); revoked once by the signed-in member (`revoked_at := now()`, MB015
  otherwise). munim_core: INSERT, UPDATE (revoked_at, revoked_by); munim_svc: SELECT. Membership coverage follows core-domain
  `outletScopeOf`: an empty membership list is every outlet for owner/advisor/judge and none for anyone else; a narrowed or
  removed membership refuses (it does not intersect). Revoking stops Auto (no auto step or run passes); moving the
  investigation out of `auto` or cancelling it is core's.
- **`intel.run`.** `trigger` admits `auto_step` (core-worker's run token for an Auto step) and `grant_id` (set iff
  `auto_step`, FK → the grant); `actor` = the grantor's member id. An `auto_step` insert needs the grant live, actor = grantor,
  the investigation in mode auto and open/waiting, the grantor's membership as above, and the run's scope inside the grant's
  (MB015). Mint auto_step runs from a service context holding '{*}' (the checks read the grant, investigation and membership
  under the caller's RLS; a narrower context fails closed).
- **RLS.** `ai_thread`, `investigation`, `investigation_grant`: intel.run's `tenant_run_scope` form on `outlet_scope` (viewer
  scope ⊇ row scope — review M7; a '{*}' row only to an all-outlet owner/advisor/judge or a service context); turns and steps:
  `tenant_via_parent` (USING and WITH CHECK through the parent); the two books: tenant-only.
- **`intel_ro.investigation_current`** `(id, playbook_id, params, mode, status, stop_reason, checklist, updated_at)` — no
  numeric column; owner munim_view_owner; rows visible as `core.investigation`'s policy allows the token's scope.
- **Templates** (min_role manager):
  `intel.agent_track_record(specialist | null)` → `specialist, proposed, approved, edited, rejected, stale, abstained` per F8
  id with ≥ 1 count (proposed = drafts with `source = 'intel:<id>'`, any status; approved/edited/rejected = their decisions;
  stale = drafts `stale`; abstained = `intel.trace_event` kind `abstain` with actor `specialist:<id>`).
  `intel.ai_budget_left(month)` → `month, currency, owner_cap_minor, operator_limit_minor, effective_cap_minor = least(limit,
  cap), spent_minor, left_minor = effective − spent` (the operator budget's currency; the owner cap applies only in that
  currency; 0 rows without an operator budget for the month).
  `intel.investigation_cost_estimate(investigation_id)` → `currency, per_step_minor = round(Σ spend of runs linked to steps of
  same-playbook investigations ÷ those steps) (half away from zero), steps_in_history, remaining_items (not frozen),
  estimate_minor = per_step × remaining, label = 'estimate (computed)'`; 0 rows without history.
  `INTEL_NUMERIC_ALLOW` gains `count:intel.trace_event` and `platform.llm_budget.limit_minor` (by hand).
- **Gates:** `tests/mc23.test.ts`; the manifest (+7 tables, +2 books, +1 svc INSERT table, +1 view, +3 templates);
  `tests/redproof-0020.sh` (each gate red with a non-zero exit). `tests/gates.ts` intel-cannot-write now requires the refusal
  to name the table (or its schema) — a write past the table privilege that fails inside a trigger no longer counts.

**M-C1bc + T-093 (0021) — shapes other lanes code against.**
- **History kinds (T-093).** `core.document.kind`, `core.import_format.kind` and `core.import_run.kind` also admit `shift_log`
  (parser `shift_log_v1`) and `stock_count` (parser `stock_count_v1`; `import_run.parser` matches `^[a-z][a-z0-9_]*_v[0-9]+$`).
  The file layouts and the parsers are core-api's (T-093 core imports). Nothing else about a run changes: parse → preview →
  draft → approval → commit under the approver's decision (0014 import_run rules).
- **Binding.** `imports.run.commit.v1` (draft-only: an own command → MB001) now also lists `core.shift`, `core.stock_count`,
  `core.stock_count_line`. Still not `core.stock_movement` (a plain movement under the decision → MB008): a count's adjustment
  is the derivation below. The full list: `bank_line, expense, order, order_line, refund, review, settlement, settlement_line,
  shift, stock_count, stock_count_line, supplier_invoice, supplier_invoice_line, tender, void, waste_log`. book_scope: shift and
  count by their own `outlet_id`, a count line through its count — every row must lie inside the approver's outlet scope.
- **What a committed `shift_log` row writes (one row per closed drawer session):** `INSERT INTO core.shift (tenant_id, id,
  outlet_id, device_id, status, opened_by, opened_at, float_minor, currency, closed_by, closed_at, counted_cash_minor,
  expected_cash_minor, variance_minor)` with `status = 'closed'` in that one INSERT (the 0004 CHECK: closed ⇔ closed_by,
  closed_at, counted, expected and variance all set; `variance = counted − expected`; float, counted and expected ≥ 0;
  currency = the tenant's, MB003). `opened_by` / `closed_by` are core.member ids (the file names people core resolves; the lane
  decides whether an unknown name quarantines or falls back to the approver). `device_id` NULL = a device-less drawer.
  **No tender-to-shift link is written:** `core.tender.shift_id` stays insert-only (0015; munim_core has no UPDATE on it), so a
  history shift reaches its tenders by drawer and time window exactly as orders' `expectedCash` does for a live shift
  (outlet, `device_id IS NOT DISTINCT FROM`, `opened_at ≤ tender.at ≤ closed_at`, cash tenders − cash refunds). Expected cash
  is core's (computed from the committed tenders in the window, so the shift log commits after the bills of its days); the
  file's tenders by shift are a control total only — compared, quarantined on mismatch, never written as money.
- **What a committed `stock_count` row set writes:** the count `INSERT INTO core.stock_count (tenant_id, id, outlet_id,
  counted_by, counted_at, status)` with `status = 'submitted'` (inserting it submitted is allowed: status transitions are
  judged on UPDATE only), its lines `INSERT INTO core.stock_count_line (tenant_id, id, stock_count_id, ingredient_id, batch_id,
  expected_qty_milli, counted_qty_milli ≥ 0, unit = the ingredient's base unit)` with `expected_qty_milli` = core's on-hand
  at `counted_at` (Σ movements with `at ≤ counted_at`; the batch's own for a batch line, as inventory's countSubmit), then one
  `core.write_derived` group per count: `{rule: 'inventory.count_adjust', source_ref: 'core.stock_count:<id>', stock_movement:
  [{id, outlet_id, ingredient_id, batch_id, qty_milli = counted − expected (skip 0: the movement CHECK refuses qty 0), unit,
  kind: 'count_adjust', at: counted_at, unit_cost_per_1000_minor: null, currency: null, expired_sale_override_id: null}]}`
  (write_derived stamps `ref_type`/`ref_id` from the group). Rows dated in a closed month or on/after the outlet's business
  date today are core's quarantine reasons (`period_closed`, `date_not_past`), as for the 0018 kinds.
- **`inventory.count_adjust`** (`core.stock_count → core.stock_movement`, source state `s.status = 'submitted'`): an open or
  cancelled count adjusts nothing (MB001 as a derivation alone; MB008 inside an import decision, which does not bind
  movements). Live counts (`inventory.count.submit.v1`, which lists stock_movement itself) may keep their own-command write or
  adopt the rule. The guard judges the source row only, not that the written movement belongs to it (kind, outlet,
  ingredient): the W2 carry-over that M-C1d generalised in 0022 (the movement must be at the count's outlet, of a counted ingredient).
- **Templates (44).** kitchen `ticket_times, ticket_drift, remakes_overprep, prep_need, ticket_coverage`; inventory/purchasing
  `shortfall, waste_week, expiry_risk, shrinkage, dead_stock, price_creep, invoice_vs_po, invoice_duplicates, quote_compare,
  deal_inputs`; forecast `sales_history, slot_profile, points, accuracy, freshness`; people `labour_vs_demand, overtime_drift,
  labour_pct, attendance_coverage, advances_open, payroll_lines`; customers `coupon_leakage, staff_coupon_use, coupon_daily,
  churn_segments, review_trend, consented_audience, coupon_current`; compliance `licence_calendar, log_coverage,
  temp_excursions, asset_costs, energy_per_order`; market `signal_uplift, upcoming, competitor_gap, viability, goal_progress,
  goal_baseline`. Columns and params exactly the pack §3 tables (`SELECT id, params_schema, columns, min_role FROM
  evidence.snapshot_template`); every named param must be supplied; `outlet_id` is nullable everywhere (null = every outlet in
  the minter's scope) and only narrows. `min_role` manager, except `people.payroll_lines` and `market.viability` = advisor.
  The formula behind each (an INFERENCE where the pack gives none) is the comment above its INSERT in 0021. Notable:
  money is valued at the outlet's last receipt cost (pack §2; `unit_cost_per_1000_minor`, so value = qty_milli × per1000 ÷
  1,000,000); forecast reads take the latest `intel.forecast_run` with visible points and only that run's own `method`
  (every run stores both methods' points); `forecast.accuracy` is live (points vs completed order lines), never the run's
  own wape/bias; overtime / payroll / coverage follow core-api's people module exactly; Σ rows are the last row with ids NULL
  (`ticket_drift.late_loss_minor`, `remakes_overprep`'s outlet-week row, `shrinkage`, `invoice_vs_po`, `churn_segments`,
  `log_coverage`'s temperature row). Templates without a date param (`shortfall`, `expiry_risk`, `dead_stock`,
  `advances_open`, `slot_profile`, `upcoming`, `competitor_gap`, `energy_per_order`, `goal_*`, `deal_inputs`) read "today"
  as each outlet's business date now.
- **Scope.** Tables without an outlet column are read through their outlet-bearing parent: `coupon_use → order`, `advance →
  staff`, `stock_count_line → stock_count`, `grn_line → goods_received`, `supplier_quote → intel.run`
  (`tests/mc1bc.test.ts` gates it, as templates.test.ts gates postings). Templates that list outlets narrow `core.outlet`
  (tenant-visible) to the minter's outlets themselves (licence_calendar, log_coverage, sales_history, the market ones);
  `consented_audience` counts a segment snapshot only when the minter covers the snapshot's scope; `deal_inputs` reads only
  the outlets of the quote's run that the minter covers. Tenant-level by nature: `price_creep`, `invoice_vs_po`,
  `invoice_duplicates`, `coupon_current`, `viability`.
- **Not done here.** `inventory.below_reorder` stays the 0005 v1 (no params; columns `outlet_id, ingredient_id,
  ingredient_name, on_hand_milli, min_qty_milli, par_qty_milli`): a pack-shaped v2 would be the version core-api mints and its
  required `outlet_id` would refuse every existing `params: {}` caller — a decision for the orchestrator. `INTEL_NUMERIC_ALLOW`
  gains `count:intel.forecast_point` (by hand).
- **Gates:** `tests/mc1bc.test.ts` (ids vs the parsed packs and the BOARD's per-pack counts, columns and params, manager scope
  with its hand lists, child reads, T-093); `tests/books.test.ts` (numeric sources, TEMPLATES by hand); `node
  db/tests/templates-worlds.ts` (columns on restaurant_group and store, and the plants each pack surfaces — hand list
  KEY_CHECKS); `db/tests/redproof-0021.sh`. `tests/template-spec.ts` now also accepts an id cell with a remark ("`id` (IN)") and
  an array param (`name[]`).

**M-C1d (0022) — shapes other lanes code against.**
- **The guard binds a derived row to its source (G1, ledger R45 F11; sev 1, non-additive).** Branch (3) admits a write only
  when the source row exists, is in the rule's `source_state` **and** `core.derivation_rule.binding` holds — one predicate per
  (rule, source, target), NOT NULL, naming `s.` and `n.` (CHECK `derivation_rule_binding_check`); the full list is
  `db/derivation-rules.json` (`bindings`, per target). What each binds (write these columns exactly as below):
  stock movements — `kind` the rule's, `ref_type`/`ref_id` = the source, `outlet_id` = the source's outlet (`from_outlet_id`
  for `transfer_out`, `to_outlet_id` for `transfer_in`), and the ingredient (and batch, `IS NOT DISTINCT FROM`) one of the
  source's lines where it has lines (GRN, transfer out, supplier return, count) — `transfer_in` binds the ingredient only (the
  stock lands in the destination's own batch), `record_waste` the waste row's own ingredient and batch, `sale_return` the
  returned line's SKU stock ingredient, `reverse_order_consumption` an ingredient + batch the order consumed; consumption
  (`consume_order` / `consume_sku`) binds the order and outlet only (the recipe decides the ingredients). Journal entries —
  `source_type`/`source_id` = the source, `posting_rule` = the rule, and a `reverses_id` (if any) an entry of the same source;
  postings — an entry with those three. Payable — `source_type`/`source_id` = the invoice, `supplier_id` its supplier.
  Loyalty — earn: this order, its customer, no `refund_id`; reverse by order: this order, no `refund_id`; reverse by refund:
  `refund_id` = the refund, `order_id` its order (0016's trigger keeps its own checks). Re-price — the source order, its own
  lines and coupon uses (`n` and `o`). Breaks — settlement: a line of the settlement on its channel and outlet; bank: this bank
  line; order: this order. The definer functions' rules — rows move to the source customer (`customer_id`), guests merge into
  it (`merged_into`, never itself); erasure reaches only guests already merged into it. A failure reads `book_write_refused:
  <table> — row <id> does not belong to the source of <rule> (<table>:<id>)` (ids only). 0016/0017's per-table triggers stay.
  Index `core.stock_movement_ref_idx (tenant_id, ref_type, ref_id)` (the reversal's lookup). The binding's full-flow dry
  run (db, core-api, integration, the four worldgen worlds) newly refused only two db test fixtures (fixed); no code path.
  (The F8 CHECK below refuses two core-api test fixtures' draft sources — `intel:forecast`, `intel:compliance_assets`.)
- **F8 draft sources (S1).** `core.draft.source` ∈ `import`, `member`, `intel:<catalogue | kitchen | inventory_purchasing |
  finance | people | customers | compliance | market>` (CHECK `draft_source_f8`; 23514 otherwise — not `intel:manager`, not
  `intel:forecast`). The migration refuses to apply while a non-F8 draft exists (it counts them; relabel first).
- **`as_of` versions (A1).** Version 2 of `inventory.shortfall, expiry_risk, dead_stock, purchasing.deal_inputs,
  forecast.slot_profile, people.advances_open, compliance.energy_per_order, market.signal_uplift, upcoming, competitor_gap,
  goal_progress, goal_baseline, catalogue.cost_drift, recipe_current` (the 0021 list, plus `signal_uplift` and the two 0019
  templates that read `current_date`, found by querying every template's SQL for a clock read). Same columns and role; one
  more param `as_of` (`["string", "null"]`, date): NULL = today (v2 at NULL is v1 exactly — gated), a date anchors every window
  ("today") at that business date. Balances (stock on hand, advances outstanding, prices in force) stay as recorded now:
  `as_of` moves the anchor, it does not replay the books (INFERENCE). core-api mints the latest version, so **every caller of
  these 14 must now pass `as_of`** (`null` for today) or mint refuses `invalid_payload` (named params are required);
  `dead_stock` anchors at the end of the `as_of` business day at each outlet. v1 rows are unchanged.
- **Requested columns (A2, orchestrator 11 Oct for b-45 / b-47), in the same version 2, appended after v1's:**
  `inventory.expiry_risk` + `ingredient_id`, `unit` (the ingredient's base unit), `supplier_id` (the latest GRN receipt into
  the batch, else of the ingredient at the outlet; NULL without one); `catalogue.cost_drift` + `price_id`, `channel_kind`,
  `tax_class` of its `pr` row (`price_id` = the pack §4 dedupe suffix); `catalogue.recipe_current` + `unit` (the line's own);
  `market.upcoming` v2 renames `forecast_orders` → **`forecast_units`** (it sums forecast item units, not orders — v1 keeps the
  pack's name; the pack §4 `market.event_ahead` rule reads it); and **`catalogue.dish_margin` v2** (no `as_of`: it has a window)
  + `price_id`, `channel_kind`, `tax_class` of the item's current price in scope on `:to` (counter first, then the highest).
  Since core-api mints the latest version, these columns appear in every new snapshot of those templates.
- **Templates (T1).** `finance.gst_summary(period_month)` → `key, output_tax_minor, input_tax_minor, net_payable_minor`
  (core-api's FINANCE_TEMPLATES SQL, codes 2100 / 1300; min_role advisor — INFERENCE, as 0019 moved the other finance
  templates). `inventory.count_variance(count_id)` → `line_id, ingredient_id, batch_id, expected_qty_milli, counted_qty_milli,
  variance_qty_milli, variance_value_minor` per line, then the Σ row (ids NULL) = Σ of the rounded line values; valued at the
  count outlet's last receipt cost on or before `counted_at`; min_role manager (columns INFERENCE: no pack table). List
  templates the detectors enumerate from (min_role manager, columns as the lanes asked): `purchasing.invoices(from, to)` →
  `supplier_invoice_id, supplier_id, invoice_date, total_minor, currency` for non-void invoices (tenant-level);
  `inventory.counts(outlet_id, from, to)` → `count_id, outlet_id, counted_at` for submitted counts whose business date is in
  the window (outlet RLS); `market.goals(outlet_id)` → `goal_id, outlet_id, metric, period_start, period_end` (= period_from,
  due_on) for active goals; `outlet_id` narrows to that outlet's own goals, NULL lists every goal in scope including
  tenant-wide ones (INFERENCE).
- **Not done here.** `finance.shift_tenders`, the `orders.*` today strip, `inventory.on_hand`, `imports.run_preview`: no
  consumer code yet and no column spec (screens say "pending D-1") — install when a lane names the columns.
  `inventory.below_reorder` v2 stays a decision for the orchestrator (0021).
- **Gates:** `tests/mc1d.test.ts`; `node db/tests/templates-worlds.ts` (the time-bound plants RG-M1, RG-M1b, ST-I4 now run v2
  at `as_of` = the gate profile's date, never skipped, and hold with the wall clock moved 400 days); `db/tests/redproof-0022.sh`.

**M-C1e (0023) — shapes other lanes code against.** Version 2 of nine templates (core-api mints the latest, so every new
snapshot of these is v2 — **callers below must change**). The formula notes are 0023's header; in short:
- **`finance.settlement_vs_orders` v2** — v1's columns + `settlement_id`, `channel_id`. One Σ row per settlement FIRST
  (`settlement_line_id` NULL), summing only the lines that count under pack §4 (short ≥ max(`line_short_minor_gte`,
  ⌈expected × `line_short_bp_gte` ÷ 10,000⌉), the active pack's `detectors.finance.short_payout` — core-api reconcileSettlement's
  rule), every Σ column over those same lines; zeros when none counts. Expected net starts from the matched order's total
  (pack §2, reconcileSettlement), the statement's gross for an unmatched line. Then the lines (as v1).
- **`finance.missing_payouts` v2** — + `channel_id`. One Σ row per channel FIRST (`order_id` NULL), `days_unsettled` = the
  oldest order's; no row for a channel with nothing unsettled (v1 always printed a zero Σ row).
- **`finance.tender_vs_bank` v2** — + `week_start`, `gap_days`. One Σ row per ISO week FIRST (`business_on` NULL) over its gap
  days (the statement has a credit on or after the day up to `:to`, and gap ≥ the pack's `detectors.finance.tender_gap`
  `gap_minor_gte`); `outlet_median_voids` on a Σ row = the per-day median × `gap_days` (so "voids ≥ 2 × median" compares
  like with like); `shift_member_id` only when every gap day's member is the same. Day rows as v1.
- **`finance.gst_check` v2** — params + `outlet_id` (nullable, required as every named param): narrows orders and entries.
- **`customers.coupon_current` v2** — + `code`, `kind`, `valid_from`, `valid_to` (timestamptz), `outlet_ids` (**text**: a JSON
  array of uuids as jsonb prints it, `["a", "b"]`; `[]` = every outlet), `active`, `requires_customer`.
- **`compliance.licence_calendar` v2** — + `status` (`in_force` | `expired` | `missing`), `manager_member_id`. Expired = none in
  force, and the kind's latest non-superseded licence had started and ran out (active, `valid_to` < as_of) or is `lapsed`:
  the row names it, `days_left` = `valid_to` − as_of capped at 0. **`missing` is now true only for status `missing`.**
- **`compliance.log_coverage` v2** — + `manager_member_id` (of `:outlet_id`, else the checklist's own outlet; the temperature
  row: of `:outlet_id`; else NULL).
- **Manager rule** — an active member with an active `manager` membership listing the outlet; several → the fewest listed
  outlets, then the lowest member id; none → NULL. Only in-scope outlets. (Worldgen: only restaurant_group's South has one.)
- **`people.overtime_drift` v2** — one Σ row per staff member FIRST (`iso_week` NULL), Σ of their week rows (cost = Σ of the
  rounded weekly costs). Week rows as v1.
- **`kitchen.ticket_times` v2** — one row per station and item over the whole window FIRST (`slot_start` NULL; its own
  p50/p80), then v1's per-slot rows.
- **`findings.dismiss.v1`** — command authority row (owner, manager, judge; outlet; `target_tables` `{}` like
  `drafts.approve.v1`): it writes only `intel.finding.status` (munim_core's 0012 column grant) and opens no book table.
- **Callers to update (breaking):** `finance.gst_mismatch` (must send `outlet_id`, else mint refuses `invalid_payload`);
  `finance.short_payout` / `missing_payout` / `tender_gap` detectors and the finance skill (Σ rows are first and per
  settlement / channel / week; read them by their NULL id column); `compliance.licence_expiring` (an expired licence is no
  longer `missing`: it fires on `days_left` ≤ 30, negative once run out); `people.overtime_drift` and
  `kitchen.prep_time_gap` (filter the NULL `iso_week` / `slot_start` rows — the Σ / whole-window rows now come first and
  carry the same ids); intel pack tests that install `requested_templates_v2.sql` now find the migrator's v2.
- **Gates:** `tests/mc1e.test.ts` (columns, roles, params, Σ first, scope, v1 inside v2, hand values, D1);
  `node db/tests/templates-worlds.ts` (now four worlds: RG-F3, CK-F3, AU-F3, RG-F4 + F7, RG-F5, RG-P1, AU-P1, RG-A5, ST-A5,
  AU-A5 on v2); `tests/templates.test.ts` + `template-spec.ts` (`SPEC_VERSION`: finance.md §3 describes the finance v2s);
  `db/tests/redproof-0023.sh`. Other red-proof scripts plant `0025_redproof_plant.sql` now.

**W3.2 review fixes (0024) — shapes other lanes code against.** The formula and refusal notes are 0024's header; in short:
- **One count per outlet per instant (R-A F2).** `core.stock_count_outlet_counted_at_key` UNIQUE `(tenant_id, outlet_id,
  counted_at)`, over every status: a second count at the same outlet and `counted_at` → 23505 (core maps it to 409, the
  T-093 "same count" conflict). `counted_at` defaults to `now()` (the transaction's start), so **two counts at one outlet in
  one transaction collide** — give each its own `counted_at`. No shift EXCLUDE: core serialises shift overlap with a
  `pg_advisory_xact_lock` per tenant + outlet. The migration refuses to apply while a duplicate exists.
- **A2A endpoints only on simulated suppliers (R-C F4).** `core.supplier` CHECK `supplier_a2a_simulated_only`
  (`a2a_card_url IS NULL OR kind = 'simulated'`): `purchasing.supplier.upsert.v1` with a real supplier and a card URL (insert
  or update) → 23514 (core: 422 `invalid_payload`, or map it to a named refusal). `kind` has no UPDATE grant, so the pairing
  holds for the row's life. RFQ code must still read `kind` before it sends (defence in depth, R-C F4's code half).
- **Quote provenance (R-C F3).**
  - `intel.chunk` also admits a **run-held chunk**: `document_id` and `message_id` NULL, `run_id` set (CHECK
    `chunk_source_check`; before: exactly one of document / message). It holds text a run received that is neither — a
    simulated supplier's reply. Untrusted text like any chunk: tenant-only RLS, `intel_ro.chunk_search` lists it, a run
    that reads it is tainted. contracts `ChunksBatchRequest` must drop its "exactly one" refine for this shape (run-held
    chunks are stamped with the writing run's id by `writeChunks`).
  - `intel.supplier_quote` + `source_chunk_id uuid NULL` (FK → `intel.chunk`) + `spans jsonb NULL`, both or neither (CHECK
    `supplier_quote_spans_with_chunk`). Write the chunk first, then the quote, in the same run. `spans` = `{"<field>":
    [start, end], …}` for the numeric fields `unit_price_minor`, `qty_milli`, `min_order_qty_milli`, `payment_days`;
    **0-based, end-exclusive, in code points** (Python `str` indices; in JS slice `Array.from(text)`, never UTF-16
    `slice`). Every field that is set (≠ 0) needs a span; a zero field may have none (`ground()` emits none for a zero).
  - Trigger `spans_match` (MB012 → 422 `claim_quote_mismatch`): the chunk must be visible and the quote's own run's; spans an
    object of those four keys; each `[start, end]` integers with `0 ≤ start < end ≤ length(text)`. The span's text is not
    re-parsed (intel's tokenizer is the one tokenizer). Errors carry ids and the four field names only, never a key it
    did not recognise. A chunk with no spans hits the trigger first (MB012); spans with no chunk hit the CHECK (23514).
  - Grants unchanged: `munim_svc` INSERT (core's `quotes:batch`), `munim_core` / `munim_svc` SELECT; intel writes nothing.
    contracts `QuotesBatchRequest` and core `writeQuotes` gain `source_chunk_id` + `spans` (both nullable).
  - **How a quote-ref leaf shows its source.** A draft's numeric leaf that is a quote ref (`⟨cite:row:intel.supplier_quote:<id>⟩`
    + column) renders the value from the quote row, labelled "Simulated supplier" and "from the supplier's reply", with the
    reply's span beside it: read `intel.chunk.text` by `source_chunk_id`, cut `[start, end)` of the column's field from
    `spans` in code points, render it as escaped plain text (never HTML; gotcha 15) with the surrounding sentence if wanted.
    A quote with no `source_chunk_id` (written before 0024) shows the value with "source not kept" — a person confirms or
    types it (R26), as before. The span is evidence for a person; it is never re-read by a model.
- **`intel.run.trigger` `ingest`.** CHECK `run_trigger_check` admits `event, watch_sweep, ask, brief, auto_step, ingest`. An
  ingest run's `actor` is the uploading member's id (or `watcher:<pack>` for a worker-started ingestion): the 0003 actor
  CHECK is unchanged. contracts `RunTrigger` lacks both `auto_step` (0020) and `ingest`; core's `ttlSeconds` decides its TTL.
- **`finance.settlement_vs_orders` v3 (R-A F5)** — core-api `reconcileSettlement`'s rule exactly: the order is INNER-joined, so
  an unmatched line (no `matched_order_id`, or an order outside the minter's scope) has **no row** and adds nothing to its
  Σ row; a missing pack threshold takes core's default (`line_short_minor_gte` ?? 1, `line_short_bp_gte` ?? 0). Σ rows are
  v2's set (one per settlement with ≥ 1 order line, first; zeros when none counts — also when every line is unmatched).
  Columns, params and `min_role` = v2's. core-api mints v3 from now on. **Callers:** `finance.short_payout` (and the finance
  skill) see no unmatched lines any more. The worldgen F3 plants (RG-F3 ZM-C-SHORT, CK-F3 SW-K-SHORT, AU-F3 DD-SHORT) are
  re-planted (wg-2) on real aggregator bills of the dated history (20/20, 12/12, 15/15 lines matched), so core's breaks and
  v3 both read the keys (60,000, 57,600, 3,000). Note: with
  `greatest()` skipping a NULL and `short > 0` already implying ≥ 1, each coalesce alone changes nothing; both together are
  what stop a pack without line thresholds from counting nothing.
- **Hosted apply.** Run the two pre-check counts first (the migration refuses otherwise):
  `SELECT tenant_id, outlet_id, counted_at, count(*) FROM core.stock_count GROUP BY 1, 2, 3 HAVING count(*) > 1` and
  `SELECT tenant_id, id FROM core.supplier WHERE a2a_card_url IS NOT NULL AND kind <> 'simulated'`. The unique index is
  built non-concurrently (the runner wraps each file in one transaction): it locks `core.stock_count` writes for the build.
- **Gates:** `tests/w32fix.test.ts` (each refusal paired with an accept; hand values beside the fixture rows); `node
  db/tests/templates-worlds.ts` (v3 Σ = core's `short_payout` breaks per settlement on every world with a settlement; the F3
  statement fully matched with core's breaks = v3 Σ = the key); `db/tests/redproof-0024.sh`. The manifest's FK count is 366.

**W3 close (0025) — shapes other lanes code against.** The formula notes are 0025's header; in short:
- **`intel.investigation_cost_estimate` v2 (review R-D 4)** — core-api mints v2 from now on. Cost unit = the **step** (one step
  judges every evaluable item in one L1 call), not the item.
  - `per_step_minor` = round(Σ spend of the runs linked to steps of same-playbook investigations ÷ the number of those
    linked steps), half away from zero, per spend currency. Linked = `run_id IS NOT NULL`. The denominator counts every
    linked step whatever its spend (a step with no spend, or spend only in another currency, is 0 in the numerator and 1 in
    the denominator); v1 counted only steps with spend in that currency.
  - `remaining_steps` (new column, after `remaining_items`) = open / waiting: `max(0, least(max_steps − steps_done, items not
    frozen))`; a terminal status: 0. The not-frozen cap is an INFERENCE (a step that freezes nothing new usually ends the
    run: core-domain `nextStatus`).
  - `estimate_minor` = `per_step_minor × remaining_steps` (was × `remaining_items`). Columns otherwise v1's; params and
    `min_role` v1's. 0 rows without a linked step, **and** when linked steps exist but none recorded spend (no currency to
    state it in → "cannot verify", as without history). v1 is unchanged.
  - **Callers:** core-api reads only `estimate_minor` / `currency`. A fixture whose history has a linked step with no spend
    now reads a lower per-step figure; one whose `max_steps − steps_done` is below the unfrozen count reads fewer steps.
- **`core.investigation` NOTIFY (b-89a).** Trigger `notify_inbox` AFTER INSERT OR UPDATE → `core.notify_ids('munim_inbox')`,
  payload `'<tenant_id>:<id>'`. core-worker's `munim_svc` UPDATEs (Auto steps) now wake inbox streams with no code. core-api's
  explicit `notifyInbox` sends the identical payload in the same transaction; Postgres delivers it once (kept or deleted at
  core's choice).
- **`munim_platform` reads `intel.intel_spend.id` (b-92)** — page a tenant's spend rows by `(at, id)`. Still never `run_id`,
  `role`, `provider`, `model_id` or tokens, and never `SELECT *`. Not granted: `core.ai_budget_cap` (a tenant book; the A5
  screen does not show it; it would need USAGE on `core` and an operator RLS path) — asserted absent.
- **No business-policy command row.** The business-policy command uses 0007's `tenancy.policy.set.v1` (owner, judge; tenant;
  `core.business_policy`), unchanged.
- **Gates:** `tests/w3close.test.ts` (hand values beside the fixture rows; each refusal paired with an accept);
  `db/tests/redproof-0025.sh`. Red-proof scripts plant `0026_redproof_plant.sql` now; `grants.test.ts` plants `0026_planted.sql`.

**W3 founder decisions (0026, ledger R47) — shapes other lanes code against.** The formula notes are 0026's header; in short:
- **D1 — per-role AI prices.** `platform.model_role` + `input_price_per_mtok_minor`, `output_price_per_mtok_minor`
  (`bigint`, whole minor units of `price_currency` per 1,000,000 tokens — the shape rider-core validates; a sub-minor list
  price such as US$0.075 = 7.5 cents cannot be stored and is rounded UP by the operator; a fractional value sent as a
  parameter is refused 22P02, never rounded) and `price_currency` (`char(3)`). All three NULL or all three set (CHECK
  `model_role_price_all_or_none`); prices ≥ 0 (`model_role_price_nonnegative`: **0 = free**, R47 D8); currency `^[A-Z]{3}$`.
  **NULL = not priced: intel refuses a live call on such a role** (R47 D1); recorded mode needs no price. The six 0015 rows
  are NULL — no price is invented. Writes: `munim_platform` only (UPDATE on the three columns; INSERT table-level), i.e. only
  through core's approved config draft (R24); `munim_core` / `munim_svc` read them (table-level SELECT; the internal
  model-roles read runs as `munim_svc`); `munim_intel_ro` reads nothing. **No trigger:** an approved draft applies exactly as
  signed; clearing the price when a draft changes the model and omits the price group is core's `apply()` (orchestrator
  ruling) — the database never rewrites a price (post-condition: `touch_updated_at` is the table's only trigger).
  **Callers (core, contracts, intel — none of this is in `db/**`):** `platform/validate.ts` `model_role` patch must accept
  the three keys (all or none; a non-negative decimal string or number with ≤ 6 decimals; currency `^[A-Z]{3}$`);
  `drafts.ts` `apply()` must write them (and `currentOf()` must return them, so the platform audit's before/after carries the
  price); `platform/read.ts` `modelRoles` lists columns explicitly, so the internal read exposes nothing until core adds them
  — and intel's `PlatformModelRoleRow` is `extra='forbid'`, so core's response, contracts and the regenerated Pydantic must
  change in one commit or every live model resolve fails. bigint comes back from `pg` as a string. How a USD price becomes
  spend in an INR/AUD budget is not decided here (founder, money).
- **D7 — negotiation bounds.** `core.business_policy` + `negotiation_target_bp` and `negotiation_walkaway_bp`, basis points
  of the reference (last) price, each nullable and CHECK 1..20000; CHECK `business_policy_negotiation_order_check` target ≤
  walk-away when both are set. A pair with one bound unset is judged on the effective pair (the other's default) by core —
  the database cannot see a default that lives in code. **NULL = unset → code applies R47's 9500 / 11000** (no column DEFAULT: it would stamp an unapproved 95/110 on
  every policy row). Written only as a new policy version by the owner's own `tenancy.policy.set.v1` (0007 row: owner, judge;
  tenant; `core.business_policy` — asserted from the live row); no UPDATE grant. **Callers:** core's `policySetHandler` carries
  the previous version's columns over by an explicit list — it must add both bounds (to the payload, the carry-over and the
  audit `after`), or the next labour/margin change silently resets them to NULL (= the defaults). intel's
  `negotiate/policy.py` holds the 9500 / 11000 defaults today; it needs the owner's values from core (run-frame or a snapshot
  — a core decision) and must say "default" when they are NULL.
- **D6 — `people.labour_vs_demand` v2** (core-api mints it from now on). Per outlet everywhere (v1 summed outlets when
  `outlet_id` was NULL and judged them on one merged norm); `excess_min` = attended − orders × norm (≥ 0); `excess_cost_minor` =
  those minutes filled from the slot's attending staff **cheapest hourly rate first** (staff_id breaks ties), each person at
  most their own minutes in the slot, × their rate ÷ 60, rounded once (v1: × everyone's minute-weighted rate). Cheapest-first
  is a lower bound — it never overstates a "₹ found" figure. One Σ row per (outlet, weekday, slot) FIRST (`business_on` NULL,
  `weekday` `mon`..`sun`), each cell = Σ of the day cells below it; then day rows by outlet, day, slot. Columns: v1's eight,
  then `outlet_id`, `weekday`, `excess_min`; params and `min_role` v1's; the norm is v1's (rolling 8-week median of the same
  outlet, weekday and slot). **Callers:** `people.overstaffed_slot` skips the Σ rows already (no `business_on`), but its impact
  changes: RG-P2's latest qualifying day reads 16,000 (the helpers' 8,000/h × 120 min), not 18,000 (blended 9,000/h) —
  `tests/packs/people/test_people_e2e.py` asserts 18,000 and must change (INFERENCE: not run here), and its
  `test_rg_p2_is_judged_against_its_planted_demand_norm` calls `date.fromisoformat(r["business_on"])` on every row, which
  raises on the Σ rows (NULL). Any consumer that sums a column over all rows double-counts unless it filters
  `business_on IS NOT NULL` (people.md §8 "labour cost (30 d) ← labour_vs_demand"). The pack doc (people.md §3) describes v1's columns
  (`template-spec.ts` SPEC_VERSION stays 1).
  **RG-P2 vs its key.** The key's 3,600 minutes / 480,000 counts every planted helper minute. The template reads 3,060 / 408,000
  on the gate world: three of the 30 slot-days also carry a baseline history bill (8 Sep 16:00, 30 Sep 15:00, 7 Oct 17:00: 2
  orders × 120 = 240 needed → 0), and in the fifth week the rolling norm has absorbed four helper days (median 180 → 60 instead
  of 120 on three slot-days). Every excess minute is priced at the key's own rate (480,000 × 60 ÷ 3,600 = 8,000/h). The
  template stays as written (orchestrator ruling); the 408,000 vs 480,000 gap is recorded as a worldgen/key issue (the
  key's "orders flat" is false on three slot-days, and the rolling norm absorbs the plant), and the m0026 world check
  asserts the template's own hand value, 3,060 / 408,000.
- **D3 — `purchasing.deal_inputs` v3** (core-api mints it). v2 + recipe-less shop SKUs: an item `kind = 'sku'` whose
  `stock_ingredient_id` is the quoted ingredient and that has no recipe (fuse's rule) sells one base unit of it, so its margin =
  (selling price − the quote's unit price converted to the base unit) × 10000 ÷ selling price, with selling price = the
  **lowest current `core.price`** (no variant) at the quote's run outlets in the minter's scope, valid on each outlet's today
  (`as_of`-anchored), net of tax when the pack's prices are inclusive (amount × 10000 ÷ (10000 + the class's `rate_bp`)).
  `margin_at_quote_bp` = the lowest over v2's dishes and these SKUs (an unpriced SKU or a unit that does not convert drops out,
  like v2's unsold dishes). New last column **`margin_rule_applies`** (boolean): true when a dish's current recipe uses the
  ingredient or a recipe-less SKU stocks it; **false for packaging** (no item sells it; the margin is then NULL). Params and
  `min_role` v2's; `margin_at_quote_bp` also names `core.price.amount_minor`. **Callers:** `negotiate/review.py` must skip the
  margin rule when `margin_rule_applies` is false (today a NULL margin is `cannot_verify cost_price_missing`); a true flag with a
  NULL margin stays cannot-verify. Packaging's `need_qty_milli` is still 0 (fuse has no consumption path for it), so the overlap
  rule still abstains — D3's "judged on need" has no source yet. inventory-purchasing.md §3 describes v1's columns.
- **Gates:** `tests/w3decisions.test.ts` (hand values beside the fixture rows; each refusal paired with an accept; both new
  versions' output columns = their declared columns); `node db/tests/templates-worlds.ts` (m0026: RG-P2's Σ rows, total and
  per-row rate against the hand derivation above, with the two-bill slot-days counted from `core.order` directly; the store's
  atta 1,115 / sugar 1,458 / carry bag NULL-and-false); `db/tests/redproof-0026.sh`. Red-proof scripts plant
  `0027_redproof_plant.sql` now; `grants.test.ts` plants `0027_planted.sql`.

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
