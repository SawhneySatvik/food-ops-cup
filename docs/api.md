# API

The contract is code. The zod schemas in [`packages/contracts/src/`](../packages/contracts/src/) generate two OpenAPI
documents, kept in the repository:

| Document | Covers | Size |
|---|---|---|
| [`packages/contracts/generated/openapi/public.json`](../packages/contracts/generated/openapi/public.json) | `/v1` and `/platform/v1` | 222 paths, 269 operations |
| [`packages/contracts/generated/openapi/internal.json`](../packages/contracts/generated/openapi/internal.json) | `/internal/intel/v1` | 21 paths |

The TypeScript client is [`packages/sdk`](../packages/sdk/) (`@munim/sdk`). intel's Pydantic models are generated from the
same schemas (`services/intel/munim_intel/contracts_gen/`). All data is synthetic, suppliers are simulated and payments are
recorded, never processed.

## Surfaces and authentication

| Surface | Who calls it | Credentials |
|---|---|---|
| `/v1` member routes | Staff and owners (most of the 269 operations) | `Authorization: Bearer <ID token>` and `X-Munim-Tenant: <tenant id>` |
| `/v1/storefront`, `/v1/account` | Customers and guests (about 20 operations) | `X-Munim-Storefront-Key`, plus `Authorization: Bearer <customer token>` (optional) or `X-Munim-Guest-Token` (one order) |
| `/v1/cares-network` | Anyone (5 operations) | None. Read-only and rate-limited to 60 requests a minute per client address. |
| `/platform/v1` | Platform operators (19 operations) | `Authorization: Bearer <ID token>` of a row in `platform.operator` |
| `/internal/intel/v1` | intel only | `x-munim-service-secret` **and** `Authorization: Bearer <run token>` |
| `/internal/cron/v1/tick` | A scheduler, in place of a long-running core-worker | `Authorization: Bearer <MUNIM_CRON_SECRET>`. Wired only by core-api's env-only boot with that secret set; otherwise `404`. |
| `/health` | Anyone | None. Returns `{status, migration_version, idp}` or `503`. |

- The member's role and outlet scope come from `core.membership`, never from token claims. `GET /v1/me` returns them.
- A bad or missing token is `401`. A tenant, storefront key or profile that does not resolve is `404`, so a caller cannot
  learn that another tenant exists. On `/internal/…` a bad secret or token is `404` too.
- A guest token is returned once, when the guest places the order. Only its SHA-256 is stored.
- Browser CORS headers are sent only on `/v1/storefront`, `/v1/stream` and `/v1/cares-network`, and only for origins listed
  in `MUNIM_CORS_ORIGINS`. Credentials are headers, not cookies.

## Commands and idempotency

Every change is a command. The body is:

```json
{
  "command_id": "<uuid v7>",
  "idempotency_key": "<8 to 100 characters of A-Z a-z 0-9 _ . : ->",
  "type": "orders.place.v1",
  "payload": { }
}
```

- `type` is a dotted lowercase name ending in `.v<N>` (`orders.place.v1`, `customers.loyalty.adjust.v1`) and must match
  the route; otherwise the command is refused with `422`: `invalid_payload` where the route validates its own typed
  envelope, `command_type_mismatch` where it takes the generic one.
- The tenant and the actor are not in the body. Core takes them from the verified identity and records them in
  `core.command_log`.
- The same `idempotency_key` with the same request returns the stored response byte for byte with the header
  `X-Munim-Replayed: true`. The same key with a different request is `409 idempotency_conflict`.
- The request hash covers the actor, so another person cannot replay someone's key into their own result.
- Bodies are capped: 256 KiB by default, 8 MiB for `POST /v1/imports/documents`, 16 MiB for `/internal/intel/v1`. A
  larger body is `413 bad_request`.
- Prices and totals are re-derived on the server. A client total is ignored, and `preview_total_changed` refuses a
  place-order whose total no longer matches its preview.

Reads are `GET`. Most list routes take `limit` and an opaque `cursor` and return `{items, next_cursor}`.

## Route groups

Counts are operations in `public.json`.

