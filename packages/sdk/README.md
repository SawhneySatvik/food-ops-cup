# @munim/sdk

Typed client for the Munim `/v1` API, built on `openapi-fetch`. It also has the storefront-key and guest-token headers
and a fetch-based SSE reader. ESM only, Node 20+ and browsers. Licence: UNLICENSED (shared with you for building the
storefronts, not for redistribution).

**Everything here is simulated.** The mock API at `<site>/mock` serves synthetic data only (in the Munim repository,
`apps/web` serves one at `/mock` when it runs with `MUNIM_MOCK=1`). Orders are never paid
(payment is "at the counter", recorded, never processed), and no real person, brand or supplier is involved.

## Install

```bash
# from the folder that holds munim-sdk-0.3.1.tgz (downloaded, or built in the Munim repository with
# node packages/sdk/scripts/pack.mjs --out <dir>, which writes the .tgz and its .sha256)
npm install ./munim-sdk-0.3.1.tgz        # or: pnpm add ./munim-sdk-0.3.1.tgz
```

The tarball ships compiled JavaScript and `.d.ts` files, so no `transpilePackages` setting is needed. The one dependency,
`openapi-fetch`, is installed for you. Check the download with `shasum -a 256 munim-sdk-0.3.1.tgz` against `munim-sdk-0.3.1.tgz.sha256`.

## Clients

`createMunimClient` returns a typed client: `client.GET(path, opts)` and `client.POST(path, opts)`. Paths, params and bodies
are checked against the contract (`paths`, `components`, `Schemas`, `operations` are the generated types). Each call returns
`{ data, error, response }`.

```ts
import { createMunimClient } from "@munim/sdk";

const client = createMunimClient({ baseUrl: "https://your-site.example/mock", storefrontKey: "sfk_mock_..." });
```

- Storefront key: `storefrontKey` is sent as `X-Munim-Storefront-Key` (`STOREFRONT_KEY_HEADER`) on every call. A wrong key
  gives a plain `404`, never `401`/`403`. The key is public by design, but never log it or put it in a URL.
- Guest token: placing a guest order returns a one-time `guest_access_token`. Pass it as `guestToken` (sent as
  `X-Munim-Guest-Token`, `GUEST_TOKEN_HEADER`) on a second client to read that order. Store it before you render
  anything; it is never returned again.
- Signed-in customers: `token: () => "..."` sends `Authorization: Bearer`.
- `createPublicClient({ baseUrl })` sends no credentials at all. Use it for the public `/v1/cares-network/*` pages only.
- Options are `MunimClientOptions`; the client type is `MunimClient`. `fetch` can be injected for tests. `TENANT_HEADER` is
  for staff apps and unused by storefronts. `OPERATIONS` lists every `"METHOD path"` string.

## Idempotency keys

Writes are commands: the envelope is in the JSON body (`command_id`, `idempotency_key`, `type`, `payload`); there is no
idempotency header. Make the ids once per checkout attempt and reuse them on a network retry with the same body. The
server then returns the original result, and `isReplayed(response)` is true (header `X-Munim-Replayed`, `REPLAYED_HEADER`).
A replayed place has `guest_access_token: null`. Change anything in the cart, the window or the coupon: new keys.
Same key with a different body is `409 idempotency_conflict`. Client ids must be UUIDv7; `crypto.randomUUID()` (v4)
is rejected. Use the SDK's `uuidv7()` (RFC 9562):

```ts
import { uuidv7 } from "@munim/sdk";

const orderId = uuidv7(); // e.g. "01a1320a-85cd-7c46-b867-7e0b20ef990c"
```

## Live updates (SSE)

Do not use `EventSource`: it cannot send headers. `openStream` reads `GET /v1/stream` with `fetch`, reconnects with
exponential backoff and resends `Last-Event-ID`.

```ts
import { openStream, StreamRefused } from "@munim/sdk";

const stream = openStream({
  baseUrl: API,
  topics: [`order:${orderId}`],
  guestToken,                                   // or token: () => freshBearer() for signed-in users
  headers: () => ({ "X-Munim-Storefront-Key": KEY }),
  onEvent: (e) => console.log(e.type, e.data),  // e is a StreamEvent
  onState: (s) => console.log(s),               // connecting | open | retrying | closed
});
stream.done.catch((err) => { if (err instanceof StreamRefused) console.log(err.status); });
stream.close();                                 // StreamHandle
```

Set exactly one of `token` / `guestToken`. A `4xx` other than an expired-token `401` ends the stream with `StreamRefused`
(options are `StreamOptions`; `parseSse` is the low-level parser). The mock API serves `GET /v1/stream` too: a guest's
`order:<id>` topic gets each status change (`order.status`) as the mock order advances. On any event, re-read
`GET /v1/storefront/orders/{id}`; the event carries ids and statuses only.

## Errors

Every non-2xx response has the body `{ error: { code, message, reason_code } }`; `openapi-fetch` puts it in `error` and
leaves `data` undefined. Switch on `reason_code` first, then `code`, and treat unknown values as generic. Storefront
refusals (`409` / `422` from place and reschedule, and each entry of a preview's refusals) may also carry a params object
beside the error: the line, item, coupon code, a min-spend shortfall or the old and new totals, so you can fill your copy
without parsing the message text.

```ts
const { data, error, response } = await client.POST("/v1/storefront/orders", { body });
if (error) {
  if (error.error.reason_code === "window_full") { /* ask for another pickup time */ }
  else if (error.error.reason_code === "coupon_min_spend") { /* "Add {money} more", from error.params.shortfall_minor */ }
  else showGenericProblem(response.status);     // never print error.error.message verbatim as a headline
}
```

Network failures reject the promise; catch them and retry with the same keys.

## Money

Amounts are integers in minor units with a currency code (`INR` paise, `AUD` cents); quantities are `qty_milli`
(1000 = one). The server re-derives every total: send `preview_total_minor` from the preview and display
`total_minor` from the response. Never add up prices in the browser.

```ts
const money = (minor: number, currency: string) =>
  new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-AU", { style: "currency", currency }).format(minor / 100);
```

## Example (storefront)

```ts
import { createMunimClient, uuidv7 } from "@munim/sdk";

const API = process.env.MUNIM_API_URL ?? "http://localhost:3000/mock";
const client = createMunimClient({ baseUrl: API, storefrontKey: process.env.MUNIM_STOREFRONT_KEY! });

const { data: outlets } = await client.GET("/v1/storefront/outlets");
const outlet = outlets!.outlets[0]!;
const { data: menu } = await client.GET("/v1/storefront/outlets/{outlet_id}/menu", {
  params: { path: { outlet_id: outlet.outlet_id } },
});
const item = menu!.items.find((i) => i.available && i.price_minor !== null)!;

const { data: preview } = await client.POST("/v1/storefront/orders:preview", {
  body: {
    outlet_id: outlet.outlet_id, channel_id: menu!.channel_id, brand_id: null, kind: "pickup",
    pickup_window_id: null, promised_at: null, coupon_codes: [], loyalty_redeem_points: 0,
    lines: [{ item_id: item.item_id, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null }],
  },
});
console.log("server total", preview!.total_minor, preview!.currency);
// Place with orders.place.v1 + storefront.guest.create.v1, keep guest_access_token, then track the order
// with openStream (or a second client: createMunimClient({ baseUrl: API, storefrontKey, guestToken })).
// A complete run (preview, place, replay, read, then track over SSE): apps/web/scripts/smoke.ts in the Munim repository.
```
