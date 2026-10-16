// file: lib/munim/staff.ts
// The member (staff) client: the same SDK, the same Result / MunimError and the same settle() as the storefront
// client in client.ts, with the person's token and tenant instead of the storefront key. One instance per session
// (session.ts). It never logs, and never puts the token or the tenant in a URL.
import { createMunimClient as createSdkClient } from "@munim/sdk";
import { settle, type Result } from "./client";
import type { Envelope } from "./commands";
import type { Schemas } from "./types";

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

/** POST /v1/ask is answered only after the AI has finished: core waits MUNIM_ASK_TIMEOUT_S (90 s by default, 240 s on the
 *  hosted deploy). The browser waits longer than any core, so core's own answer (or its 503) arrives first. */
export const ASK_TIMEOUT_MS = 250_000;

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
export type ReceiveGoodsCommand = Cmd<"purchasing.grn.receive.v1", Schemas["PurchasingGrnReceiveV1"]>;
export type RfqCommand = Cmd<"purchasing.rfq.request.v1", Schemas["PurchasingRfqRequestV1"]>;
export type SavePageCommand = Cmd<"storefront.page.save.v1", Schemas["StorefrontPageSaveV1"]>;
export type PublishPageCommand = Cmd<"storefront.page.publish.v1", Schemas["StorefrontPagePublishV1"]>;
export type CancelCampaignCommand = Cmd<"customers.campaign.cancel.v1", Schemas["CustomersCampaignCancelV1"]>;
export type RecordSentCommand = Cmd<"customers.campaign.record_sent.v1", Schemas["CustomersCampaignRecordSentV1"]>;

/** POST /v1/investigations/{id}:approve-plan answers once every step the plan allows has run (core runs them in that
 *  request; the hosted function may take up to 300 s), so the browser waits as long as Ask does. */
export const PLAN_TIMEOUT_MS = 290_000;

/** POST /v1/rfq-requests is answered once the negotiation with the simulated suppliers is over (core waits up to 120 s). */
export const RFQ_TIMEOUT_MS = 130_000;

/** core's trace page size (its cap); a replay follows pages up to MAX_TRACE_PAGES (5,000 events), then stops with what it has. */
const TRACE_PAGE = 100;
const MAX_TRACE_PAGES = 50;

