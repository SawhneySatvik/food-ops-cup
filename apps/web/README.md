# Cobnut Bakehouse

**Live:** https://cobnut-bakehouse.example.app (runs on its built-in mock; Mock controls panel enabled for testing)

A pickup-ordering storefront for **Cobnut Bakehouse**, a synthetic bakery with two outlets in Lucknow, built on
**Munim's storefront API** with **Munim's TypeScript SDK** (`@munim/sdk`). Next.js 16 (App Router) + TypeScript +
Tailwind v4.

> **Sample shop — orders are not real.** Demo: all data is synthetic. Payments are recorded, never processed.
> Cobnut Bakehouse, its outlets, phone numbers, tax ids, orders and donation recipients are all invented. It is
> not affiliated with any real bakery.

The same app also carries the **bakery's own staff screens** at `/staff` (the till, the kitchen display, owner home
and the approvals inbox, Ask Munim, Munim Cares and Suppliers), built from the second spec pack against the member half
of the same mock. See [Staff screens](#staff-screens).

Shoppers browse the menu, build a cart (including cakes with a piped message and build-your-own gift boxes), see a
**server-priced** preview, pick a pickup time, check out as a guest, place the order, follow it live, and see the
bakery's Munim Cares donations. Payment happens at the counter and is only recorded there.

## Run it

Node 20 or newer.

```bash
npm install                      # also installs @munim/sdk from Munim's tarball URL (integrity pinned in the lockfile)
cp .env.example .env.local
npm run dev                      # http://localhost:3000
```

| Script | What |
|---|---|
| `npm run dev` / `npm run build && npm start` | Develop / production (`next build && next start` runs unchanged on Cloud Run; no platform-only APIs) |
| `npm run smoke` | The storefront smoke test (needs absolute env vars, see below) |
| `npm run staff-smoke` | The staff smoke test: `NEXT_PUBLIC_MUNIM_API=http://localhost:3000/mock npm run staff-smoke` |
| `npm test` | Unit tests (47): storefront (refusal copy, error parsing, tracker copy, phones, attempts, mock pricing) and staff (refs and "Cannot verify", staff copy, kitchen news, Cares gate, the mock's member rules: roles, Cares approval, hand-over limits, PO approval with a typed price, goods received) |
| `npm run typecheck`, `npx eslint .` | Both clean |

### Environment variables

| Variable | This app's mock (default) | Munim's public mock | Real API (later) |
|---|---|---|---|
| `NEXT_PUBLIC_MUNIM_API` | `/mock` | `https://munim-rho.example.app/mock` | the URL the founder sends |
| `NEXT_PUBLIC_MUNIM_STOREFRONT_KEY` | `sfk_mock_cobnut_bakehouse_5b1e7d40` | `sfk_mock_spice_route_7f3a91c2` | the key the founder sends |
| `NEXT_PUBLIC_MUNIM_MOCK_CONTROLS` | `1` (shows the test panel) | `1` | unset |
| `MOCK_TOKEN_SECRET` | optional: signs the mock's guest tokens | – | – |

The mock keys are public test keys. Real keys never go in the repo. Switching to the real API is two env vars and
no code changes. Send the site's origin to the founder for the CORS allow-list.

## How it is built

```
app/                       routes (thin server files) + /mock/v1/[...path] route handler
components/pages/*.tsx     client pages: home, menu, checkout, tracker, cares, not-valid
components/                ui.tsx, cart-bits.tsx, chrome.tsx (demo bar + footer), art.tsx + icons.tsx (hand-drawn SVG)
lib/munim/                 the API layer on top of @munim/sdk (client, checkout, copy, format, storage, track, cares)
lib/site.ts, lib/hooks.ts  bakery constants (categories, deal labels, diet words, note fields); cart/preview/countdown hooks
mock-server/               the stand-in backend: data, pricing, windows, signed-token orders, HTTP handler
scripts/smoke.ts           smoke test;   tests/   unit tests;   docs/screenshots/   every state at 390 / 1280 px
```

**SDK integration.** `lib/munim/client.ts` wraps the SDK's typed `GET`/`POST` (paths and bodies are checked
against the contract) into the `Result<T>` / `MunimError` shape from 01-api-client.md. It adds `cache: "no-store"`,
a 15 s timeout, the guest token per call and the dev test headers, and it drops the server's `message`. Live
tracking uses the SDK's fetch-based `openStream` (no `EventSource`); ids use the SDK's `uuidv7`. Every other helper
(format, copy, checkout, storage, track, cares) is the spec's code. API types come from the SDK's bundled contract
types, so the in-app mock's responses are also type-checked against the contract.

**The mock.** Munim's public mock only has Spice Route and Laneway Cafe, so `mock-server/` serves a bakery over the
same paths, shapes, errors and switches (`X-Mock-Force-Accepting`, `X-Mock-Force-429`). On serverless hosts each
request can land on a different instance, so the order record travels inside an HMAC-signed guest token (order
data only, never the shopper's details). Any instance can then answer reads and the SSE stream. Replays and window
bookings are per instance, as on Munim's mock.

| Mock data | |
|---|---|
| Outlets | Cobnut Hazratganj (open, phone, GSTIN + FSSAI) · Cobnut Gomti Nagar (busy +10 min, no phone, no tax ids) |
| Prices | exclude GST; 5% as CGST 2.5% + SGST 2.5%; pay at the counter: cash, card, UPI |
| Sold out | Pistachio Danish everywhere; Rose Pistachio Tres Leches at Gomti Nagar only |
| Variants / options | Hazelnut Praline Cake ½ kg / 1 kg + sponge (Classic / Eggless +₹80) + message; Build-a-Box 6 / 9 / 12 + 2–4 flavours (Kesar badam +₹60) + gift wrap; Hot Chocolate Regular / Large; Cold Coffee milk (Oat +₹40) |
| Deal | "Morning bake", Mon–Sat 08:00–11:00, on Cardamom Knot and Hazelnut Croissant (judged at the promised time) |
| Coupons | `COBNUT10` (min ₹500 after deals) · `GANJ5` (Hazratganj only) · `DIWALI25` expired · `FIRST50` cap reached · anything else invalid |
| Orders | placed → accepted (45 s) → preparing (75 s) → ready (110 s) |

## Results

**Smoke test** (`scripts/smoke.ts`, unchanged from the spec, running on the SDK-based client):

```
# against this app's mock (NEXT_PUBLIC_MUNIM_API=http://localhost:3100/mock, Cobnut key)
ok   outlets: Cobnut Hazratganj, Cobnut Gomti Nagar
ok   menu: 14 items, state open, first simple item Hazelnut Croissant
ok   preview: total ₹378.00 tax CGST 900 + SGST 900
ok   place: ticket 1, status placed
ok   replay: replayed=true, token null
ok   read order: status placed, 1 event(s)
ok   read without token is 404
ok   stream: order.status {"order_id":"…","from_status":null,"to_status":"placed",…}
ok   bad key is 404: not_found 404 not_found
ok   429 parsed: rate_limited 429 unavailable rate_limited retryAfterMs 5000
ok   stale preview total refused: refusal 409 conflict preview_total_changed
ok   network impact (404 on the mock: hide it): not_found 404 not_found
smoke: all ok
```

The same client also passes all 12 checks against Munim's own mock with the Spice Route key.

**Lighthouse (mobile, production build, local, median of 3):** menu: performance 77, accessibility 100, CLS 0;
checkout: performance 84, accessibility 100, CLS 0. The **performance ≥ 90 target is not met**. The remaining
cost is LCP (~3.6–4 s simulated) and script time. The spec requires every API call to run in the browser, so the
menu can only paint after JavaScript loads and two API calls return on simulated slow 4G. On a quiet machine one
run reached 92 / 89, but scores varied by ±15 between identical runs on this laptop. Server-fetching the menu would
fix LCP but breaks spec §3, so it needs a decision. Reports are not committed; re-run with
`npx lighthouse <url> --form-factor=mobile`.

JS budget: about 162 KB gzipped on the menu route (budget 170 KB). No images; two font families.

**Screenshots:** `docs/screenshots/<page>-<state>-<width>.png`: every page at 390 px and 1280 px, plus busy,
paused, closed, 429, recovered, offline, sold out, coupon refusals (min spend, cap, invalid, bad format), empty
cart, paused checkout, tracker without a token and not-valid. Taken with the browser timezone set to
`America/New_York` to show that times use the outlet's zone (Asia/Kolkata). None shows a key or a token.

## Staff screens

All under `/staff`, in the same app, with the same look and the same env vars (no new ones). The storefront keeps
its URLs; its pages moved into the `app/(shop)` route group so only the shop shows the site footer.

| Route | Screen | Who |
|---|---|---|
| `/staff/sign-in` | "Demo sign-in" picker (mock only) | anyone |
| `/staff/counter`, `/staff/counter/orders/[orderId]` | The till: tiles, cart rail priced by the preview, place, record cash / card / UPI (recorded only), steps, receipt; today's orders | owner, manager, staff |
| `/staff/kitchen` | Kitchen display: Now / Later lanes, station chips, one 64 px step button per ticket, "Not paid yet" check | owner, manager, staff |
| `/staff/home`, `/staff/inbox`, `/staff/inbox/[draftId]` | Owner home (figures minted as snapshots, each with a source chip) and the approvals inbox | owner, manager |
| `/staff/ask`, `/staff/ask/[threadId]` | Ask Munim: cited answers or "Cannot verify" | everyone signed in |
| `/staff/cares` | Food at risk, the AI's donation proposals, own listings, hand-overs, food shared this month | owner (all), manager (no decisions), staff (listings and hand-overs) |
| `/staff/suppliers`, `/staff/suppliers/[supplierId]`, `/staff/purchase-orders/[poId]` | Running low, PO proposals with simulated quotes (the price is always typed by the approver), own POs, goods received | owner, manager |

**Sign in on the mock:** open `/staff/sign-in` and pick one of three invented people. Their tokens are public mock
values (like the storefront key) and the tenant id is `019a0c5e-7e11-7a00-8c0b-0000000c0b17`.

| Demo person | Role | Outlets | Lands on |
|---|---|---|---|
| Nandini Mehrotra (demo) | owner | both | `/staff/home` |
| Imran Siddiqui (demo) | staff (counter) | Cobnut Hazratganj | `/staff/counter` |
| Kavya Tandon (demo) | staff (kitchen) | Cobnut Hazratganj | `/staff/kitchen` |

The Mock controls panel (bottom right) adds "Next approve" (normal / stale / already decided / can't apply) and "AI"
(normal / off / abstain) to the storefront's two switches. The till and the kitchen have "Simulate a web order".

**The mock's member half** (`mock-server/staff.ts`, `mock-server/staff-data.ts`) keeps its books in memory per server
instance, seeded from the clock on the first request. Every flow works end to end on `npm run dev`. On the deploy platform each
request can reach another instance, so a placed counter order or an approval can vanish on the next request; the
seeded day is the same everywhere, so every screen always has data. A shopper's storefront order cannot reach this
mock kitchen (it lives in the shopper's signed token); use "Simulate a web order".

**Staff smoke** (`scripts/staff-smoke.ts`, unchanged from 01, against `npm run dev`):

```
ok   me (owner): owner, outlets all
ok   me (scoped): staff, 1 outlet(s)
ok   outlets: Cobnut Hazratganj (restaurant), Cobnut Gomti Nagar (restaurant)
ok   counter channel: 2 channel(s)
ok   counter menu: 18 entries, business date 2026-10-14, first simple item Hazelnut Croissant
ok   preview: total ₹189.00
ok   place: entity is the order, status 201
ok   replay: replayed=true
ok   same key, new body is 409: key_reused 409 idempotency_conflict
ok   read order: ticket 8, placed, remaining = total
ok   board: 7 live ticket(s), ours queued, normal, lane now
ok   advance ticket: queued -> preparing
ok   live event: 1 wake-up(s) after the move
ok   stale advance is 409: invalid 409 illegal_transition
ok   tender: status preparing, remaining 0
ok   inbox: 7 item(s), 4 draft(s)
ok   draft detail: cares.listing.publish.v1, 0 unverified ref(s), 1 history row(s)
ok   approve with a wrong draft_id is 422: invalid 422 invalid_payload
ok   mint snapshot: Tickets today: 11
ok   open snapshot: 1 row(s)
ok   free digits are not shown
ok   unknown snapshot is 404: not_found 404 not_found
ok   ask: 2 segment(s), 5 cited value(s)
ok   thread: 1 turn(s)
ok   cares profile: available true, enabled true
ok   suppliers: 2 supplier(s), 2 simulated, all labelled
ok   no token is 401: auth 401 unauthenticated
ok   wrong tenant is 404: not_found 404 not_found
ok   board outside scope is 404: not_found 404 not_found
staff smoke: all ok
```

The storefront smoke still prints "smoke: all ok" against the extended mock. Before the 14 / 15 additions below, the
staff smoke matched 01 §10's expected output line for line ("inbox: 5 item(s), 3 draft(s)"); with them it reads
"7 item(s), 4 draft(s)", as 14 §10 says it should.

**End-to-end flows** (headless Chrome, browser time zone `America/New_York`, all passing on a fresh mock day): the
counter places an order and records a cash payment ("Change to give: ₹311.00"); the kitchen starts ticket 6 and, after
"Ready", "Handed over" on unpaid ticket 4 asks "₹546.00 is still to pay on order #4. Send the customer to the counter
first."; the inbox approves the prep-time draft; Ask answers with cited values; Cares approves the donation proposal
and records the hand-over; Suppliers approves the hazelnut PO with a typed price (Munim works out ₹12,600.00) and the
goods are received ("Received").

**Screenshots:** `docs/screenshots/staff-<screen>-<state>-<width>.png`: sign-in, owner home and its source drawer,
inbox and a draft (before and after approval), Ask (start and an answer), the till (empty, priced cart, a paid order),
the kitchen board and "Not paid yet", Cares (owner at 1024 / 1280, staff, after a hand-over), Suppliers (owner at
1024 / 1280, a PO being edited, a received PO). None shows a token or a tenant id. Not every state named in the screen
files has its own screenshot yet; the rest are reachable on the mock as each screen file describes.

### What I changed from the staff pack, and why

1. **SDK stays 0.1.0, with a type shim for `GET /v1/me`.** `munim-sdk-0.2.0.tgz` answers 404 at
   `https://munim-rho.example.app/downloads/` (checked 14 Oct 2026); only `munim-sdk.tgz` (0.1.0) is published.
   0.1.0 already has every other member route and type, so `lib/munim/types.ts` declares `V1Me` and the `/v1/me`
   path exactly as 01 §5 documents them, and the staff client is typed with that path set. Delete the shim when 0.2.0
   installs. The mock files import `Schemas` from `lib/munim/types` for the same reason.
2. **The pieces the pack's "orchestrator" was meant to merge, written here** (14 §10, 15 §10, 11 §7):
   - mock: the `inventory.expiry_risk` and `cares.recipient_match` templates, the expiry finding, the Cares donation
     draft, approving it creates the listing under the approver, a Cares draft is owner / judge only, `recipient_ineligible`
     and `listing_expired` are 422 `invalid_payload`, `GET /v1/drafts?outlet=` filters, and the goods-received routes
     with core's rules plus a seeded note for last week's butter order;
   - client: `listGoodsReceived`, `getGoodsReceived`, `receiveGoods` and `ReceiveGoodsCommand`;
   - `TicketCard` takes the `sizeOf` prop the kitchen page passes ("1× Hazelnut Praline Cake · 1 kg (serves 8–10)");
   - the inbox hides "Approve" from managers on a Cares draft (`drafts.ts`), as core would refuse it;
   - the template words for the two Cares templates, and the finding title for `inventory.expiry_risk`.
3. **Pages the pack left to me:** `components/staff/pages/cares.tsx` (14 §2–§6) and
   `components/staff/pages/suppliers.tsx` (the three screens of 15 §2), with their thin route files.
4. **Next 16 fixes:** every staff route file wraps its client page in `Suspense` and exports `instant = false`, and
   the staff layout wraps the shell in `Suspense`. The shell renders a page only after the browser has read the
   session, so Next cannot prerender a staff page; without these the build failed and dev logged
   "Could not validate that a segment in your UI has instant navigation". `app/staff/page.tsx`'s redirect moved to
   `components/staff/staff-index.tsx`, because a client file cannot export `instant`.
5. The Mock controls panel shows on staff pages too (with the two new selects); owner home's "Low stock" card keeps its
   own height.

### Where the staff pack, the API or the mock was unclear

1. **SDK 0.2.0 is not downloadable** (above). 00 §3 and 01 §1 both say to install it.
2. **The pack assumes merges that were not in it.** 14 §10 and 15 §10 say "the pack's orchestrator merges these
   additions into 01–03", but 01–03 as sent do not have them. I wrote them from 14 / 15's descriptions; the column sets
   of `inventory.expiry_risk` and `cares.recipient_match` are inferred from what `cares-flow.ts` reads, so please send
   core's real columns.
3. **11 says `TicketCard` has a `sizeOf` prop (02 §7), but 02 §7's code has none.** Added.
4. **Pages 12 / 13 and `app/staff/page.tsx` do not build under Next 16 with Cache Components** as printed (no
   Suspense around `useParams` / `usePathname`). Wrapped.
5. Everything in 00 §7 still stands (member-route CORS, no "sales today", quoted prices never trace, orders complete
   unpaid, no line notes on order views, `GET /v1/outlets` lists every outlet, Ask has no progress stream).
6. **Staff receiving goods:** core lets staff record goods received, but `CAN.suppliers` hides the screens from them
   (15 §10's open question). Kept as written: owners and managers only.

## Changes from the spec, and why

1. **SDK instead of the hand-written client.** 01 says "no SDK", but Munim's developer portal now ships
   `@munim/sdk`, and the project owner asked for it. The wrapper keeps the spec's `Result` / `MunimError` contract, so
   every other spec file is used unchanged.
2. **Own business and own mock.** The project owner asked for a bakery. Munim's mock has none, so the app serves its
   own over the same contract (see above).
3. **Look.** 02's neo-brutalist street-food style was swapped for a warm patisserie look (cream, hazelnut, rose;
   Fraunces + Inter) at the project owner's request. The component inventory, states, 48 px targets and the
   reduced-motion rules are unchanged. Every new colour pair is measured below.
4. **Diet words.** `veg` reads "Eggless" and `egg` reads "Contains egg" (the marks are unchanged): in an Indian
   bakery the green mark means "no egg", and that is the word shoppers look for.
5. **Line notes.** Cart lines carry an optional `note` (cake message, gift-card message), sent in `orders.place.v1`
   `lines[].note` (≤ 200 chars). It is part of the attempt fingerprint, so editing it makes a new attempt.
6. **Extra page.** `/story` ("Our story"), static.
7. **Layout-shift fixes.** Each section loads its data together before rendering (menu + outlets, outlets +
   states), and route fallbacks are full height, so the footer never flashes into view (CLS 0).

## Where the API or the spec was unclear

1. **Order view has no options or notes.** `StorefrontOrderView.lines` has `variant_id` but no `option_ids` and no
   `note`, so the tracker cannot show a cake's sponge choice or message, or a box's flavours. Please add them.
2. **Preview request has no `note`.** A too-long note would only be refused at place. The site caps it at 200
   characters to match the place schema.
3. **SDK licence.** `@munim/sdk` is UNLICENSED and "not for redistribution", so it is installed from
   `munim-rho.example.app` at install time. Builds (including Cloud Run) depend on that URL being up.
4. **01 vs the portal.** 01 says there is no SDK package; the developer portal offers one. Which is current?
5. **Categories and deals have keys only**, no display names (known gap; labels live in `lib/site.ts`).
6. **Guest cancel / reschedule** answer `403 guest_cannot_change`, as documented; this guest-only site doesn't call them.

## Colour contrast (measured, WCAG 2.x)

| Pair | Ratio |
|---|---|
| ink on bg / card | 15.32 / 16.73 |
| muted on bg / card | 6.78 / 7.41 |
| white on primary / secondary | 8.17 / 7.07 |
| ink on accent | 12.49 |
| primary as text on bg / card | 7.48 / 8.17 |
| veg / non-veg / danger on card | 6.42 / 6.77 / 6.57 |
| ok on bg, danger on bg | 5.88, 6.02 |
| line (borders) on bg / card | 4.28 / 4.67 |
| focus ring (secondary) on bg / card | 6.47 / 7.07 |

## Art log

Every shape and icon was drawn by hand as inline SVG or CSS for this project. No icon packs, stock or
third-party art.

| Date | File | What |
|---|---|---|
| 2026-10-14 | `components/art.tsx` | Hero croissant (five crescents) with hazelnut and steam curls; hazelnut mark; wordmark; category motifs (croissant, cake slice, cookie, gift box, cup) — drawn by hand for this project |
| 2026-10-14 | `components/icons.tsx` | Bag, plus, minus, close, clock, phone, pin, check, alert, offline, leaf, chevron, moon, pause, gift — drawn by hand for this project |
| 2026-10-14 | `components/ui.tsx` | Diet marks (square + circle / triangle / oval, leaf) — drawn by hand for this project |
| 2026-10-14 | `app/globals.css` | Section-title swash (inline SVG), scalloped doily edge (CSS gradient) — drawn by hand for this project |
| 2026-10-14 | `components/staff/source.tsx` | Ledger-stamp mark in the source chip (rounded square, two ruled lines) — drawn by hand for this project |
| 2026-10-14 | `app/staff/staff.css` | Staff pills, source and "Cannot verify" chips, ticket heads and edges (CSS only, no images) — drawn by hand for this project |

Fonts: Fraunces and Inter (both SIL OFL), served through `next/font`.
