// The mock Munim storefront API for Cobnut Bakehouse, served at /mock/v1/*. Same paths, shapes, errors and test
// switches as Munim's own hosted SDK mock, over this bakery's synthetic data.
import { createHash } from "node:crypto";
import type { Schemas } from "@munim/sdk";
import { BRAND, CHANNEL_ID, DEALS, ITEMS, OUTLETS, PREP_MIN, STOREFRONT_KEY, TZ, TZ_OFFSET_MIN, OPEN_FROM_MIN, OPEN_TO_MIN, groupId, itemId, optionId, variantId, type MockOutlet } from "./data";
import { BadRequest, localClock, outletById, price, type Accepting } from "./pricing";
import { book, openWindows } from "./windows";
import { eventsUntil, issueToken, readToken, recordFrom, viewOf } from "./orders";
import { handleStaff, isStaffRequest, livePage } from "./staff";

type ReasonCode = Schemas["ReasonCode"];
type ErrorCode = Schemas["Error"]["error"]["code"];

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_.:-]{8,100}$/;

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Munim-Tenant, X-Munim-Storefront-Key, X-Munim-Guest-Token, Last-Event-ID, X-Mock-Force-Accepting, X-Mock-Force-429, X-Mock-Force-Decision, X-Mock-Force-Ai",
  "Access-Control-Expose-Headers": "X-Munim-Mock, X-Munim-Replayed, Retry-After",
  "X-Munim-Mock": "true",
  "Cache-Control": "no-store",
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  not_found: "Not found.",
  forbidden: "Not allowed.",
  conflict: "This request was refused.",
  idempotency_conflict: "This request key was already used for a different request.",
  invalid_payload: "This request is not valid.",
  bad_request: "Malformed request.",
  unavailable: "Too many requests. Please wait a moment and try again.",
};
const error = (status: number, code: ErrorCode, reason: ReasonCode | null = null, params?: Record<string, unknown>, extra?: Record<string, string>) =>
  json(status, { error: { code, message: MESSAGES[code] ?? "Error.", reason_code: reason }, ...(params ? { params } : {}) }, extra);
const notFound = () => error(404, "not_found");

// Per instance: idempotency keys of placed orders, line ids already used, and the ticket counter.
const placed = new Map<string, { hash: string; body: Schemas["StorefrontOrderPlaced"] }>();
const usedLineIds = new Set<string>();
let ticket = 0;

function forced(req: Request): Accepting | null {
  const v = req.headers.get("X-Mock-Force-Accepting");
  return v === "open" || v === "busy" || v === "paused" || v === "closed" ? v : null;
}

