# Security

This page states what Munim protects, who might attack it, and where each defence lives. Every defence names a file, a
table or a test you can read. All data is synthetic, suppliers are simulated and payments are recorded, never processed.

## What is protected

1. **The books.** Nothing changes them without a named person's approval (the One Guarantee).
2. **Tenant isolation.** One business must never read or write another's rows, or learn that another exists.
3. **Truthful numbers.** A number a person reads comes from a snapshot cell, not from model text.
4. **Secrets.** Keys, passwords and tokens never reach a log, a trace, an error, a client or a repository.

## Threat model

| Threat | Control | Where to read it |
|---|---|---|
| The AI writes to the books | intel has no database client; `munim_svc` has no write grant on any of the 105 book tables; the book-guard trigger admits only a person's command, an approved decision or an allow-listed derivation | `pyproject.toml` (import-linter contract), `db/tests/grants.test.ts`, `db/tests/guard.test.ts` |
| A role gains write access by mistake | The grants test counts: `munim_intel_ro` is refused insert, update, delete and truncate on 170 of 170 tables and can execute no function; `munim_svc` has insert or update on 0 of 105 book tables. Each assertion has a red-proof that plants a grant and expects failure | `db/tests/grants.test.ts` |
| A tenant reads another's rows | Forced row-level security on every tenant table; context only from `SET LOCAL`; no context returns zero rows; cross-tenant writes fail `WITH CHECK` | `db/tests/isolation.test.ts`, `services/core-api/test/auth-rls.test.ts` |
| A forged or replayed run token | Ed25519 signature, claims schema, expiry, and a live `intel.run` row for the token's tenant; every refusal looks the same | `services/core-api/src/runtoken/runtoken.test.ts`, `services/intel/tests/test_runtoken.py` |
| The model types or invents a number | Number grammar and cite-or-abstain in core; the same grammar in intel with a parity test; draft numbers must be refs | `packages/core-domain/envelope/`, `services/core-api/test/envelope.test.ts`, `services/intel/tests/tools/test_grammar_parity.py` |
| A model cites another tenant's row | The ref resolver is closed over the run token's tenant; `cross_tenant_ref` abstains | `packages/core-domain/envelope/validator.ts`, `packages/core-domain/test/validator.test.ts` |
| Prompt injection through a supplier reply or document | Untrusted text goes only to a tool-less extractor; the run is tainted; a tainted run cannot propose a draft; traces hold labels only | `services/intel/munim_intel/ingest/quarantine.py`, `services/intel/tests/negotiate/test_negotiate_grounding.py` |
| A duplicate or replayed command | Idempotency key plus request hash in `core.command_log`; approval is a conditional status update with one winner | `services/core-api/src/commit/commit.test.ts`, `services/core-api/test/approvals.test.ts` |
| A stale approval | `based_on` snapshots re-run at approval; a changed number marks the draft stale and nothing executes | `services/core-api/test/approvals.test.ts` |
| Tampering with the audit trail | Per-tenant hash chain with a gapless sequence; no `DELETE` or `UPDATE` grant | `db/tests/audit-notify.test.ts` |
| A real supplier slips into the negotiation | Checked before sending (row kind, card origin, card name) and again by a composite foreign key and a check constraint | `services/intel/tests/negotiate/test_negotiate_simulated.py`, `db/tests/intel.test.ts` |
| Abuse of public routes | Body caps, cart caps, per-address rate limit on the credential-free routes, a cap on self-serve businesses per sign-in, exact-origin CORS | `services/core-api/test/security-c2.test.ts`, `services/core-api/test/cors.test.ts`, `services/core-api/test/cares-network.test.ts` |
| A staff member reaches a template above their role | A run started by a member mints only templates at or below that member's current role, read at mint time | `services/core-api/test/security-c2.test.ts` |
| Browser attacks (injection, framing) | A strict `Content-Security-Policy` and companion headers on every response; no raw-HTML rendering anywhere in `apps/web` | `apps/web/next.config.ts`, `apps/web/scripts/csp-check.ts` |

