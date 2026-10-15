// file: lib/munim/staff.ts
// The member (staff) client: the same SDK, the same Result / MunimError and the same settle() as the storefront
// client in client.ts, with the person's token and tenant instead of the storefront key. One instance per session
// (session.ts). It never logs, and never puts the token or the tenant in a URL.
import { createMunimClient as createSdkClient } from "@munim/sdk";
import { settle } from "./client";
import type { Envelope } from "./commands";
import type { Client } from "openapi-fetch";
import type { paths, Schemas } from "./types";

export interface StaffClientOptions {
  /** Same base as the storefront: "/mock" for this app's mock, the real API's URL later. */
  baseUrl: string;
  /** The member's ID token (Authorization: Bearer). Called before every request, so a refreshed token is used. */
  token: () => string | Promise<string>;
  /** The business the person acts in (X-Munim-Tenant). */
  tenantId: string;
  /** Dev only: the mock's test headers (mock-controls.ts). */
  extraHeaders?: () => Record<string, string>;
  /** Default per-call timeout (15 000 ms). Ask always uses ASK_TIMEOUT_MS. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** POST /v1/ask is answered only after the AI has finished (core waits up to 90 s). */
export const ASK_TIMEOUT_MS = 95_000;

type Cmd<T extends string, P> = Envelope<T, P>;
export type PlaceOrderCommand = Cmd<"orders.place.v1", Schemas["OrdersPlaceV1"]>;
export type AcceptOrderCommand = Cmd<"orders.order.accept.v1", Schemas["OrdersOrderAcceptV1"]>;
export type RejectOrderCommand = Cmd<"orders.order.reject.v1", Schemas["OrdersOrderRejectV1"]>;
export type AdvanceOrderCommand = Cmd<"orders.order.advance.v1", Schemas["OrdersOrderAdvanceV1"]>;
export type TenderCommand = Cmd<"orders.tender.record.v1", Schemas["OrdersTenderRecordV1"]>;
export type AdvanceTicketCommand = Cmd<"kitchen.ticket.advance.v1", Schemas["KitchenTicketAdvanceV1"]>;
export type ApproveDraftCommand = Cmd<"drafts.approve.v1", Schemas["DraftsApproveV1"]>;
export type RejectDraftCommand = Cmd<"drafts.reject.v1", Schemas["DraftsRejectV1"]>;
export type DismissFindingCommand = Cmd<"findings.dismiss.v1", Schemas["FindingsDismissV1"]>;
export type PublishListingCommand = Cmd<"cares.listing.publish.v1", Schemas["CaresListingPublishV1"]>;
export type WithdrawListingCommand = Cmd<"cares.listing.withdraw.v1", Schemas["CaresListingWithdrawV1"]>;
export type RecordHandoverCommand = Cmd<"cares.handover.record.v1", Schemas["CaresHandoverRecordV1"]>;
export type CreatePoCommand = Cmd<"purchasing.po.create.v1", Schemas["PurchasingPoCreateV1"]>;
/** 15 §10 addition: goods received against a purchase order. */
export type ReceiveGoodsCommand = Cmd<"purchasing.grn.receive.v1", Schemas["PurchasingGrnReceiveV1"]>;

export function createStaffClient(opts: StaffClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  // Typed with ./types paths (the SDK workspace package).
  const sdk = createSdkClient({ baseUrl, token: opts.token, tenantId: opts.tenantId, fetch: opts.fetch }) as unknown as Client<paths>;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  /** Per-call options: never cached, time-limited, plus the dev switches. */
  const init = (ms = timeoutMs) => ({ cache: "no-store" as const, signal: AbortSignal.timeout(ms), headers: opts.extraHeaders?.() ?? {} });
  const id = (v: string) => ({ path: { id: v } });

  return {
    // ---- who and where (every screen) ----
    getMe: () => settle(() => sdk.GET("/v1/me", init())),
    getTenant: () => settle(() => sdk.GET("/v1/tenant", init())),
    listOutlets: () => settle(() => sdk.GET("/v1/outlets", init())),
    listChannels: () => settle(() => sdk.GET("/v1/channels", init())),
    listDevices: () => settle(() => sdk.GET("/v1/devices", init())),

    // ---- counter (10) ----
    /** Items for sale now at an outlet on a channel kind ("counter" for the till), with display names. */
    getMenu: (outletId: string, channelKind: string) => settle(() => sdk.GET("/v1/catalogue/menu", { params: { query: { outlet: outletId, channel_kind: channelKind } }, ...init() })),
    /** Prices a cart and writes nothing. A plain body, not a command. Refusals come back inside the 200. */
    previewOrder: (body: Schemas["OrdersPreviewRequest"]) => settle(() => sdk.POST("/v1/orders:preview", { body, ...init() })),
    /** 201 CommandResult (entity_id = the order). `replayed` is true for a resend of the same envelope. */
    placeOrder: (body: PlaceOrderCommand) => settle(() => sdk.POST("/v1/orders", { body, ...init() })),
    getOrder: (orderId: string) => settle(() => sdk.GET("/v1/orders/{id}", { params: id(orderId), ...init() })),
    listOrders: (query: { outlet?: string; status?: Schemas["V1Order"]["status"]; business_date?: string; limit?: number; cursor?: string }) =>
      settle(() => sdk.GET("/v1/orders", { params: { query }, ...init() })),
    getReceipt: (orderId: string) => settle(() => sdk.GET("/v1/orders/{id}/receipt", { params: id(orderId), ...init() })),
    acceptOrder: (orderId: string, body: AcceptOrderCommand) => settle(() => sdk.POST("/v1/orders/{id}:accept", { params: id(orderId), body, ...init() })),
    rejectOrder: (orderId: string, body: RejectOrderCommand) => settle(() => sdk.POST("/v1/orders/{id}:reject", { params: id(orderId), body, ...init() })),
    advanceOrder: (orderId: string, body: AdvanceOrderCommand) => settle(() => sdk.POST("/v1/orders/{id}:advance", { params: id(orderId), body, ...init() })),
    /** Recorded only: Munim does not process payments. Cash: tendered_minor; card / UPI: amount_minor. */
    recordTender: (orderId: string, body: TenderCommand) => settle(() => sdk.POST("/v1/orders/{id}/tenders", { params: id(orderId), body, ...init() })),

    // ---- kitchen (11) ----
    getBoard: (outletId: string, station?: string) =>
      settle(() => sdk.GET("/v1/kitchen/board", { params: { query: station ? { outlet: outletId, station } : { outlet: outletId } }, ...init() })),
    advanceTicket: (ticketId: string, body: AdvanceTicketCommand) => settle(() => sdk.POST("/v1/kitchen/tickets/{id}:advance", { params: id(ticketId), body, ...init() })),

    // ---- owner home and approvals (12) ----
    listInbox: (cursor?: string) => settle(() => sdk.GET("/v1/inbox", { params: { query: cursor ? { cursor } : {} }, ...init() })),
    listDrafts: (query: { status?: "proposed" | "executing" | "executed" | "failed" | "rejected" | "stale" | "decided"; outlet?: string; cursor?: string }) =>
      settle(() => sdk.GET("/v1/drafts", { params: { query }, ...init() })),
    /** The draft with its decision, history and unverified_refs: open this before showing any approve button. */
    getDraft: (draftId: string) => settle(() => sdk.GET("/v1/drafts/{id}", { params: id(draftId), ...init() })),
    getDraftLineage: (draftId: string) => settle(() => sdk.GET("/v1/drafts/{id}/lineage", { params: id(draftId), ...init() })),
    /** payload.draft_id must equal draftId (else 422). Returns the EXECUTED command's result (its type and entity). */
    approveDraft: (draftId: string, body: ApproveDraftCommand) => settle(() => sdk.POST("/v1/drafts/{id}:approve", { params: id(draftId), body, ...init() })),
    rejectDraft: (draftId: string, body: RejectDraftCommand) => settle(() => sdk.POST("/v1/drafts/{id}:reject", { params: id(draftId), body, ...init() })),
    dismissFinding: (findingId: string, body: DismissFindingCommand) => settle(() => sdk.POST("/v1/findings/{id}:dismiss", { params: id(findingId), body, ...init() })),
    /** Mints a snapshot of an allow-listed template (owner home's stat cards). 201 with the rows. */
    mintSnapshot: (body: Schemas["V1SnapshotsRequest"]) => settle(() => sdk.POST("/v1/snapshots", { body, ...init() })),
    /** Opens the rows behind a ref (the snapshot drawer). 404 when it is not this person's to see. */
    getSnapshot: (snapshotId: string) => settle(() => sdk.GET("/v1/snapshots/{id}", { params: id(snapshotId), ...init() })),

    // ---- Ask Munim (13) ----
    /** Not a command and NOT safe to retry: a resend can append a second turn. On a network error, refetch the thread. */
    ask: (body: Schemas["V1AskRequest"]) => settle(() => sdk.POST("/v1/ask", { body, ...init(ASK_TIMEOUT_MS) })),
    listThreads: () => settle(() => sdk.GET("/v1/threads", init())),
    getThread: (threadId: string) => settle(() => sdk.GET("/v1/threads/{id}", { params: id(threadId), ...init() })),
    listSpecialists: () => settle(() => sdk.GET("/v1/specialists", init())),

    // ---- Cares (14) ----
    getCaresProfile: () => settle(() => sdk.GET("/v1/cares/profile", init())),
    listRecipients: (outletId: string) => settle(() => sdk.GET("/v1/cares/recipients", { params: { query: { outlet: outletId } }, ...init() })),
    listListings: (query: { outlet?: string; kind?: "donation" | "offer"; status?: "published" | "allocated" | "closed" | "withdrawn" }) =>
      settle(() => sdk.GET("/v1/cares/listings", { params: { query }, ...init() })),
    getListing: (listingId: string) => settle(() => sdk.GET("/v1/cares/listings/{id}", { params: id(listingId), ...init() })),
    publishListing: (body: PublishListingCommand) => settle(() => sdk.POST("/v1/cares/listings", { body, ...init() })),
    withdrawListing: (listingId: string, body: WithdrawListingCommand) => settle(() => sdk.POST("/v1/cares/listings/{id}:withdraw", { params: id(listingId), body, ...init() })),
    recordHandover: (body: RecordHandoverCommand) => settle(() => sdk.POST("/v1/cares/handovers", { body, ...init() })),

    // ---- suppliers (15) ----
    listSuppliers: () => settle(() => sdk.GET("/v1/suppliers", init())),
    getSupplier: (supplierId: string) => settle(() => sdk.GET("/v1/suppliers/{id}", { params: id(supplierId), ...init() })),
    listPurchaseOrders: () => settle(() => sdk.GET("/v1/purchase-orders", init())),
    getPurchaseOrder: (poId: string) => settle(() => sdk.GET("/v1/purchase-orders/{id}", { params: id(poId), ...init() })),
    /** 201. A person's own purchase order; one the AI proposed arrives as a draft and is approved in the inbox instead. */
    createPurchaseOrder: (body: CreatePoCommand) => settle(() => sdk.POST("/v1/purchase-orders", { body, ...init() })),
    /** 15 §10 addition. Goods-received notes in the person's outlets. */
    listGoodsReceived: () => settle(() => sdk.GET("/v1/goods-received", init())),
    getGoodsReceived: (grnId: string) => settle(() => sdk.GET("/v1/goods-received/{id}", { params: id(grnId), ...init() })),
    /** 201. purchasing.grn.receive.v1: core moves the stock and marks the PO received once every line has come in. */
    receiveGoods: (body: ReceiveGoodsCommand) => settle(() => sdk.POST("/v1/goods-received", { body, ...init() })),
    listIngredients: (outletId?: string) => settle(() => sdk.GET("/v1/inventory/ingredients", { params: { query: outletId ? { outlet: outletId } : {} }, ...init() })),
    listReorderLevels: (outletId: string) => settle(() => sdk.GET("/v1/inventory/reorder-levels", { params: { query: { outlet: outletId } }, ...init() })),
  };
}

export type StaffClient = ReturnType<typeof createStaffClient>;
