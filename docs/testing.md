# Testing

A test that cannot fail proves nothing, so every gate here has a positive expected quantity that comes from somewhere other
than the code under test, and the important gates have a red-proof: a test that plants the defect and expects the gate to
go red. This page says how to run the tests, what each group proves, and how the AI layer is tested without a model.

## Run them

Node 22.18 or later (it runs TypeScript directly), pnpm 11, Python 3.12 with uv. No Docker, no cloud account and no
environment file are needed.

```bash
pnpm install --frozen-lockfile
pnpm -r run typecheck
pnpm -r run test
uv run --locked --directory services/intel --with pytest==9.1.1 pytest -q
uv run --locked --directory services/suppliers-sim --with pytest==9.1.1 pytest -q
node_modules/.bin/depcruise --config .dependency-cruiser.cjs --output-type err apps services packages adapters tools
```

- `pnpm -r run test` runs vitest in each package (and `node --test` in `tools/worldgen`). Database tests start an embedded
  Postgres 18 from the `embedded-postgres` package, apply the migrations, and run on a real server. The database is never
  mocked, because row-level security is the thing under test.
- The first run of `packages/contracts` fetches `pydantic` through `uv` for the round-trip test.
- The import-boundary check for Python is import-linter, configured in `pyproject.toml`
  (`PYTHONPATH=services/intel:services/suppliers-sim uvx --from import-linter==2.15 lint-imports --no-cache`).
- Next.js: `(cd apps/web && node_modules/.bin/next build)`.
- `.github/workflows/ci.yml` runs the install, the type checks, the TypeScript import-boundary check, the tests, the web
  build and both Python suites on every push, with `MUNIM_MODEL_MODE=recorded` and no secrets.
- The database gates alone: `pnpm -F @munim/db test`.

## Recorded models

Every test runs with `MUNIM_MODEL_MODE=recorded`, the default. A model call is served from a committed fixture in
`services/intel/fixtures/recorded/`, keyed by a SHA-256 of the canonical request (model, system text, contents, tool
declarations, output schema, with UUIDs replaced by positional placeholders so a fresh run id hits the same fixture).

- A missing fixture is an error that names the key. It never falls through to a live model.
- `services/intel/tests/conftest.py` blocks the network and any read of an environment file in every test. A recorded
  fixture miss fails its test even if the code under test swallowed the exception, unless the test is marked
  `fixture_miss_expected` (this is what proves the degrade paths). `tests/test_fixture_guard.py` runs the guard over four
  tiny tests to show it can fail.
- `tests/test_lockfile.py` fails unless `uv.lock` holds `google-adk` at exactly 2.11.0, and fails if it holds `litellm` or
  one of ADK's forbidden extras.
- `scripts/dev/intel-stub.ts` is a recorded stand-in for intel that the TypeScript tests start.

## What each group proves

### Database (`db/tests/`)

The hand-written manifest `db/tests/manifest.ts` lists every table, its tag, and whether it carries a tenant and outlet
policy. The tests compare the live catalog to it in both directions.

| File | Proves |
|---|---|
| `migrate.test.ts` | The runner applies the files in order, refuses a changed applied file, skips `0013_embeddings.sql` loudly where the extension is missing |
| `grants.test.ts` | Role attributes (only `munim_crosstenant` bypasses row-level security; nobody is a superuser; no runtime role owns a table); `munim_intel_ro` has no write on 170 of 170 tables and no function; `munim_svc` has no write on 105 of 105 book tables; the `SECURITY DEFINER` list is exact; no `DELETE` or `TRUNCATE` for any role |
| `guard.test.ts` | Every book table refuses a context-free write with `MB001` (expected count 105); the three admitting branches; outlet and tenant scope; a replayed decision id is refused; the superuser gets no bypass |
| `isolation.test.ts` | Row-level security is enabled, forced and has a policy on every tenant table; tenant A sees its own rows and none of B's in every table, and the reverse; no context returns zero rows; outlet-scope and parent-scope policies |
| `books.test.ts` | Country and currency lock, currency triggers on every currency column, duplicate supplier invoice, single minter for a snapshot, numeric-source allow-list, customer erasure, pack seed |
| `finance.test.ts`, `orders.test.ts`, `loyalty.test.ts` | Journal balance and period close, order transitions, loyalty rules |
| `audit-notify.test.ts` | The audit chain is gapless under 20 concurrent writers; tampering and deletion are detected; NOTIFY carries ids only and nothing on rollback |
| `intel.test.ts` | A claim's quote must be its source span; quotes only from simulated suppliers; trace sequence and label checks |
| `binding.test.ts` and the numbered files | Command-to-table binding and each later migration's own rules |

### Red-proofs

Many database tests are named `RED-PROOF: ...`. Each one applies a defect inside a clone of the test database and expects
the gate to fail. Examples from `grants.test.ts`: grant `INSERT` on a book table to `munim_svc` and the book-grant gate must
go red; grant `EXECUTE` on one function to `munim_intel_ro` and the function count must change. From `isolation.test.ts`:
`NO FORCE ROW LEVEL SECURITY` on `core.price` must fail the catalog gate; a `USING (true)` policy must fail the "none of B's
rows" half; dropping a policy must fail the "at least one own row" half, because a forced table with no policy is deny-all
and would otherwise look green. From `guard.test.ts`: dropping the trigger on `core.deal` must let a context-free write
through. `services/core-api/src/commit/commit.test.ts` has the same pattern for idempotency and the outbox.

