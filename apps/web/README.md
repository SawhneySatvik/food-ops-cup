# Cobnut Bakehouse

A pickup-ordering storefront for **Cobnut Bakehouse**, a synthetic bakery with two outlets in Lucknow, built on
**Munim's storefront API** with **Munim's TypeScript SDK** (`@munim/sdk`). Next.js 16 (App Router) + TypeScript +
Tailwind v4.

> **Sample shop — orders are not real.** Demo: all data is synthetic. Payments are recorded, never processed.
> Cobnut Bakehouse, its outlets, phone numbers, tax ids, orders and donation recipients are all invented. It is
> not affiliated with any real bakery.

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
| `npm run smoke` | The 01-api-client smoke test (needs absolute env vars, see below) |
| `npm test` | Unit tests (29): refusal copy, error parsing, tracker copy, phone numbers, notes and attempts, mock pricing |
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

Fonts: Fraunces and Inter (both SIL OFL), served through `next/font`.
