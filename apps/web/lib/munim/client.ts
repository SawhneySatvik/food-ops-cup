// The storefront's API client, built on Munim's TypeScript SDK (@munim/sdk, from /developers/downloads).
// The SDK gives typed paths and bodies and sends the storefront key; this wrapper adds what 01-api-client.md §3
// requires on top: no-store, a timeout, the guest token per call, and errors parsed into a MunimError that never
// keeps the server's message. It never logs, and never puts the key or a guest token in a URL.
import { createMunimClient as createSdkClient, createPublicClient, GUEST_TOKEN_HEADER, isReplayed } from "@munim/sdk";
import type { Schemas } from "./types";

export { GUEST_TOKEN_HEADER, REPLAYED_HEADER, STOREFRONT_KEY_HEADER } from "@munim/sdk";

type ErrorBody = Schemas["Error"]["error"];
export type ErrorCode = ErrorBody["code"];
export type ReasonCode = NonNullable<ErrorBody["reason_code"]>;
export type RefusalParams = NonNullable<Schemas["StorefrontRefusalError"]["params"]>;

export type ErrorKind =
  | "network" //      no response: offline, DNS, CORS block, timeout (status 0)
  | "not_found" //    404: bad key, bad guest token, not your order, unknown id. Never say which
  | "rate_limited" // 429: wait retryAfterMs, then send the SAME request again
  | "refusal" //      a named refusal: switch on reasonCode, fill your copy from params
  | "key_reused" //   409 idempotency_conflict: our bug. Build a new attempt and retry once
  | "invalid" //      400 / 409 / 422 without a reason code: our bug, the request was malformed
  | "auth" //         401 / 403 without a reason code
  | "server"; //      5xx and anything else: try again later

/** A failed call, parsed. The server's `message` is deliberately not kept: never show it. */
export interface MunimError {
  kind: ErrorKind;
  status: number;
  code: ErrorCode | null;
  reasonCode: ReasonCode | null;
  /** Ids and server-computed amounts for the refusal copy; {} when the refusal has none. */
  params: RefusalParams;
  /** Set on 429 (and on a 503 that sends Retry-After): wait this long before retrying. */
  retryAfterMs: number | null;
}

export type Result<T> = { ok: true; status: number; data: T; replayed: boolean } | { ok: false; error: MunimError };

export interface MunimClientOptions {
  /** e.g. "/mock" (this app's own mock) or the real API's URL. */
  baseUrl: string;
  storefrontKey: string;
  /** Dev only: extra request headers (the mock's X-Mock-Force-* switches, see mock-controls.ts). */
  extraHeaders?: () => Record<string, string>;
  /** Abort a call that takes longer than this (default 15 000 ms); it then fails with kind "network". */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Commands that only a signed-in customer may send (guests get 403 guest_cannot_change). */
export type CancelCommand = { command_id: string; idempotency_key: string; type: "storefront.order.cancel.v1"; payload: Schemas["StorefrontOrderCancelV1"] };
export type RescheduleCommand = { command_id: string; idempotency_key: string; type: "storefront.order.reschedule.v1"; payload: Schemas["StorefrontOrderRescheduleV1"] };

const fail = (error: MunimError): { ok: false; error: MunimError } => ({ ok: false, error });
const networkError = (): MunimError => ({ kind: "network", status: 0, code: null, reasonCode: null, params: {}, retryAfterMs: null });

/** Retry-After in ms (whole seconds or an HTTP date), capped at 60 s; null when absent or unreadable. */
export function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw === null) return null;
  const s = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(s) && s >= 0) return Math.min(s, 60) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.min(Math.max(at - Date.now(), 0), 60_000);
}

