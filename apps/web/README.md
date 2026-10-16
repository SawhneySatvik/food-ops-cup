# Cobnut Bakehouse (apps/web)

A pickup-ordering shop and the staff screens for **Cobnut Bakehouse**, a synthetic bakery with two outlets in
Lucknow, built on Munim's API with `@munim/sdk`. Next.js 16 (App Router), TypeScript, Tailwind v4.

> **Sample data.** Cobnut Bakehouse, its outlets, people, orders, suppliers and donation recipients are invented.
> Suppliers and recipients are simulated. Payments are recorded, never processed.

- **The shop** (`/`, `/o/[outletId]`, checkout, order tracking, `/cares`, `/story`): menu, a server-priced cart,
  pickup times, guest checkout, live order status.
- **Staff screens** (`/staff`): the till, the kitchen display, owner home and the approvals inbox, Ask Munim,
  Munim Cares and Suppliers. Every number Munim's AI shows has a source chip that opens the rows it came from, or
  says "Cannot verify". Nothing changes the books until a named person taps Approve.

The site talks to one of two backends:

- **the in-app mock** (`mock-server/`, served at `/mock/v1/*`) for development and tests;
- **Munim's API** on the site's own origin (`/api/*`, rewritten to `MUNIM_API_ORIGIN`) in production.

## Environment