/** The next 08:00 outlet time strictly after `now`. */
function nextOpening(now: Date): Date {
  const { minutes } = localClock(now);
  const local = new Date(now.getTime() + TZ_OFFSET_MIN * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  const days = minutes < OPEN_FROM_MIN ? 0 : 1;
  return new Date(local.getTime() + (days * 1440 + OPEN_FROM_MIN - TZ_OFFSET_MIN) * 60_000);
}

function accepting(o: MockOutlet, req: Request, now: Date): Schemas["StorefrontAcceptingResponse"] {
  const state = forced(req) ?? o.state;
  const next =
    state === "paused" ? new Date(Math.ceil((now.getTime() + 30 * 60_000) / 300_000) * 300_000)
    : state === "closed" ? nextOpening(now)
    : null;
  return {
    outlet_id: o.outlet_id,
    state,
    busy_extra_min: state === "busy" ? o.busy_extra_min || 10 : 0,
    default_prep_min: PREP_MIN,
    next_open: next ? next.toISOString() : null,
    tz: TZ,
    as_of: now.toISOString(),
  };
}

function menu(o: MockOutlet, req: Request, now: Date): Schemas["StorefrontMenuResponse"] {
  return {
    outlet_id: o.outlet_id,
    channel_id: CHANNEL_ID,
    channel_kind: "own_site",
    brands: [BRAND],
    prices_include_tax: false,
    accepting: accepting(o, req, now),
    items: ITEMS.map((i) => ({
      item_id: itemId(i.slug),
      name_key: `item.${i.slug}`,
      display_name: i.name,
      description: i.description,
      diet: i.diet,
      category: i.category,
      brand_id: BRAND.brand_id,
      kind: i.kind,
      available: !(i.soldOut || o.soldOut.includes(i.slug)),
      price_minor: i.price,
      currency: "INR",
      variants: i.variants.map((v) => ({ variant_id: variantId(i.slug, v.slug), name_key: `variant.${v.slug}`, display_name: v.name, description: v.description, available: true, price_minor: v.price })),
      option_groups: i.groups.map((g) => ({
        option_group_id: groupId(i.slug, g.slug),
        name_key: `group.${g.slug}`,
        display_name: g.name,
        description: g.description,
        min_select: g.min,
        max_select: g.max,
        required: g.min > 0,
        options: g.options.map((x) => ({ option_id: optionId(i.slug, g.slug, x.slug), name_key: `option.${x.slug}`, display_name: x.name, description: null, price_delta_minor: x.delta })),
      })),
    })),
    deals: DEALS.map((d) => ({ deal_id: d.deal_id, name_key: d.name_key, kind: d.kind, windows: d.windows, valid_from: d.valid_from, valid_to: d.valid_to })),
    pay_at_counter: true,
    pay_at_counter_methods: ["cash", "card", "upi"],
  };
}

function cares(now: Date): Schemas["V1StorefrontCares"] {
  // Surplus is handed over at closing: the next 21:00 outlet time, for ninety minutes.
  const local = new Date(now.getTime() + TZ_OFFSET_MIN * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  let from = new Date(local.getTime() + (OPEN_TO_MIN - TZ_OFFSET_MIN) * 60_000);
  if (from.getTime() + 90 * 60_000 < now.getTime()) from = new Date(from.getTime() + 86_400_000);
  const to = new Date(from.getTime() + 90 * 60_000);
  const day = new Date(now.getTime() + TZ_OFFSET_MIN * 60_000 + 2 * 86_400_000).toISOString().slice(0, 10);
  const base = { city_code: "lucknow", business_name: "Cobnut Bakehouse (synthetic)", tz: TZ, pickup_from: from.toISOString(), pickup_to: to.toISOString(), recipient_simulated: true as const };
  return {
    items: [
      { ...base, listing_id: "019a0c5e-0001-7a11-8c01-000000000001", outlet_name: OUTLETS[0]!.name, recipient_name: "Simulated Night Shelter (synthetic)", lines: [
        { line_no: 1, food_kind: "cooked", label_key: null, label: "Assorted pastries from today's bake", qty_milli: 24_000, unit: "piece", expires_on: null },
      ] },
      { ...base, listing_id: "019a0c5e-0002-7a11-8c01-000000000002", outlet_name: OUTLETS[1]!.name, recipient_name: "Simulated Community Kitchen (synthetic)", lines: [
        { line_no: 1, food_kind: "packaged", label_key: null, label: "Sliced sourdough loaves", qty_milli: 8_000, unit: "piece", expires_on: day },
        { line_no: 2, food_kind: "cooked", label_key: null, label: "Cardamom knots", qty_milli: 12_000, unit: "piece", expires_on: null },
      ] },
    ],
  };
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("json");
  }
}

function placeOrder(body: Schemas["StorefrontOrderPlaceRequest"], raw: string, req: Request, now: Date): Response {
  const o = body?.order;
  const g = body?.guest;
  const p = o?.payload;
  if (!o || !p || o.type !== "orders.place.v1" || !UUID7.test(o.command_id) || !IDEMPOTENCY.test(o.idempotency_key) || !UUID7.test(p.order_id)) return error(422, "invalid_payload");
  if (!g || g.type !== "storefront.guest.create.v1" || !UUID7.test(g.command_id) || !IDEMPOTENCY.test(g.idempotency_key)) return error(422, "invalid_payload");
  const name = g.payload?.name?.trim() ?? "";
  if (name.length < 1 || name.length > 200 || (!g.payload.phone && !g.payload.email)) return error(422, "invalid_payload");
  if (!Array.isArray(p.lines) || p.lines.some((l) => !UUID7.test(l.line_id) || (l.note !== null && (typeof l.note !== "string" || l.note.length > 200)))) return error(422, "invalid_payload");

  const hash = createHash("sha256").update(raw).digest("hex");
  const prior = placed.get(o.idempotency_key);
  if (prior) {
    if (prior.hash !== hash) return error(409, "idempotency_conflict");
    return json(201, { ...prior.body, guest_access_token: null }, { "X-Munim-Replayed": "true" });
  }
  if (p.lines.some((l) => usedLineIds.has(l.line_id))) return error(422, "invalid_payload");

  const outlet = outletById(p.outlet_id);
  if (!outlet) return notFound();
  const state = accepting(outlet, req, now).state;
  if (state === "paused" || state === "closed") return error(409, "conflict", "outlet_paused");
  const { preview, promised } = price({ ...p, lines: p.lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli, barcode: l.barcode })) }, outlet, state, now);
  const first = preview.refusals[0];
  if (first) return error(409, "conflict", first.reason_code, first.params ?? {});
  if (p.preview_total_minor !== null && p.preview_total_minor !== preview.total_minor) {
    return error(409, "conflict", "preview_total_changed", { old_total_minor: p.preview_total_minor, new_total_minor: preview.total_minor, currency: preview.currency });
  }

  if (p.pickup_window_id) book(p.pickup_window_id);
  p.lines.forEach((l) => usedLineIds.add(l.line_id));
  ticket = (ticket % 999) + 1;
  const businessDate = new Date(now.getTime() + TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
  const record = recordFrom(p.order_id, outlet.outlet_id, ticket, businessDate, now, promised, p.pickup_window_id, preview);
  const result: Schemas["StorefrontOrderPlaced"] = {
    order_id: p.order_id,
    status: "placed",
    ticket_no: ticket,
    total_minor: preview.total_minor,
    tax_minor: preview.tax_minor,
    prices_include_tax: false,
    currency: preview.currency,
    promised_at: promised.toISOString(),
    pay_at_counter: true,
    guest_access_token: issueToken(record),
  };
  placed.set(o.idempotency_key, { hash, body: result });
  return json(201, result);
}