### core-api (`services/core-api/test/`, `src/**/*.test.ts`)

Most files drive the real Hono app over an embedded database, with a local identity provider and no model.

- Auth and tenancy: `auth-rls.test.ts`, `tenancy.test.ts`, `shopper.test.ts`, `cors.test.ts`, `security-c2.test.ts` (demo
  protection, role limits on templates, body and cart caps, onboarding cap).
- Orders and shop: `orders.place.test.ts`, `orders.lifecycle.test.ts`, `orders.au.test.ts`, `storefront*.test.ts`,
  `kitchen.test.ts`.
- Books and operations: `finance-*.test.ts`, `inventory*.test.ts`, `purchasing.test.ts`, `people.test.ts`,
  `compliance.test.ts`, `imports*.test.ts`.
- Approvals and the AI boundary: `approvals.test.ts` (one winner, stale drafts, authority on the final payload),
  `intel-*.test.ts` (the internal routes), `envelope.test.ts`, `threads.test.ts`, `investigations-*.test.ts`, `rfq.test.ts`,
  `specialists.test.ts`.
- Streams and events: `stream.test.ts`, `publisher-http*.test.ts`, `src/runtoken/runtoken.test.ts`,
  `src/commit/commit.test.ts` (idempotency replay, audit verification, outbox).
- Munim Cares: `cares*.test.ts`.

### Contracts and domain

- `packages/contracts/test/stale.test.ts`: the recorded stamp equals a fresh digest of the generator's inputs and outputs, so
  a stale or hand-edited generated file fails.
- `count.test.ts`: the number of generated JSON Schemas equals the sum of a hand-kept `MANIFEST.d/` list.
- `roundtrip.test.ts`: every schema's sample goes zod, then the generated Pydantic model, then zod again, and must equal the
  original.
- `routes.test.ts`: no two routes share a method and path or an operation id.
- `guarantee.test.ts`: a draft proposed by intel cannot carry a model-typed number, checked on the generated JSON Schema
  and on zod.
- `packages/core-domain/test/`: the DST suite (both `Australia/Melbourne` transitions, with `Asia/Kolkata`, which has none,
  as the control); golden receipts and tax totals for the India and Australia packs; the cite-or-abstain validator with
  forged-ref, cross-tenant-ref and free-digit cases; `country-literals.test.ts`, which scans the source for any literal that
  names a country pack (the forbidden list is built from the pack documents); `rules-parity.test.ts`, which requires every
  derivation rule this package implements to have its seeded row, and every seeded rule to be implemented here or listed as
  implemented elsewhere.

### intel (`services/intel/tests/`)

- `test_tools.py` reflects over every tool and fails if any schema names a tenant.
- `tools/test_grammar_parity.py` runs intel's number grammar and core's over one probe table.
- `trace/test_trace_plugin.py` requires every one of the 14 ADK plugin callbacks to fire at least once over a scripted run
  and three planted error runs, because a misspelt hook name is silently never called.
  `trace/test_trace_core_roundtrip.py` sends real trace batches into core.
- `manager/`, `fanout/`, `decide/`, `context/`: routing (six intents onto four paths), fan-out limits, context assembly,
  over-cap and live-fallback behaviour.
- `negotiate/`: the rule policy, the chooser, extraction grounding, deal review, the simulated-only check, and the route.
- `watch/`, `brief/`, `investigate/`, `packs/*`: detectors, narration, the brief and the specialists' skills, offline
  (`packs/test_skills.py` checks that all eight skills share one shape).
- `test_runtoken.py`, `test_internal_client.py`, `test_config.py`: token verification, the client, secret redaction.

### Web (`apps/web/tests`, `apps/web/scripts`)

Vitest unit tests cover the shop and the staff screens: refusal copy, source chips and "Cannot verify", who may approve
which draft, the demo sign-in route. `smoke.ts` and `staff-smoke.ts` drive the storefront and staff API clients against the
in-app mock (or a real core-api). Two scripts run in a browser against a production build: `nav-smoke.ts` (real client
navigation, because a direct page load would not catch a cached-shell bug) and `csp-check.ts` (the security headers, and no
Content-Security-Policy violation on the pages).

### World

`tools/worldgen/test/cobnut.test.ts` seeds the Cobnut Bakehouse world through a real core-api and checks it: two outlets,
four people, a demo business with Cares on and simulated suppliers; the storefront menu equals the in-app mock's menu at
both outlets, in order; hazelnut stock is low enough that a request for quotes finds a shortfall; six regulars have stopped
coming, enough for the watcher to fire; and a margin-fall investigation runs to done.

## What is not covered

- The live models. No test calls a live model; the only live check is the manual smoke script
  `services/intel/tests/live/smoke_live.py`.
- The Google Cloud deployment itself. The adapters in `adapters/gcp` are tested against local stand-ins for the Google APIs
  (a local HTTP server or an injected fetch). Two scripts run by hand, outside CI and `pnpm -r run test`, with no Google
  calls: `bash infra/gcp/test/deploy-gcp.test.sh` runs `scripts/deploy-gcp.sh` against a stub `gcloud`, and
  `uv run python infra/gcp/test/cloudbuild-deploy.test.py` (it needs PyYAML, which `uv.lock` carries) runs the
  continuous-deployment build's steps against stub `docker`, `gcloud` and `curl`. It checks that the images the build pushes
  are the images the script deploys, and that a missing tenant id, a missing commit or a database behind the commit's
  migrations is refused. A real deploy follows the runbook in `infra/gcp/README.md`.