## Who can act

| Actor | Identity | Reach |
|---|---|---|
| Staff and owners | Identity Platform ID token and `X-Munim-Tenant` | `/v1` as the role and outlets in `core.membership`. Roles never come from token claims. |
| Customers | Storefront key and an optional customer token | Their own orders and profile |
| Guests | Storefront key and a guest token for one order | That order only, read-only. The token is returned once; only its SHA-256 is stored. |
| Operators | Identity Platform token for a `platform.operator` row | `/platform/v1` only |
| intel | Service secret and a run token | `/internal/intel/v1` for the run's tenant and outlets |
| Anonymous | Nothing | `/health` and the rate-limited public Cares reads |

Tokens are verified against Google's published keys with `node:crypto` (`services/core-api/src/auth/jwt.ts`). Only RS256,
ES256 and EdDSA are accepted; `alg: none` and shared-secret algorithms are refused before any key lookup. A bad token is
`401`. An unknown tenant, storefront key or profile is `404`, and a storefront key is compared by hash, so lookup time
reveals nothing about the key.

## Row-level security and grants

- Every table with a `tenant_id` has row-level security enabled **and forced**, and `tenant_id` leads its keys. The
  runtime roles are `NOSUPERUSER NOBYPASSRLS` and own no tables, so there is no owner bypass. `db/tests/isolation.test.ts`
  runs as tenant A and expects at least one row of its own and none of tenant B's in every tenant table, and the reverse.
- Context is set with `SET LOCAL` inside the transaction, never at session level, so a pooled connection cannot leak it.
  An empty context returns zero rows.
- Every table has an explicit revoke-then-grant block. Default privileges and function `EXECUTE` are revoked from
  `PUBLIC`. The one `BYPASSRLS` role owns a short, asserted list of objects (`CROSSTENANT_OBJECTS`).
- No runtime role has `DELETE` or `TRUNCATE` anywhere. Corrections are reversals or voids with a reason and an actor.
- Customers and guests also face restrictive policies (`customer_scope`, `guest_scope`) so a shopper sees only their own
  order and the rows reachable from it.

## Run tokens and service secrets

Run tokens are Ed25519 JWTs minted only by core-api. intel holds only the public key. Lifetimes are 15 minutes for an ask,
30 for an ingest and two hours for events, sweeps, briefs and Auto investigation steps. Core checks the signature, the
claims, expiry and the `intel.run` row on every internal call, and takes tenant and outlet scope from the token alone.
Internal routes also need the service secret, which both sides compare in constant time. Neither is ever logged.

## Untrusted text

Supplier replies and documents are untrusted. They reach exactly one place: a model call with no tools and a JSON response
schema, on the `extract` role, wrapped as untrusted. That call spends the run's budget and taints the run. The extractor's
typed fields must each be grounded in the reply text, and a number no field claims drops the quote. A tainted run keeps its
`propose_*` tools bound, but the plugin refuses each call. The model's note to a supplier is also checked for numbers, and
code renders every number in the message.

## Errors, traces, logs

- An error body is `{error: {code, message, reason_code}}`. `message` comes from a fixed table keyed by `code`
  (`services/core-api/src/lib/errors.ts`). SQL, driver and model text are logged redacted and never returned. A database
  refusal is mapped from its SQLSTATE (`MB001` to `MB015`) and its text is not used.
- Trace payloads are labels. A database check refuses a payload with a non-snake_case key or a string over 200 characters,
  and intel raises rather than ship prose.
- NOTIFY payloads are ids only. A stream re-reads under the subscriber's own row-level security, so a forged notification
  delivers at most what that subscriber could already read.
- SSE needs a bearer token in a header (fetch-based SSE), because a browser `EventSource` cannot send one.

## Secrets handling

- One config module per language (`packages/config`, `munim_intel.config`) reads the environment, registers every secret
  value (provider keys, database URLs, role passwords) and redacts it from errors and logs. The tests never read an
  environment file; they pass values in directly.