| Prefix | Operations | What it covers |
|---|---|---|
| `/v1/orders`, `/v1/orders:preview`, `/v1/kitchen`, `/v1/shifts`, `/v1/pickup-windows` | 23 | Till orders, accept, advance, push back, tenders, voids, refunds, receipts, the kitchen board and tickets, drawer shifts |
| `/v1/storefront`, `/v1/storefront-keys`, `/v1/storefront-pages`, `/v1/account` | 28 | The customer side: menu, preview, place, cancel, reschedule; account profile, consent, export, erase; the page builder |
| `/v1/catalogue` | 14 | Items, recipes, prices, deals, coupons, availability, menu, barcodes |
| `/v1/inventory`, `/v1/suppliers`, `/v1/purchase-orders`, `/v1/goods-received`, `/v1/supplier-invoices`, `/v1/supplier-returns`, `/v1/rfq-requests` | 34 | Stock, counts, waste, transfers, suppliers, purchase orders, receiving, invoices, returns, request for quotes |
| `/v1/finance`, `/v1/imports` | 19 | Settlements, bank lines, disputes, period closes, channel terms, expenses, budgets, a Tally export; import runs, previews and rows |
| `/v1/people`, `/v1/members`, `/v1/tasks`, `/v1/goals` | 28 | Rosters, attendance, advances, payroll drafts; members and roles; tasks and goals |
| `/v1/customers`, `/v1/campaigns`, `/v1/reviews`, `/v1/reservations`, `/v1/bulk-orders`, `/v1/loyalty:adjust` | 15 | Customer records, loyalty, campaigns, reviews, reservations |
| `/v1/compliance` | 16 | Licences, assets, checklists, temperature logs, contracts, maintenance |
| `/v1/ask`, `/v1/threads`, `/v1/specialists`, `/v1/inbox`, `/v1/findings`, `/v1/drafts`, `/v1/draftables`, `/v1/investigations`, `/v1/ai`, `/v1/runs`, `/v1/traces`, `/v1/snapshots`, `/v1/lineage`, `/v1/wiki`, `/v1/conversations` | 34 | The AI surfaces and approvals (below) |
| `/v1/cares`, `/v1/cares-network` | 22 | Munim Cares: profile, listings, hand-overs, claims, market; the public read-only network |
| `/v1/tenant`, `/v1/outlets`, `/v1/brands`, `/v1/channels`, `/v1/devices`, `/v1/onboarding`, `/v1/policy`, `/v1/me` | 16 | Business setup |
| `/v1/stream` | 1 | Server-sent events |
| `/platform/v1` | 19 | Tenants, plans, flags, country packs, model roles, budgets, config drafts, network snapshots, demo sessions |

### Approvals and the AI surfaces

- `GET /v1/inbox` lists findings and drafts waiting for a person. `GET /v1/drafts` and `/v1/drafts/{id}` show a draft,
  and `GET /v1/drafts/{id}/lineage` shows where its numbers came from.
- `POST /v1/drafts/{id}:approve` and `:reject` take a `drafts.approve.v1` or `drafts.reject.v1` command. Approval runs
  authority on the final payload, re-runs the snapshots the draft is based on, and executes the command as the approver
  in one transaction. A person may edit numeric leaves; each edit is recorded as `{value, typed_by}`.
- `POST /v1/ask` takes `{question, thread_id?}`. A leading `@Name` addresses a specialist. The response is
  `{thread_id, turn, answer}` where the answer is segments with refs, or an abstention.
- `GET /v1/specialists` lists the team. `GET /v1/specialists/{id}` is a desk page with open findings, drafts and a track
  record that is itself snapshot refs.
- `POST /v1/investigations`, `{id}:continue`, `{id}:approve-plan` and `{id}:cancel` drive an investigation in Step, Plan
  or Auto mode. `GET /v1/ai/policy` and `POST /v1/ai/policy/ceiling|cap` set the per-role mode ceilings and the monthly
  AI cap (owner only).
- `POST /v1/rfq-requests` records a person's request for quotes and starts the negotiation with simulated suppliers.
- `POST /v1/snapshots` lets a member mint an allow-listed template; `GET /v1/snapshots/{id}` returns its rows. This is
  what a source chip opens.
- `GET /v1/traces/{run}` returns the trace events of a run, in order.

## Errors

Every error body has one shape. `message` is chosen by core from a fixed table keyed by `code`; it is never an exception,
a SQL error or model output.

```json
{ "error": { "code": "stale_draft", "message": "This proposal is out of date: the numbers it relied on have changed.", "reason_code": null } }
```

Storefront refusals add `params` (ids and core-computed amounts, never text). Draft decisions add `changes` and `refs`.

| HTTP | `code` |
|---|---|
| 400 | `bad_request` |
| 401 | `unauthenticated` |
| 403 | `forbidden`, `book_write_refused`, `override_refused`, `decision_refused`, `command_table_mismatch` |
| 404 | `not_found` |
| 413 | `bad_request` (a body over its cap) |
| 409 | `conflict`, `country_locked`, `illegal_transition`, `customer_erased`, `period_closed`, `loyalty_refused`, `sequence_gap`, `investigation_refused`, `idempotency_conflict`, `already_decided`, `stale_draft`, `chart_incomplete` |
| 422 | `currency_mismatch`, `books_unbalanced`, `claim_quote_mismatch`, `out_of_pack_scope`, `command_type_mismatch`, `invalid_payload`, `unregistered_command_type`, `cannot_verify`, `execution_failed` |
| 429 | `unavailable` with `reason_code: rate_limited` and a `Retry-After` header |
| 500 | `internal` |
| 503 | `unavailable` |