function stream(req: Request, url: URL, now: Date): Response {
  const topics = (url.searchParams.get("topics") ?? "").split(",").filter(Boolean);
  if (topics.length !== 1 || !topics[0]!.startsWith("order:")) return error(400, "bad_request");
  const r = readToken(req.headers.get("X-Munim-Guest-Token"));
  if (!r || topics[0] !== `order:${r.order_id}`) return notFound();
  const last = /^n=(\d+)$/.exec(req.headers.get("Last-Event-ID") ?? "");
  let cursor = last ? Number(last[1]) : eventsUntil(r, now).length;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      const opened = Date.now();
      let lastBeat = opened;
      const send = (s: string) => ctl.enqueue(enc.encode(s));
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        try {
          ctl.close();
        } catch {
          // already closed by the client
        }
      };
      send(`retry: 1000\nid: n=${cursor}\nevent: ready\ndata: {}\n\n`);
      const tick = () => {
        const events = eventsUntil(r, new Date());
        while (cursor < events.length) {
          const e = events[cursor]!;
          cursor++;
          const msg = { id: `${r.order_id}:${cursor}`, type: "order.status", data: { order_id: r.order_id, from_status: e.from_status, to_status: e.to_status, from_promised_at: null, to_promised_at: null, at: e.at } };
          send(`id: n=${cursor}\ndata: ${JSON.stringify(msg)}\n\n`);
        }
        if (Date.now() - lastBeat >= 20_000) {
          send(": hb\n\n");
          lastBeat = Date.now();
        }
        if (Date.now() - opened >= 50_000) {
          send("event: reconnect\ndata: {}\n\n");
          stop();
        }
      };
      tick();
      timer = setInterval(tick, 1000);
      req.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body, { status: 200, headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

export async function handle(req: Request, segments: string[]): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = `/v1/${segments.join("/")}`; // the route lives at app/mock/v1/[...path]
  const now = new Date();
  const m = (re: RegExp) => re.exec(path);

  // Member (staff) routes: Authorization + X-Munim-Tenant instead of the storefront key (mock-server/staff.ts).
  if (isStaffRequest(req, path)) {
    if (req.headers.get("X-Mock-Force-429") === "1") return error(429, "unavailable", "rate_limited", undefined, { "Retry-After": "5" });
    const res = await handleStaff(req, path, url, now);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  }

  // The network total is not served by the mock (as on Munim's mock): the page hides it.
  if (path === "/v1/cares-network/impact") return notFound();
  if (req.headers.get("X-Munim-Storefront-Key") !== STOREFRONT_KEY) return notFound();
  if (req.headers.get("X-Mock-Force-429") === "1") return error(429, "unavailable", "rate_limited", undefined, { "Retry-After": "5" });

  try {
    if (req.method === "GET") {
      if (path === "/v1/storefront/outlets") {
        const body: Schemas["StorefrontOutletsResponse"] = {
          outlets: OUTLETS.map((o) => ({ outlet_id: o.outlet_id, name: o.name, kind: "restaurant", tz: TZ, address: o.address, phone: o.phone, tax_ids: o.tax_ids })),
          pay_at_counter_methods: ["cash", "card", "upi"],
        };
        return json(200, body);
      }
      let x = m(/^\/v1\/storefront\/outlets\/([^/]+)\/(menu|state|pickup-windows)$/);
      if (x) {
        const o = outletById(x[1]!);
        if (!o) return notFound();
        if (x[2] === "menu") return json(200, menu(o, req, now));
        if (x[2] === "state") return json(200, accepting(o, req, now));
        const windows: Schemas["StorefrontPickupWindowsResponse"] = { outlet_id: o.outlet_id, windows: openWindows(o.outlet_id, now) };
        return json(200, windows);
      }
      x = m(/^\/v1\/storefront\/orders\/([^/:]+)$/);
      if (x) {
        const r = readToken(req.headers.get("X-Munim-Guest-Token"));
        return r && r.order_id === x[1] ? json(200, viewOf(r, now)) : notFound();
      }
      if (path === "/v1/storefront/cares") return json(200, cares(now));
      // T-128: the live storefront page (theme and home sections) the owner published in the staff half; null = built-in.
      if (path === "/v1/storefront/page") return json(200, livePage());
      if (path === "/v1/stream") return stream(req, url, now);
      return notFound();
    }

    if (req.method === "POST") {
      if (path === "/v1/storefront/orders:preview") {
        const body = (await readJson(req)) as Schemas["OrdersPreviewRequest"];
        const o = outletById(body?.outlet_id);
        if (!o) return notFound();
        return json(200, price(body, o, accepting(o, req, now).state, now).preview);
      }
      if (path === "/v1/storefront/orders") {
        const raw = await req.text();
        let body: Schemas["StorefrontOrderPlaceRequest"];
        try {
          body = JSON.parse(raw) as Schemas["StorefrontOrderPlaceRequest"];
        } catch {
          return error(400, "bad_request");
        }
        return placeOrder(body, raw, req, now);
      }
      const x = m(/^\/v1\/storefront\/orders\/([^/:]+):(cancel|reschedule|reschedule-preview)$/);
      if (x) {
        const r = readToken(req.headers.get("X-Munim-Guest-Token"));
        return r && r.order_id === x[1] ? error(403, "forbidden", "guest_cannot_change") : notFound();
      }
      return notFound();
    }
    return notFound();
  } catch (e) {
    if (e instanceof BadRequest) return error(422, "invalid_payload");
    return error(500, "internal");
  }
}
