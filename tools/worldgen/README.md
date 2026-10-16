# tools/worldgen

The synthetic world builder. It creates **Cobnut Bakehouse**, the demo business: a two-outlet bakery in Lucknow with a menu,
four people, simulated suppliers, simulated community-food recipients, and months of dated history. Everything is invented and
marked synthetic. It writes **only through core-api's HTTP API** (`/v1` as the demo people would, `/platform/v1` for the
operator's steps), so the seeded data passes the same guard, row-level security and audit as real data. This repository
carries the Cobnut world only, so `cobnut` is the only `--world` that runs here.

## The world

- Business: "Cobnut Bakehouse (synthetic)", India pack, INR, `Asia/Kolkata`. Outlets: Cobnut Hazratganj (tax ids, a current
  FSSAI licence) and Cobnut Gomti Nagar (no tax ids, no licence, busy by default).
- People: Nandini Mehrotra (owner), Farah Qureshi (manager, Gomti Nagar), Imran Siddiqui (staff, Hazratganj, counter) and Kavya
  Tandon (staff, Hazratganj, kitchen). Their sign-ins are `owner`, `manager`, `counter` and `kitchen`. Two more staff records
  at Gomti Nagar, Rehan Ansari and Meher Kapoor, are rostered but have no sign-in.
- Menu: 14 items in pastries, cakes, cookies, gift boxes and drinks, with variants, option groups, a morning-bake deal, and
  coupons. Prices are the in-app mock's, and a test diffs the seeded menu against `apps/web/mock-server/data.ts`.
- History and planted situations the AI layer can find: a butter-waste spike at Hazratganj; six regulars who stopped coming;
  hazelnut stock low enough that a request for quotes finds a shortfall; sourdough about to expire (a Cares donation draft);
  when the history is long enough, two months of closed shifts and bank lines and a month of half-price knots that a
  margin-fall investigation can explain.
- Suppliers are `core.supplier` rows of kind `simulated`. Two carry price lists; the three a request for quotes asks point at
  the agent cards served by `services/suppliers-sim`.

## Run

```bash
# Print the request log without a server (fake transport)
SUPPLIERS_SIM_PUBLIC_URL=http://127.0.0.1:8090 node tools/worldgen/src/cli.ts --world=cobnut --plan

# Seed a running core-api
MUNIM_API_URL=http://127.0.0.1:8787 \
SUPPLIERS_SIM_PUBLIC_URL=http://127.0.0.1:8090 \
MUNIM_SEED_TOKENS='{"owner":"<jwt>","manager":"<jwt>","counter":"<jwt>","kitchen":"<jwt>","operator":"<jwt>"}' \
  node tools/worldgen/src/cli.ts --world=cobnut
```

Flags (both `--flag value` and `--flag=value` work; anything else is refused): `--world`, `--as-of=YYYY-MM-DD`,
`--days` (14 to 400, default 183), `--live-days`, `--seed`, `--plan`. Cobnut is a **fresh tenant on every run** unless you pass
`--seed`.

- `SUPPLIERS_SIM_PUBLIC_URL` is required: the simulated suppliers' agent cards live there.
- The sign-in tokens are ID tokens from the identity provider core-api trusts. The `operator` token is needed so the
  business is provisioned as a demo business (every screen then says "Sample data") with the AI budget set; without it the
  seed refuses before writing anything.
- It prints the tenant id and the paths it wrote, never a key or a token, and writes under `.run/cobnut/` (mode 0700, files
  0600, git-ignored): `storefront-key`, `site.env` (`MUNIM_DEMO_TENANT_ID` and the storefront key for `apps/web`), and, only
  against a core-api with the local development identity provider (`MUNIM_IDP=local`), `demo-tokens.json`.

The Google Cloud runbook, `infra/gcp/README.md`, walks through the seed against a deployed core-api.

## Test

```bash
pnpm -F @munim/worldgen test        # node --test "test/*.test.ts"
pnpm -F @munim/worldgen typecheck
```

`test/cobnut.test.ts` seeds the world through a real core-api on an embedded Postgres (`test/stack.ts`) and checks the points
above: two outlets and four people, a demo business with Cares on, the menu equal to the mock's, the hazelnut shortfall, the
six lapsing regulars, and a margin-fall investigation that runs to done.

## Key files

| Path | What it does |
|---|---|
| `src/cli.ts` | Argument parsing, token handling, the files it writes |
| `src/run.ts` | Runs a world against an API or, in plan mode, a fake transport; returns the request log |
| `src/worlds/cobnut.ts` | The Cobnut Bakehouse world |
| `src/api.ts` | The HTTP client: one idempotency key and command id per write, derived from the seed |
| `src/kit.ts` | Helpers a world calls: onboard, add a person, item, price, recipe, supplier, licence, purchase order |
| `src/history.ts`, `src/files.ts` | Dated bills, waste and customers, and the shift and bank files, sent through the approved-import path |
| `src/prng.ts`, `src/ids.ts`, `src/time.ts` | Seeded randomness, deterministic ids, business-date helpers |
| `src/dry.ts` | The fake transport for plan mode |