| Variable | When it is read | Meaning |
|---|---|---|
| `NEXT_PUBLIC_MUNIM_API` | build | `/mock` (in-app mock) or `/api` (Munim's API on this origin) |
| `NEXT_PUBLIC_MUNIM_STOREFRONT_KEY` | build | Cobnut's storefront key (public by design). The mock's is in `.env.example`; the Cobnut world seed writes the real one to the run dir |
| `NEXT_PUBLIC_MUNIM_MOCK_CONTROLS` | build | `1` shows the mock's test controls. Only with the mock |
| `MUNIM_MOCK` | server | `1` serves `/mock/v1/*`; otherwise those routes answer 404. Production never sets it |
| `MOCK_TOKEN_SECRET` | server | optional: signs the mock's guest tokens |
| `MUNIM_API_ORIGIN` | build and server | `/api/:path*` is rewritten to `${MUNIM_API_ORIGIN}/:path*` (the deployed core-api, or `http://127.0.0.1:8787`, core-api's default port, locally). Unset: no rewrite |
| `MUNIM_DEMO_SIGNIN` | server | `1` turns on the demo picker's sign-in route, `POST /staff/demo-session`; otherwise it answers 404 |
| `MUNIM_DEMO_TENANT_ID` | server | the Cobnut tenant the picker signs into. Point it at a freshly seeded tenant to reset the demo |
| `MUNIM_IDP` | server | how the picker signs a person in, as core-api verifies them: `identity-platform` (Identity Platform's password grant) or `local` (a tokens file, development only) |
| `MUNIM_IDP_WEB_API_KEY` | server | with `MUNIM_IDP=identity-platform`: the Identity Platform web API key (public by design, restricted to that API) |
| `MUNIM_DEMO_PASSWORD` | server, secret | the one password of the four demo accounts (`<key>@cobnut-demo.invalid`) |
| `MUNIM_DEMO_TOKENS` | server | with `MUNIM_IDP=local`, the route reads the token from this JSON file `{"owner": "…", "manager": "…", "counter": "…", "kitchen": "…"}` instead of calling an IdP |

The secrets are set in the host's settings, never in a committed file. The route never logs a token or the password.

## The demo people

`/staff/sign-in` offers four invented people. Anyone can sign in as them; every screen then says "Sample data", and
the audit log records the person chosen.

| Key | Name | Role | Outlets | Starts on |
|---|---|---|---|---|
| `owner` | Nandini Mehrotra | owner | both | `/staff/home` |
| `manager` | Farah Qureshi | manager | Cobnut Gomti Nagar | `/staff/home` |
| `counter` | Imran Siddiqui | staff | Cobnut Hazratganj | `/staff/counter` |
| `kitchen` | Kavya Tandon | staff | Cobnut Hazratganj | `/staff/kitchen` |

On the mock each person has a public mock token (`lib/munim/session.ts`). On the real API the picker calls
`POST /staff/demo-session {"person": "<key>"}`, which returns `{token, tenant_id}`; the browser then proves both with
`GET /v1/me`. The IdP's token lasts about an hour; after that the site signs the person out.

## Develop on the mock

From the repo root (pnpm workspace):

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
cd apps/web && node_modules/.bin/next dev -p 4320   # http://localhost:4320
```

The mock keeps its books in memory, per server process, seeded from the clock. A second server instance has its own books, which is why production never runs it.

## Develop against a local core-api

Run core-api, core-worker, intel (or its recorded stand-in) and `suppliers-sim` against your own Postgres, then seed the
Cobnut world with `node tools/worldgen/src/cli.ts --world=cobnut`. The seed needs an operator token and
`SUPPLIERS_SIM_PUBLIC_URL`; the header of that file lists the variables. It prints the tenant id and writes the storefront
key and the demo tokens under `.run/cobnut/`. Then, in `apps/web/.env.local`:

```bash
NEXT_PUBLIC_MUNIM_API=/api
MUNIM_API_ORIGIN=http://127.0.0.1:8787
NEXT_PUBLIC_MUNIM_STOREFRONT_KEY=<the key the seed wrote>
NEXT_PUBLIC_MUNIM_MOCK_CONTROLS=
MUNIM_MOCK=
MUNIM_DEMO_SIGNIN=1
MUNIM_IDP=local
MUNIM_DEMO_TOKENS=<the tokens file the seed wrote>
MUNIM_DEMO_TENANT_ID=<the tenant id it printed>
```

The browser only ever calls this site's origin, so there is no CORS to set up; the live order and kitchen streams
pass through the rewrite as fetch-based server-sent events with the bearer token.

## Where things are

| Path | What it holds |
|---|---|
| `app/(shop)/` | The shop: `/`, `/o/[outletId]`, checkout, the order tracker, `/cares`, `/story` |
| `app/staff/` | The staff screens: `sign-in`, `home`, `counter`, `kitchen`, `inbox`, `ask`, `investigations`, `office`, `suppliers`, `purchase-orders`, `cares`, `campaigns`, `storefront`; `demo-session/route.ts` is the demo sign-in |
| `app/mock/` | The in-app mock's route (`/mock/v1/*`); its data and handlers are in `mock-server/` |
| `components/`, `components/staff/` | The shop and staff components, including the source chip (`staff/source.tsx`) that opens a snapshot's rows |
| `lib/munim/` | The client layer over `@munim/sdk`: sessions, commands, streams, copy, and the helpers each screen uses |
| `lib/server/demo-session.ts` | The server-side demo sign-in (Identity Platform's password grant, or a local token file) |
| `next.config.ts` | The `/api` rewrite, the standalone output for the container build, and the security headers |

`next.config.ts` sets a `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`),
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy` on every response, and
`scripts/csp-check.ts` fails on a violation. The app renders no raw HTML.

## Scripts

Run them with `node_modules/.bin/…` from `apps/web` (or `pnpm --filter @munim/web <script>`).

| Command | What |
|---|---|
| `next dev` / `next build && next start` | develop / production server |
| `tsc --noEmit`, `eslint` | typecheck, lint |
| `vitest run` | unit tests: the shop (refusal copy, error parsing, tracker, pricing on the mock) and the staff screens (refs and "Cannot verify", copy, who may approve which draft, the mock's member rules, the demo sign-in route) |
| `tsx scripts/smoke.ts` | storefront smoke; needs an absolute `NEXT_PUBLIC_MUNIM_API` (e.g. `http://localhost:4320/mock`) and the storefront key |
| `tsx scripts/staff-smoke.ts` | staff smoke; on the real API also `STAFF_SMOKE_TOKENS=<file {"owner", "scoped"}>`. It places and completes one counter order, so run it only against the mock or a local copy, never a shared deployment |
| `tsx scripts/nav-smoke.ts [--port=4510] [--shots=<dir>]` | the real clicks in Chromium on a production build of the mock (`next build` with `NEXT_PUBLIC_MUNIM_API=/mock`, the mock's storefront key and `NEXT_PUBLIC_MUNIM_MOCK_CONTROLS=1`): menu, checkout, the tracker after placing, Request quotes and the staff detail pages. It starts and stops `next start` itself |
| `tsx scripts/csp-check.ts [--port=4520]` | on a production build of the mock (built as for `nav-smoke.ts`), walks the shop (home, menu, cart, checkout) and the staff sign-in and owner home in Chromium; fails if a response lacks the headers `next.config.ts` sets or the browser reports a Content-Security-Policy violation |

## Art log

Every shape and icon was drawn by hand as inline SVG or CSS for this project. No icon packs, stock or third-party
art. Fonts: Fraunces and Inter (both SIL OFL), served through `next/font`.

| Date | File | What |
|---|---|---|
| 2026-10-14 | `components/art.tsx` | Hero croissant (five crescents) with hazelnut and steam curls; hazelnut mark; wordmark; category motifs (croissant, cake slice, cookie, gift box, cup) |
| 2026-10-14 | `components/icons.tsx` | Bag, plus, minus, close, clock, phone, pin, check, alert, offline, leaf, chevron, moon, pause, gift |
| 2026-10-14 | `components/ui.tsx` | Diet marks (square + circle / triangle / oval, leaf) |
| 2026-10-14 | `app/globals.css` | Section-title swash (inline SVG), scalloped doily edge (CSS gradient) |
| 2026-10-14 | `components/staff/source.tsx` | Ledger-stamp mark in the source chip (rounded square, two ruled lines) |
| 2026-10-14 | `app/staff/staff.css` | Staff pills, source and "Cannot verify" chips, ticket heads and edges (CSS only, no images) |