- On Google Cloud every secret lives in Secret Manager and is mounted as an environment variable only on the services that
  need it. Each service runs as its own service account with only its own `secretAccessor` bindings. The database role
  passwords are random, set by `db/scripts/bootstrap-roles.ts`, and rotated by running it again.
- Docker builds use allow-list `.dockerignore` files, one per service (`infra/gcp/docker/*.dockerignore`), so an
  environment file, a local run directory or a key never enters an image.
- The Cloud SQL instance has a public address with no authorised networks. It is reached only through Cloud Run's built-in
  connection and Cloud SQL's auth proxy, both IAM-gated, and is set to refuse unencrypted connections
  (`--ssl-mode=ENCRYPTED_ONLY`).
- The demo password is held in Secret Manager and read only by the web service. `POST /staff/demo-session` runs Identity
  Platform's password grant on the server, so neither the password nor the web API key reaches a browser. Demo sign-in is
  off unless `MUNIM_DEMO_SIGNIN=1`.
- The storefront key is public by design: it only resolves a tenant and channel for the storefront routes. Only its hash is
  stored, and an owner can revoke it (an audited action the demo business refuses).

## Edge protections

- **Body caps:** 256 KiB by default, 8 MiB for document upload, 16 MiB for intel's batches. Over the cap is `413`.
- **Cart caps:** at most 100 lines, 20 options a line and bounded quantities on the storefront and the till.
- **Rate limit:** the credential-free Cares routes allow 60 requests a minute per client address, per instance, and answer
  `429` with `Retry-After`; the storefront's Cares section has the same limit, per address and per address and storefront
  key. The client address comes from the socket unless `MUNIM_TRUSTED_PROXY_HOPS` is set.
- **CORS:** exact origins from `MUNIM_CORS_ORIGINS`, only on `/v1/storefront`, `/v1/stream` and `/v1/cares-network`.
  Credentials are headers, never cookies, so no `Access-Control-Allow-Credentials` is sent and `*` is never echoed.
- **Onboarding:** one sign-in can create at most five businesses self-serve.
- **Web headers** (`apps/web/next.config.ts`): `Content-Security-Policy` with `default-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` and a `connect-src` of this origin (plus the API's origin
  only when the build points at an absolute API URL); `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`;
  `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` that turns off camera, microphone,
  geolocation, payment, USB and display capture.
  `script-src` keeps `'unsafe-inline'` because the framework's hydration payload is inline and a static header cannot carry
  a per-request nonce. `apps/web/scripts/csp-check.ts` loads the pages in a browser and fails on a violation.
- **Public services:** `munim-intel` and `munim-suppliers-sim` accept public traffic on Cloud Run. intel checks the service
  secret on every route but `/health` and a run token on most. The simulator holds no secret and no data and bounds every
  input.

## Demo protections

The demo business is shared by every visitor, who sign in as the same four people. Once the demo business is onboarded,
core refuses the few commands that would break it for the next visitor: revoking a storefront key, inviting, re-roling or
deactivating a member, changing the monthly AI cap, and publishing a storefront page. The answer is
`403 forbidden` with `reason_code: demo_protected` (`services/core-api/src/lib/demo-guard.ts`). Every other action works and
is audited under the person chosen. Every staff screen on the demo says "Sample data". A monthly AI budget per business
keeps live model spend bounded, and the kill switch (`intel.enabled`) turns AI off.

## Known limits

- The rate limiter is per instance, so N instances admit N times the limit. The deployment runs one core-api instance.
- Draft, finding and investigation streams have no commit-ordered column. A change that commits while a client is
  disconnected and behind its cursor, or in a transaction open longer than the look-back, is not replayed. The client
  re-reads the list after reconnecting.
- `MUNIM_TRUSTED_PROXY_HOPS` is unset in the deployment, so limiter keys use the socket address until a hop count is
  measured. Behind Cloud Run that means clients may share a bucket.
- Rules in the country packs are data, and entries carry `_unverified` markers where the source was secondary. They are not
  legal or tax advice.
- Document and invoice ingestion exist as library code and are not reachable from a route in this build.