/** Classifies a non-2xx answer. `body` is what openapi-fetch parsed (an object, a string, or nothing). */
export function parseError(res: Response, body: unknown): MunimError {
  const b = (typeof body === "object" && body !== null ? body : null) as Partial<Schemas["StorefrontRefusalError"]> | null;
  const s = res.status;
  const code = b?.error?.code ?? null;
  const reasonCode = b?.error?.reason_code ?? null;
  const kind: ErrorKind =
    s === 404 ? "not_found"
    : s === 429 ? "rate_limited"
    : code === "idempotency_conflict" ? "key_reused"
    : reasonCode !== null && s < 500 ? "refusal"
    : s === 400 || s === 409 || s === 422 ? "invalid"
    : s === 401 || s === 403 ? "auth"
    : "server";
  const wait = s === 429 || s === 503 ? (retryAfterMs(res) ?? (s === 429 ? 5000 : null)) : null;
  return { kind, status: s, code, reasonCode, params: b?.params ?? {}, retryAfterMs: wait };
}

type SdkAnswer<T> = { data?: T; error?: unknown; response: Response };

export async function settle<T>(call: () => Promise<SdkAnswer<T>>): Promise<Result<T>> {
  let r: SdkAnswer<T>;
  try {
    r = await call();
  } catch {
    return fail(networkError()); // offline, CORS, timeout, or a body that was not JSON
  }
  if (!r.response.ok) return fail(parseError(r.response, r.error));
  if (r.data === undefined) return fail({ kind: "server", status: r.response.status, code: null, reasonCode: null, params: {}, retryAfterMs: null });
  return { ok: true, status: r.response.status, data: r.data, replayed: isReplayed(r.response) };
}

export function createMunimClient(opts: MunimClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const sdk = createSdkClient({ baseUrl, storefrontKey: opts.storefrontKey, fetch: opts.fetch });
  const open = createPublicClient({ baseUrl, fetch: opts.fetch });
  const timeoutMs = opts.timeoutMs ?? 15_000;
  /** Per-call options: never cached, time-limited, plus the dev switches and (for order reads) the guest token. */
  const init = (guestToken?: string | null) => ({
    cache: "no-store" as const,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { ...(opts.extraHeaders?.() ?? {}), ...(guestToken ? { [GUEST_TOKEN_HEADER]: guestToken } : {}) },
  });

  return {
    listOutlets: () => settle(() => sdk.GET("/v1/storefront/outlets", init())),
    getMenu: (outletId: string) => settle(() => sdk.GET("/v1/storefront/outlets/{outlet_id}/menu", { params: { path: { outlet_id: outletId } }, ...init() })),
    getState: (outletId: string) => settle(() => sdk.GET("/v1/storefront/outlets/{outlet_id}/state", { params: { path: { outlet_id: outletId } }, ...init() })),
    getPickupWindows: (outletId: string) =>
      settle(() => sdk.GET("/v1/storefront/outlets/{outlet_id}/pickup-windows", { params: { path: { outlet_id: outletId } }, ...init() })),
    /** Prices a cart and writes nothing. Refusals come back inside a 200 (`refusals[]`), not as an error. */
    previewOrder: (body: Schemas["OrdersPreviewRequest"]) => settle(() => sdk.POST("/v1/storefront/orders:preview", { body, ...init() })),
    /** 201 on success; `replayed` is true when the same body was already placed (then guest_access_token is null). */
    placeOrder: (body: Schemas["StorefrontOrderPlaceRequest"]) => settle(() => sdk.POST("/v1/storefront/orders", { body, ...init() })),
    getOrder: (orderId: string, guestToken: string | null) =>
      settle(() => sdk.GET("/v1/storefront/orders/{id}", { params: { path: { id: orderId } }, ...init(guestToken) })),
    getCares: () => settle(() => sdk.GET("/v1/storefront/cares", init())),
    /** T-128: the live storefront page (theme and home sections), or `page: null` for the built-in look. */
    getPage: () => settle(() => sdk.GET("/v1/storefront/page", init())),
    /** Credential-free (no key, no token). Not served by the mock: expect 404 there and hide the figure. */
    getNetworkImpact: () =>
      settle(() => open.GET("/v1/cares-network/impact", { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })),
    // Signed-in customers only. Guests get 403 with reason_code guest_cannot_change. Not used by this guest-only site.
    cancelOrder: (orderId: string, body: CancelCommand, guestToken: string | null) =>
      settle(() => sdk.POST("/v1/storefront/orders/{id}:cancel", { params: { path: { id: orderId } }, body, ...init(guestToken) })),
  };
}

export type MunimClient = ReturnType<typeof createMunimClient>;