A malformed envelope or payload (valid JSON, wrong shape) is `invalid_payload`. A body that is not JSON, or a bad query or
path value, is `bad_request`. The database refusals `MB001` to `MB015` map to codes as listed in
[`data-model.md`](./data-model.md).

### Reason codes

`reason_code` is a stable machine key, never renamed or removed. The full list is `REASON_CODES` in
[`packages/contracts/src/shared/reason-codes.ts`](../packages/contracts/src/shared/reason-codes.ts). By meaning:

| Meaning | Examples |
|---|---|
| An answer could not be verified | `unresolved_ref`, `cross_tenant_ref`, `quote_mismatch`, `missing_ref`, `number_grammar`, `stale_draft` |
| The evidence a specialist needs is missing | `recipe_missing`, `cost_price_missing`, `count_missing`, `expiry_missing`, `ticket_times_missing`, `bank_lines_missing`, `settlements_missing`, `attendance_missing`, `log_coverage_missing`, `signal_source_missing`, `insufficient_history`, `forecast_stale`, `consent_record_missing` |
| A deal review rule failed | `budget_exceeded`, `budget_missing`, `margin_below_floor`, `moq_exceeds_need`, `open_commitment_overlap`, `payment_terms_worse` |
| The request is out of policy | `not_a_certificate`, `no_marketing_consent`, `payroll_out_of_scope`, `specialist_needed`, `recently_rejected`, `mode_above_ceiling`, `cap_above_platform_budget`, `model_blocked`, `authority_denied` |
| A shopper's order was refused | `window_full`, `outlet_paused`, `item_sold_out`, `deal_rejudged`, `deal_changed`, `coupon_invalid`, `coupon_expired`, `coupon_min_spend`, `coupon_cap_reached`, `change_window_closed`, `pickup_time_outside_window`, `preview_total_changed` |
| A book rule applied | `price_above_mrp`, `expired_batch`, `period_closed`, `buyer_identity_required`, `tax_id_missing`, `unknown_tax_class`, `duplicate_invoice`, `reason_required`, `refund_first`, `cash_below_rounding` |
| Munim Cares | `cares_not_enabled`, `cares_city_mismatch`, `recipient_ineligible`, `listing_expired`, `qty_exceeds_on_hand`, `cooked_hold_exceeded`, `rate_limited` |
| Demo protection | `demo_protected`, `demo_only` |

## Server-sent events

`GET /v1/stream?topics=<topic>[,<topic>...]` returns `text/event-stream` (up to 10 topics). Topics:

| Topic | Who may subscribe | Events |
|---|---|---|
| `kds:<outlet id>` | A member whose outlet scope covers it | The order and kitchen outbox events that name the outlet |
| `order:<order id>` | A member in scope, the customer who owns the order, or the guest holding its token | Members: the order's outbox events. Customers and guests: `order.status` and `order.promised_at` |
| `inbox:<tenant id>` | An owner or manager of that tenant | `inbox.draft`, `inbox.finding`, `inbox.investigation` |
| `trace:<run id>` | A member whose outlet scope covers the run (a tenant-wide run: owner, advisor or judge only) | `trace.<kind>` events in sequence |

- Each event is `data: {"id", "type", "data"}`. The stream starts with `event: ready`, sends a `: hb` comment every 20
  seconds, and ends with `event: reconnect` before the server's maximum age (55 minutes by default).
- The `id:` line is a cursor. Send it back as `Last-Event-ID` to resume. A cursor from another kind of subscriber is
  `400`. Customers and guests get a count-based cursor, so they never see the merchant's event volume.
- Any topic the caller may not read makes the whole request `404`, the same as "does not exist".
- A notification only wakes the feed; the feed re-reads under the subscriber's own row-level security. Browsers use
  fetch-based SSE (`packages/sdk/src/stream.ts`) so the bearer token travels in a header.

## Internal API

`/internal/intel/v1` is intel's only write path ([`internal.json`](../packages/contracts/generated/openapi/internal.json)):
`events:claim` and `watch:claim` (dedupe), `snapshots`, `findings`, `drafts`, `answers`, `traces:batch`, `spend`,
`run-frame`, `brief-items`, `model-roles`, `graph:query` (one of five core-owned SQL templates over the Postgres graph
tables), and idempotent batch writes for entities, aliases, chunks, claims, edges, embeddings, wiki pages, forecasts and
supplier quotes. Core takes the tenant and outlet scope from the run token alone,
validates every payload (a draft's numeric leaves must be refs, a finding or answer must pass cite-or-abstain), and
stores abstentions in place of anything that fails.