export function createStaffClient(opts: StaffClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const sdk = createSdkClient({ baseUrl, token: opts.token, tenantId: opts.tenantId, fetch: opts.fetch });
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
    /** Who approved the change that made a row: `row` is "<schema>.<table>:<id>", e.g. "core.purchase_order:<po id>". */
    getRowLineage: (row: string) => settle(() => sdk.GET("/v1/lineage", { params: { query: { row } }, ...init() })),
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
    /** Newest first. `specialist`: threads addressed to that desk ("manager" = the main conversation); `cursor` pages. */
    listThreads: (query: { specialist?: Schemas["V1Thread"]["specialist"] | "manager"; cursor?: string; limit?: number } = {}) =>
      settle(() => sdk.GET("/v1/threads", { params: { query: { ...query, specialist: query.specialist ?? undefined } }, ...init() })),
    getThread: (threadId: string) => settle(() => sdk.GET("/v1/threads/{id}", { params: id(threadId), ...init() })),
    listSpecialists: () => settle(() => sdk.GET("/v1/specialists", init())),
    /** A desk: its open findings, proposed drafts, track record (snapshot cells) and threads. */
    getSpecialistDesk: (specialist: string) => settle(() => sdk.GET("/v1/specialists/{id}", { params: { path: { id: specialist } }, ...init() })),
    /** Recent AI runs the person may see, newest first (the office's replay picker). */
    listRuns: (limit = 20) => settle(() => sdk.GET("/v1/runs", { params: { query: { limit } }, ...init() })),
    /** A run's trace events in seq order: ids and short labels only, never text a model or a person wrote. core serves at most
     *  100 a page (a larger limit is a 400), so this follows `next_after_seq` until it is null; the first failed page is the answer. */
    getTraces: async (runId: string): Promise<Result<Schemas["V1TracesResponse"]>> => {
      const events: Schemas["V1TracesResponse"]["events"] = [];
      let after = 0;
      for (let page = 0; page < MAX_TRACE_PAGES; page++) {
        const r = await settle(() => sdk.GET("/v1/traces/{run}", { params: { path: { run: runId }, query: { after_seq: after, limit: TRACE_PAGE } }, ...init() }));
        if (!r.ok) return r;
        events.push(...r.data.events);
        if (r.data.next_after_seq === null) return { ...r, data: { ...r.data, events, next_after_seq: null } };
        after = r.data.next_after_seq;
      }
      return { ok: true, status: 200, replayed: false, data: { run_id: runId, events, next_after_seq: after } };
    },

    // ---- investigations ----
    /** Per-role investigation-mode ceilings: which of Step, Plan and Auto this person may pick. */
    getAiPolicy: () => settle(() => sdk.GET("/v1/ai/policy", init())),
    listInvestigations: () => settle(() => sdk.GET("/v1/investigations", { params: { query: {} }, ...init() })),
    getInvestigation: (invId: string) => settle(() => sdk.GET("/v1/investigations/{id}", { params: id(invId), ...init() })),
    /** Not a command: the client names the investigation id (its idempotency key). The same body again replays. */
    createInvestigation: (body: Schemas["V1InvestigationCreateRequest"]) => settle(() => sdk.POST("/v1/investigations", { body, ...init() })),
    /** Runs exactly step `step_no` (= steps_done + 1, the idempotency key): a replay of the same step answers the view. */
    continueInvestigation: (invId: string, stepNo: number) => settle(() => sdk.POST("/v1/investigations/{id}:continue", { params: id(invId), body: { step_no: stepNo }, ...init(PLAN_TIMEOUT_MS) })),
    cancelInvestigation: (invId: string) => settle(() => sdk.POST("/v1/investigations/{id}:cancel", { params: id(invId), body: {}, ...init() })),
    approvePlan: (invId: string, mode: "plan" | "auto") => settle(() => sdk.POST("/v1/investigations/{id}:approve-plan", { params: id(invId), body: { mode }, ...init(PLAN_TIMEOUT_MS) })),

    // ---- brands, the storefront page, campaigns ----
    listBrands: () => settle(() => sdk.GET("/v1/brands", init())),
    listStorefrontPages: () => settle(() => sdk.GET("/v1/storefront-pages", init())),
    getStorefrontPage: (pageId: string) => settle(() => sdk.GET("/v1/storefront-pages/{id}", { params: id(pageId), ...init() })),
    /** 201. The next version number; 409 page_version_stale when someone else saved since this editor loaded. */
    saveStorefrontPage: (body: SavePageCommand) => settle(() => sdk.POST("/v1/storefront-pages", { body, ...init() })),
    publishStorefrontPage: (pageId: string, body: PublishPageCommand) => settle(() => sdk.POST("/v1/storefront-pages/{id}:publish", { params: id(pageId), body, ...init() })),
    listCampaigns: () => settle(() => sdk.GET("/v1/campaigns", init())),
    cancelCampaign: (body: CancelCampaignCommand) => settle(() => sdk.POST("/v1/campaigns:cancel", { body, ...init() })),
    /** Demo businesses only: records a queued campaign as sent (simulated). No message ever leaves Munim. */
    recordCampaignSent: (body: RecordSentCommand) => settle(() => sdk.POST("/v1/campaigns:record-sent", { body, ...init() })),

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
    /** 201. A person asks the simulated suppliers to quote one ingredient for outlets in their scope; a purchase order comes
     *  back only as a draft to approve. What came of it is in two headers on the first answer only (`negotiation`, a status
     *  code, and `draftId`); a replay of the same envelope carries neither. Resend only the same envelope: a new one starts a
     *  second negotiation. */
    requestQuotes: async (body: RfqCommand) => {
      const outcome = { negotiation: null as string | null, draftId: null as string | null };
      const result = await settle(async () => {
        const a = await sdk.POST("/v1/rfq-requests", { body, ...init(RFQ_TIMEOUT_MS) });
        outcome.negotiation = a.response.headers.get("X-Munim-Negotiation");
        outcome.draftId = a.response.headers.get("X-Munim-Draft-Id");
        return a;
      });
      return { result, ...outcome };
    },
    listIngredients: (outletId?: string) => settle(() => sdk.GET("/v1/inventory/ingredients", { params: { query: outletId ? { outlet: outletId } : {} }, ...init() })),
    listReorderLevels: (outletId: string) => settle(() => sdk.GET("/v1/inventory/reorder-levels", { params: { query: { outlet: outletId } }, ...init() })),
    /** Goods received in the person's outlets, newest first (15). */
    listGoodsReceived: () => settle(() => sdk.GET("/v1/goods-received", init())),
    getGoodsReceived: (grnId: string) => settle(() => sdk.GET("/v1/goods-received/{id}", { params: id(grnId), ...init() })),
    /** 201. Stock in at one outlet, optionally against a purchase order (owner, manager, staff). */
    receiveGoods: (body: ReceiveGoodsCommand) => settle(() => sdk.POST("/v1/goods-received", { body, ...init() })),
  };
}

export type StaffClient = ReturnType<typeof createStaffClient>;
