// file: mock-server/staff.ts
// The member half of the mock: the routes the staff screens call, served at /mock/v1/* beside the storefront routes.
// It keeps the books in memory, per server instance (03 §2 says what that cannot do), and copies core's rules where
// a screen depends on them: who may do what, 401 / 404 / 403, one-step transitions with 409s, idempotency replay,
// draft approval (cannot_verify, already_decided, stale_draft), ids-only live events. Synthetic data only.
import { createHash } from "node:crypto";
import type { Schemas } from "@/lib/munim/types";
import { DEMO_TENANT_ID } from "@/lib/munim/session";
import { CHANNEL_ID, CURRENCY, ITEMS, id7, itemId } from "./data";
import { BadRequest, outletById, price } from "./pricing";
import {
  CARES_PROFILE, CHANNELS, COUNTER_CHANNEL_ID, DEVICES, INGREDIENTS, MEMBERS, MEMBER_OUTLETS, RECIPIENTS, SPECIALISTS, TEMPLATE_COLUMNS, TEMPLATE_MIN_ROLE, TENANT,
  addressedTo, answerFor, boardOf, buildOrder, businessDate, menuFor, mintRows, orderListItem, posDevice, reorderLevels, seedDrafts, seedFindings, seedListings,
  seedGoodsReceived, seedOrders, seedPurchaseOrders, seedSnapshots, seedSuppliers, seedThreads, snapshotOf, type Placed, type SeedDraft,
} from "./staff-data";

type S = Schemas;
type Me = S["V1Me"];
type ErrorCode = S["Error"]["error"]["code"];
type Json = Record<string, unknown>;

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const RANK: Record<string, number> = { staff: 1, manager: 2, advisor: 3, owner: 4, judge: 4 };

// ---------------------------------------------------------------- responses
const H = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Munim-Mock": "true" };
export const staffJson = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...H, ...extra } });
const MESSAGE: Partial<Record<ErrorCode, string>> = { unauthenticated: "Sign in again.", not_found: "Not found.", forbidden: "You are not allowed to do this." };
const fail = (status: number, code: ErrorCode, reason: string | null = null, extra: Json = {}) =>
  staffJson(status, { error: { code, message: MESSAGE[code] ?? "This request was refused.", reason_code: reason }, ...extra });
const notFound = () => fail(404, "not_found");
class Refuse extends Error {
  constructor(readonly res: Response) {
    super("refused");
  }
}
const refuse = (status: number, code: ErrorCode, reason: string | null = null, extra: Json = {}): never => {
  throw new Refuse(fail(status, code, reason, extra));
};

// ---------------------------------------------------------------- the books (one copy per server instance)
interface DraftState {
  sd: SeedDraft;
  decision: S["V1DraftDetail"]["decision"];
  history: S["V1DraftDetail"]["history"];
}
interface LiveEvent {
  seq: number;
  outletId: string | null;
  orderId: string | null;
  inbox: boolean;
  body: { id: string; type: string; data: Json };
}
interface World {
  orders: Map<string, Placed>;
  ticketNo: Map<string, number>;
  invoiceNo: Map<string, number>;
  usedLineIds: Set<string>;
  findings: Map<string, S["V1Finding"]>;
  drafts: Map<string, DraftState>;
  snapshots: Map<string, S["Snapshot"]>;
  threads: Map<string, S["V1Thread"]>;
  listings: Map<string, S["V1CaresListing"]>;
  pos: Map<string, S["V1PurchaseOrder"]>;
  grns: Map<string, S["V1GoodsReceived"]>;
  log: Map<string, { hash: string; status: number; body: unknown }>;
  events: LiveEvent[];
}
let world: World | null = null;

function books(now: Date): World {
  if (world) return world;
  const orders = seedOrders(now);
  world = {
    orders: new Map(orders.map((p) => [p.order.order_id, p])),
    ticketNo: new Map(), invoiceNo: new Map(), usedLineIds: new Set(orders.flatMap((p) => p.order.lines.map((l) => l.line_id))),
    findings: new Map(seedFindings(now).map((f) => [f.finding_id, f])),
    drafts: new Map(seedDrafts(now).map((sd) => [sd.draft.draft_id, { sd, decision: null, history: [{ event: "proposed", at: sd.draft.created_at, by: sd.draft.source }] }])),
    snapshots: new Map(seedSnapshots(now).map((s) => [s.snapshot_id, s])),
    threads: new Map(seedThreads(now).map((t) => [t.thread_id, t])),
    listings: new Map(seedListings(now).map((l) => [l.listing_id, l])),
    pos: new Map(seedPurchaseOrders(now).map((p) => [p.po_id, p])),
    grns: new Map(seedGoodsReceived(now).map((g) => [g.grn_id, g])),
    log: new Map(), events: [],
  };
  for (const p of orders) world.ticketNo.set(p.order.outlet_id, Math.max(world.ticketNo.get(p.order.outlet_id) ?? 0, p.order.ticket_no));
  return world;
}

function emit(w: World, type: string, data: Json, where: { outletId?: string | null; orderId?: string | null; inbox?: boolean }) {
  w.events.push({ seq: w.events.length + 1, outletId: where.outletId ?? null, orderId: where.orderId ?? null, inbox: where.inbox ?? false, body: { id: id7(`event:${w.events.length}:${Date.now()}`), type, data } });
}

// ---------------------------------------------------------------- who is asking
type Who = { m: Me; token: string };
/** 401 without a token the mock knows; 404 for a known token in the wrong (or no) tenant. */
function member(req: Request): Who {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const found = MEMBERS.find((x) => x.token === token);
  if (!found) refuse(401, "unauthenticated");
  if (req.headers.get("X-Munim-Tenant") !== DEMO_TENANT_ID) refuse(404, "not_found");
  return { m: found!.me, token };
}
const sees = (m: Me, outletId: string) => m.outlet_ids === "*" || m.outlet_ids.includes(outletId);
const seesAll = (m: Me, outletIds: readonly string[]) => outletIds.length === 0 ? m.outlet_ids === "*" : outletIds.every((o) => sees(m, o));
/** Role may run this command (core.command_authority); else 403 authority_denied. */
function allow(m: Me, roles: readonly string[], code: ErrorCode = "forbidden") {
  if (!roles.includes(m.role)) refuse(403, code, "authority_denied");
}
const ORDER_ROLES = ["owner", "manager", "staff", "judge"];
const DECIDE_ROLES = ["owner", "manager", "judge"];
/** 14 §10: deciding a draft also needs the draft's own command's authority (cares.listing.publish.v1 is owner and judge). */
const DECIDE_ROLES_BY_TYPE: Record<string, readonly string[]> = { "cares.listing.publish.v1": ["owner", "judge"] };

// ---------------------------------------------------------------- commands
interface Command<P> {
  command_id: string;
  idempotency_key: string;
  type: string;
  payload: P;
}
function envelopeOf<P = Json>(body: unknown, type: string): Command<P> {
  const b = body as Partial<Command<P>> | null;
  if (!b || typeof b !== "object" || !UUID7.test(String(b.command_id)) || !KEY.test(String(b.idempotency_key)) || b.type !== type || typeof b.payload !== "object" || b.payload === null)
    refuse(422, "invalid_payload");
  return b as Command<P>;
}
/** Runs a command once per idempotency key: same key + same request = the stored answer with X-Munim-Replayed;
 *  same key + anything else = 409. A refused command stores nothing, so a retry runs it again. */
function once(w: World, who: Who, cmd: Command<unknown>, status: number, run: () => S["CommandResult"]): Response {
  const hash = createHash("sha256").update(JSON.stringify([who.m.member_id, cmd.command_id, cmd.type, cmd.payload])).digest("hex");
  const prior = w.log.get(cmd.idempotency_key);
  if (prior) return prior.hash === hash ? staffJson(prior.status, prior.body, { "X-Munim-Replayed": "true" }) : fail(409, "idempotency_conflict");
  const body = run();
  w.log.set(cmd.idempotency_key, { hash, status, body });
  return staffJson(status, body);
}
const result = (cmd: Command<unknown>, entityId: string, type = cmd.type): S["CommandResult"] => ({ command_id: cmd.command_id, type, entity_id: entityId, committed_at: new Date().toISOString() });

// ---------------------------------------------------------------- orders and the kitchen
const NEXT_TICKET: Record<string, string> = { queued: "preparing", preparing: "ready", ready: "done" };
const ORDER_STEPS: Record<string, string[]> = { accepted: ["preparing", "cancelled"], preparing: ["ready"], ready: ["completed"], placed: ["cancelled"] };

function setOrderStatus(w: World, p: Placed, to: S["V1Order"]["status"]) {
  const from = p.order.status;
  if (from === to) return;
  p.order.status = to;
  if (to === "completed" || to === "cancelled" || to === "rejected") for (const t of p.tickets) t.status = "done";
  emit(w, "munim.orders.order.status_changed.v1", { order_id: p.order.order_id, outlet_id: p.order.outlet_id, from_status: from, to_status: to }, { outletId: p.order.outlet_id, orderId: p.order.order_id });
}

function placeOrder(w: World, who: Who, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["OrdersPlaceV1"]>(body, "orders.place.v1");
  const p = cmd.payload;
  allow(who.m, ["owner", "manager", "staff", "judge"]);
  if (!outletById(p.outlet_id)) return notFound();
  if (!sees(who.m, p.outlet_id)) refuse(403, "forbidden", "authority_denied");
  const channel = CHANNELS.channels.find((c) => c.id === p.channel_id && c.active);
  if (!channel) return notFound();
  if (!UUID7.test(p.order_id) || !Array.isArray(p.lines) || p.lines.length === 0 || p.loyalty_redeem_points !== 0) refuse(422, "invalid_payload");
  const ids = p.lines.map((l) => l.line_id);
  if (ids.some((x) => !UUID7.test(x)) || new Set(ids).size !== ids.length || p.lines.some((l) => l.note !== null && (typeof l.note !== "string" || l.note.length > 200))) refuse(422, "invalid_payload");
  return once(w, who, cmd, 201, () => {
    if (ids.some((x) => w.usedLineIds.has(x)) || w.orders.has(p.order_id)) refuse(422, "invalid_payload");
    const ticketNo = (w.ticketNo.get(p.outlet_id) ?? 0) + 1;
    const invoiceNo = p.device_id ? (w.invoiceNo.get(p.device_id) ?? 100) + 1 : null;
    const built = buildOrder({
      orderId: p.order_id, outletId: p.outlet_id, ticketNo, channelId: p.channel_id, deviceId: p.device_id, invoiceNo, kind: p.kind, tableRef: p.table_ref,
      status: "placed", createdAt: now.toISOString(), promisedAt: p.promised_at, lines: p.lines.map((l) => ({ line_id: l.line_id, item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli, note: l.note })),
    }, now);
    if (built.refusal) refuse(409, "conflict", built.refusal);
    if (p.preview_total_minor !== null && p.preview_total_minor !== built.totalMinor) refuse(409, "conflict", "preview_total_changed");
    w.ticketNo.set(p.outlet_id, ticketNo);
    if (p.device_id && invoiceNo) w.invoiceNo.set(p.device_id, invoiceNo);
    ids.forEach((x) => w.usedLineIds.add(x));
    w.orders.set(p.order_id, built.placed);
    emit(w, "munim.orders.order.placed.v1", { order_id: p.order_id, outlet_id: p.outlet_id, channel_id: p.channel_id, status: "placed", placed_at: now.toISOString() }, { outletId: p.outlet_id, orderId: p.order_id });
    for (const t of built.placed.tickets) emit(w, "munim.kitchen.ticket.created.v1", { ticket_id: t.ticket_id, order_id: t.order_id, outlet_id: t.outlet_id, station: t.station, status: t.status }, { outletId: t.outlet_id, orderId: t.order_id });
    return result(cmd, p.order_id);
  });
}

function preview(body: unknown, who: Who, now: Date): Response {
  const b = body as S["OrdersPreviewRequest"];
  const outlet = outletById(b?.outlet_id);
  if (!outlet) return notFound();
  if (!sees(who.m, outlet.outlet_id)) return notFound();
  if (!["dine_in", "takeaway", "pickup", "delivery"].includes(b.kind)) refuse(422, "invalid_payload");
  const { preview: p } = price({ ...b, kind: "pickup" }, outlet, "open", now);
  const out: S["OrdersPreviewResponse"] = p.refusals.length > 0
    ? { label: "preview", priced_at: p.priced_at, currency: p.currency, tax_rule: p.tax_rule, lines: [], subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0, refusals: p.refusals.map((r) => ({ line_no: r.line_no, reason_code: r.reason_code })) }
    : {
        label: "preview", priced_at: p.priced_at, currency: p.currency, tax_rule: p.tax_rule, refusals: [],
        lines: p.lines.map((l) => ({ line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, qty_milli: l.qty_milli, unit_price_minor: l.unit_price_minor, options_minor: l.options_minor, line_discount_minor: l.line_discount_minor, tax_class: l.tax_class, tax_minor: l.tax_minor, line_total_minor: l.line_total_minor, price_ref: l.price_ref, option_refs: l.option_refs, deal_refs: l.deal_refs, coupon_refs: l.coupon_refs })),
        subtotal_minor: p.subtotal_minor, discount_minor: p.discount_minor, tax_minor: p.tax_minor, total_minor: p.total_minor,
      };
  return staffJson(200, out);
}

function orderCommand(w: World, who: Who, orderId: string, verb: string, body: unknown): Response {
  const type = verb === "accept" ? "orders.order.accept.v1" : verb === "reject" ? "orders.order.reject.v1" : "orders.order.advance.v1";
  const cmd = envelopeOf<{ order_id: string; from_status?: string; to_status?: string; reason_code?: string | null }>(body, type);
  if (cmd.payload.order_id !== orderId) refuse(422, "invalid_payload");
  allow(who.m, ORDER_ROLES);
  const p = w.orders.get(orderId);
  if (!p || !sees(who.m, p.order.outlet_id)) return notFound();
  return once(w, who, cmd, 200, () => {
    const from = p.order.status;
    if (verb === "accept") {
      if (from !== "placed") refuse(409, "illegal_transition");
      setOrderStatus(w, p, "accepted");
    } else if (verb === "reject") {
      if (!cmd.payload.reason_code) refuse(422, "invalid_payload", "reason_required");
      if (from !== "placed") refuse(409, "illegal_transition");
      if (p.order.tenders.length > 0) refuse(409, "conflict", "refund_first");
      setOrderStatus(w, p, "rejected");
    } else {
      const to = cmd.payload.to_status!;
      if (to === "cancelled" && !cmd.payload.reason_code) refuse(422, "invalid_payload", "reason_required");
      if (cmd.payload.from_status !== from || !(ORDER_STEPS[from] ?? []).includes(to)) refuse(409, "illegal_transition");
      if (to === "cancelled" && p.order.tenders.length > 0) refuse(409, "conflict", "refund_first");
      setOrderStatus(w, p, to as S["V1Order"]["status"]);
    }
    return result(cmd, orderId);
  });
}

/** Recorded only. Cash: core takes the due amount rounded to the pack's cash step (₹1 here) and records the change. */
function tender(w: World, who: Who, orderId: string, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["OrdersTenderRecordV1"]>(body, "orders.tender.record.v1");
  const t = cmd.payload;
  const cash = t.method === "cash";
  if (t.order_id !== orderId || !UUID7.test(t.tender_id) || !["cash", "card", "upi"].includes(t.method) || cash !== (t.tendered_minor !== null) || cash !== (t.amount_minor === null)) refuse(422, "invalid_payload");
  allow(who.m, ORDER_ROLES);
  const p = w.orders.get(orderId);
  if (!p || !sees(who.m, p.order.outlet_id)) return notFound();
  return once(w, who, cmd, 200, () => {
    const o = p.order;
    if (o.status === "cancelled" || o.status === "rejected") refuse(409, "illegal_transition");
    if (t.currency !== CURRENCY) refuse(422, "currency_mismatch");
    if (o.remaining_minor === 0) refuse(409, "conflict");
    const base = { tender_id: t.tender_id, order_id: orderId, method: t.method, currency: CURRENCY, ref: t.ref, recorded_by: who.m.member_id, at: now.toISOString() };
    if (cash) {
      const due = Math.round(o.remaining_minor / 100) * 100;
      if (due === 0) refuse(409, "conflict", "cash_below_rounding");
      const tendered = t.tendered_minor!;
      const full = tendered >= due;
      o.tenders.push({ ...base, amount_minor: full ? due : tendered, tendered_minor: tendered, change_minor: full ? tendered - due : 0, rounding_minor: full ? due - o.remaining_minor : 0, ref: null });
      o.paid_minor += full ? o.remaining_minor : tendered;
    } else {
      if (t.amount_minor! > o.remaining_minor) refuse(422, "invalid_payload");
      o.tenders.push({ ...base, amount_minor: t.amount_minor!, tendered_minor: null, change_minor: null, rounding_minor: null });
      o.paid_minor += t.amount_minor!;
    }
    o.remaining_minor = Math.max(o.total_minor - o.loyalty_minor - o.paid_minor, 0);
    emit(w, "munim.orders.tender.recorded.v1", { tender_id: t.tender_id, order_id: orderId, outlet_id: o.outlet_id, method: t.method }, { outletId: o.outlet_id, orderId });
    return result(cmd, t.tender_id);
  });
}

/** One step forward only, guarded by from_status. The order follows its tickets (core's rule): the first ticket
 *  started makes it preparing, all ready makes it ready, all done completes it (even unpaid: take payment first). */
function advanceTicket(w: World, who: Who, ticketId: string, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["KitchenTicketAdvanceV1"]>(body, "kitchen.ticket.advance.v1");
  if (cmd.payload.ticket_id !== ticketId) refuse(422, "invalid_payload");
  allow(who.m, ORDER_ROLES);
  const p = [...w.orders.values()].find((x) => x.tickets.some((t) => t.ticket_id === ticketId));
  if (!p || !sees(who.m, p.order.outlet_id)) return notFound();
  const t = p.tickets.find((x) => x.ticket_id === ticketId)!;
  return once(w, who, cmd, 200, () => {
    const { from_status, to_status } = cmd.payload;
    if (t.status !== from_status || NEXT_TICKET[from_status] !== to_status || ["rejected", "cancelled"].includes(p.order.status)) refuse(409, "illegal_transition");
    t.status = to_status;
    if (to_status === "preparing") t.accepted_at = now.toISOString();
    if (to_status === "ready") t.ready_at = now.toISOString();
    emit(w, "munim.kitchen.ticket.advanced.v1", { ticket_id: t.ticket_id, order_id: t.order_id, outlet_id: t.outlet_id, station: t.station, status: t.status, from_status }, { outletId: t.outlet_id, orderId: t.order_id });
    const all = (ok: string[]) => p.tickets.every((x) => ok.includes(x.status));
    if (to_status === "preparing" && (p.order.status === "placed" || p.order.status === "accepted")) {
      if (p.order.status === "placed") setOrderStatus(w, p, "accepted");
      setOrderStatus(w, p, "preparing");
    }
    if (all(["done"])) setOrderStatus(w, p, "completed");
    else if (all(["ready", "done"]) && p.order.status === "preparing") setOrderStatus(w, p, "ready");
    return result(cmd, ticketId);
  });
}

// ---------------------------------------------------------------- inbox and approvals
const visibleDraft = (m: Me, d: DraftState) => seesAll(m, d.sd.draft.outlet_ids);
const detailOf = (d: DraftState): S["V1DraftDetail"] => ({ draft: d.sd.draft, decision: d.decision, unverified_refs: d.sd.draft.status === "proposed" ? d.sd.unverified : [], history: d.history });

/** JSON Pointer paths of every numeric leaf that is still a ref (string starting with ⟨). */
function refLeaves(x: unknown, path = ""): { path: string; ref: string }[] {
  if (typeof x === "string") return x.startsWith("⟨") ? [{ path, ref: x }] : [];
  if (Array.isArray(x)) return x.flatMap((v, i) => refLeaves(v, `${path}/${i}`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) => ("value" in (x as Json) && "typed_by" in (x as Json) ? [] : refLeaves(v, `${path}/${k}`)));
  return [];
}
function editsOf(x: unknown, path = ""): { path: string; value: unknown; typed_by: unknown }[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => editsOf(v, `${path}/${i}`));
  if (x && typeof x === "object") {
    const o = x as Json;
    if ("value" in o && "typed_by" in o) return [{ path, value: o.value, typed_by: o.typed_by }];
    return Object.entries(o).flatMap(([k, v]) => editsOf(v, `${path}/${k}`));
  }
  return [];
}
/** The final payload: each ref replaced by its resolved value, each edit by what the person typed. */
function finalOf(x: unknown, resolved: Map<string, unknown>, path = ""): unknown {
  if (typeof x === "string" && x.startsWith("⟨")) return resolved.get(path);
  if (Array.isArray(x)) return x.map((v, i) => finalOf(v, resolved, `${path}/${i}`));
  if (x && typeof x === "object") {
    const o = x as Json;
    if ("value" in o && "typed_by" in o) return o.value;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, finalOf(v, resolved, `${path}/${k}`)]));
  }
  return x;
}

function decide(w: World, who: Who, draftId: string, verb: "approve" | "reject", body: unknown, req: Request, now: Date): Response {
  const cmd = envelopeOf<S["DraftsApproveV1"] & S["DraftsRejectV1"]>(body, verb === "approve" ? "drafts.approve.v1" : "drafts.reject.v1");
  const p = cmd.payload;
  if (p.draft_id !== draftId) refuse(422, "invalid_payload");
  const d = w.drafts.get(draftId);
  if (!d || !visibleDraft(who.m, d)) return notFound();
  allow(who.m, DECIDE_ROLES_BY_TYPE[d.sd.draft.command_type] ?? DECIDE_ROLES);
  if (d.sd.draft.outlet_ids.length === 0 && who.m.outlet_ids !== "*") refuse(403, "forbidden", "authority_denied");
  const by = { member_id: who.m.member_id, name: who.m.name };
  return once(w, who, cmd, 200, () => {
    const forced = req.headers.get("X-Mock-Force-Decision");
    if (d.sd.draft.status !== "proposed" || forced === "already_decided") refuse(409, "already_decided");
    if (verb === "reject") {
      if (typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 500) refuse(422, "invalid_payload");
      d.sd.draft.status = "rejected";
      d.decision = { decision_id: id7(`decision:${draftId}`), verdict: "rejected", reason: p.reason, decided_by: by, decided_at: now.toISOString() };
      d.history.push({ event: "rejected", at: now.toISOString(), by, reason: p.reason, decision_id: d.decision.decision_id });
      d.sd.draft.updated_at = now.toISOString();
      emit(w, "inbox.draft", { status: "rejected", command_type: d.sd.draft.command_type, outlet_ids: d.sd.draft.outlet_ids, finding_id: d.sd.draft.finding_id, updated_at: now.toISOString() }, { inbox: true });
      return result(cmd, draftId);
    }
    if (p.command_type !== d.sd.draft.command_type) refuse(422, "invalid_payload");
    if (forced === "stale") {
      const b = d.sd.draft.based_on[0]!;
      d.sd.draft.status = "stale";
      d.history.push({ event: "stale", at: now.toISOString(), by, changes: [{ ref: b.ref, value: b.expected, now_ref: null, now: null }] });
      refuse(409, "stale_draft", "stale_draft", { changes: [{ ref: b.ref, value: b.expected, now_ref: null, now: null }] });
    }
    const edited = p.edited_payload ?? null;
    const proposed = refLeaves(d.sd.draft.payload);
    let left = proposed;
    if (edited) {
      const edits = editsOf(edited);
      if (edits.some((e) => e.typed_by !== who.m.member_id || typeof e.value !== "number")) refuse(422, "invalid_payload");
      const kept = refLeaves(edited);
      if (kept.some((k) => !proposed.some((x) => x.path === k.path && x.ref === k.ref))) refuse(422, "invalid_payload");
      left = kept;
    }
    const stillUnverified = left.filter((l) => d.sd.unverified.includes(l.ref)).map((l) => l.ref);
    if (stillUnverified.length > 0) refuse(422, "cannot_verify", "unresolved_ref", { refs: stillUnverified });
    if (forced === "execution_failed") refuse(422, "execution_failed");
    const resolved = new Map<string, unknown>(d.sd.draft.resolved_refs.map((r) => [r.path, r.value]));
    const final = finalOf(edited ?? d.sd.draft.payload, resolved) as Json;
    const entity = execute(w, d.sd.draft.command_type, final, now, who.m.member_id);
    const verdict = edited ? "edited" : "approved";
    d.decision = { decision_id: id7(`decision:${draftId}`), verdict, reason: p.reason ?? null, decided_by: by, decided_at: now.toISOString() };
    if (edited) d.sd.draft.payload = edited as S["V1Draft"]["payload"];
    d.sd.draft.status = "executed";
    d.sd.draft.updated_at = now.toISOString();
    d.history.push({ event: verdict, at: now.toISOString(), by, reason: p.reason ?? null, decision_id: d.decision.decision_id }, { event: "executed", at: now.toISOString(), by });
    emit(w, "inbox.draft", { status: "executed", command_type: d.sd.draft.command_type, outlet_ids: d.sd.draft.outlet_ids, finding_id: d.sd.draft.finding_id, updated_at: now.toISOString() }, { inbox: true });
    return result(cmd, entity, d.sd.draft.command_type);
  });
}

/** Applies an approved draft's final payload, under the approver. Returns the entity it made. */
function execute(w: World, type: string, payload: Json, now: Date, by: string): string {
  if (type === "cares.listing.publish.v1") {
    const p = payload as unknown as S["CaresListingPublishV1"];
    storeListing(w, p, by, now);
    return p.listing_id;
  }
  if (type === "purchasing.po.create.v1") {
    const p = payload as unknown as S["PurchasingPoCreateV1"];
    const supplier = seedSuppliers(now).find((s) => s.supplier_id === p.supplier_id)!;
    w.pos.set(p.po_id, {
      po_id: p.po_id, supplier: { supplier_id: supplier.supplier_id, name: supplier.name, kind: supplier.kind, label: supplier.label }, outlet_ids: p.outlet_ids, status: "committed",
      currency: p.currency, total_minor: p.lines.reduce((s, l) => s + Math.round((l.qty_milli * l.unit_price_minor) / 1000), 0), expected_on: p.expected_on, negotiation_run_id: p.negotiation_run_id,
      created_at: now.toISOString(), lines: p.lines.map((l, i) => ({ po_line_id: id7(`po_line:${p.po_id}:${i}`), line_no: i + 1, ingredient_id: l.ingredient_id, qty_milli: l.qty_milli, unit: l.unit, unit_price_minor: l.unit_price_minor })),
    });
    return p.po_id;
  }
  if (type === "kitchen.prep_list.create.v1") return String(payload.prep_list_id);
  return id7(`${type}:${JSON.stringify(payload)}`); // prep_time.set: a new prep-time row
}

function inbox(w: World, m: Me): S["V1InboxResponse"] {
  const items: S["V1InboxResponse"]["items"] = [
    ...[...w.findings.values()].filter((f) => f.status === "open").map((finding) => ({ kind: "finding" as const, finding })),
    ...[...w.drafts.values()].filter((d) => d.sd.draft.status === "proposed" && visibleDraft(m, d)).map((d) => ({ kind: "draft" as const, draft: d.sd.draft })),
  ];
  const updated = (i: (typeof items)[number]) => (i.kind === "finding" ? i.finding.updated_at : i.draft.updated_at);
  items.sort((a, b) => updated(b).localeCompare(updated(a)));
  return { items, next_cursor: null };
}

// ---------------------------------------------------------------- snapshots
function mint(w: World, who: Who, body: unknown, now: Date): Response {
  const b = body as S["V1SnapshotsRequest"] | null;
  const template = b?.template_id ?? "";
  const cols = TEMPLATE_COLUMNS[template];
  if (!cols || RANK[who.m.role]! < RANK[TEMPLATE_MIN_ROLE[template]!]!) return notFound();
  const params = b?.params ?? {};
  const required: Record<string, string[]> = {
    "kitchen.ticket_coverage": ["outlet_id", "from", "to"], "people.labour_pct": ["outlet_id", "from", "to"], "cares.impact": ["outlet_id", "from", "to"],
    "inventory.waste_week": ["outlet_id", "week_start"], "inventory.below_reorder": [], "purchasing.quote_compare": ["negotiation_run_id"],
    "inventory.expiry_risk": ["outlet_id", "days", "as_of"],
    "cares.recipient_match": ["outlet_id", "needs_cooked", "needs_raw", "needs_packaged", "qty_milli", "unit", "expires_on"],
  };
  const keys = Object.keys(params);
  if (keys.some((k) => !required[template]!.includes(k)) || required[template]!.some((k) => !(k in params))) refuse(422, "invalid_payload");
  if (typeof params.outlet_id === "string" && !sees(who.m, params.outlet_id)) refuse(403, "forbidden");
  const rows = mintRows(template, params, w.orders, [...w.listings.values()], now)!;
  const scope = typeof params.outlet_id === "string" ? [params.outlet_id] : who.m.outlet_ids === "*" ? ["*"] : who.m.outlet_ids;
  const s = snapshotOf(id7(`snap:minted:${w.snapshots.size}:${now.getTime()}`), template, params, cols, rows, { member: who.m.member_id }, scope as S["Snapshot"]["outlet_scope"], now.toISOString());
  w.snapshots.set(s.snapshot_id, s);
  return staffJson(201, s);
}
function openSnapshot(w: World, who: Who, id: string): Response {
  const s = w.snapshots.get(id);
  if (!s || RANK[who.m.role]! < RANK[TEMPLATE_MIN_ROLE[s.template_id] ?? "owner"]!) return notFound();
  const scope = s.outlet_scope as string[];
  if (scope[0] === "*" ? who.m.outlet_ids !== "*" : !scope.every((o) => sees(who.m, o))) return notFound();
  return staffJson(200, s);
}

// ---------------------------------------------------------------- Ask
function ask(w: World, who: Who, body: unknown, req: Request, now: Date): Response {
  const b = body as S["V1AskRequest"] | null;
  const question = typeof b?.question === "string" ? b.question.trim() : "";
  if (question.length < 1 || question.length > 2000 || (b?.thread_id !== undefined && !UUID7.test(b.thread_id))) return fail(400, "bad_request");
  const forced = req.headers.get("X-Mock-Force-Ai");
  if (forced === "off") return fail(503, "unavailable");
  const existing = b?.thread_id ? w.threads.get(b.thread_id) : undefined;
  if (b?.thread_id && !existing) return notFound();
  const addressed = addressedTo(question) ?? existing?.specialist ?? null;
  const answerId = id7(`answer:${now.getTime()}:${w.threads.size}`);
  const answer = forced === "abstain"
    ? { answer_id: answerId, signature: { key: "answer.signature.manager" as const, specialist: "manager" as const, name_key: "specialist.manager.name" }, envelope: { answer_id: answerId, abstained: true, reason_code: "model_blocked" as const, follow_up: null, segments: [] }, resolved_refs: [] }
    : answerFor(question, addressed, answerId, now);
  const thread: S["V1Thread"] = existing ?? { thread_id: id7(`thread:${now.getTime()}`), specialist: addressedTo(question), created_by: who.m.member_id, outlet_scope: who.m.outlet_ids === "*" ? ["*"] : who.m.outlet_ids, created_at: now.toISOString(), updated_at: now.toISOString(), summary: [], turns: [] };
  const turn = { turn_id: id7(`turn:${answerId}`), turn_no: thread.turns.length + 1, member_id: who.m.member_id, addressed_to: addressed, tainted: false, question, answer, created_at: now.toISOString() };
  thread.turns.push(turn);
  thread.updated_at = now.toISOString();
  w.threads.set(thread.thread_id, thread);
  return staffJson(200, { thread_id: thread.thread_id, turn: { turn_id: turn.turn_id, turn_no: turn.turn_no, addressed_to: addressed, tainted: false }, answer } satisfies S["V1AskResponse"]);
}

// ---------------------------------------------------------------- Cares and purchasing
function publishListing(w: World, who: Who, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["CaresListingPublishV1"]>(body, "cares.listing.publish.v1");
  const p = cmd.payload;
  allow(who.m, ["owner", "judge"], "book_write_refused");
  if (!outletById(p.outlet_id) || !sees(who.m, p.outlet_id)) return notFound();
  if (!Array.isArray(p.lines) || p.lines.length === 0 || p.lines.some((l) => !UUID7.test(l.line_id) || (l.item_id === null) === (l.ingredient_id === null) || (l.food_kind === "cooked" && l.unit !== "portion"))) refuse(422, "invalid_payload");
  return once(w, who, cmd, 200, () => {
    if (p.kind === "offer") refuse(409, "conflict", "offer_not_enabled");
    const r = RECIPIENTS.items.find((x) => x.recipient_id === p.recipient_id);
    const accepts = (k: string) => (k === "cooked" ? r?.accepts_cooked : k === "raw" ? r?.accepts_raw : r?.accepts_packaged);
    // Core sends these two as 422 invalid_payload (14 §4.4), not 409.
    if (!r || p.lines.some((l) => !accepts(l.food_kind) || l.unit_price_minor !== null)) refuse(422, "invalid_payload", "recipient_ineligible");
    if (Date.parse(p.pickup_to) <= now.getTime()) refuse(422, "invalid_payload", "listing_expired");
    storeListing(w, p, who.m.member_id, now);
    return result(cmd, p.listing_id);
  });
}
/** A published donation, under the person who published it (their own command, or their approval of a draft). */
function storeListing(w: World, p: S["CaresListingPublishV1"], by: string, now: Date) {
  w.listings.set(p.listing_id, {
    listing_id: p.listing_id, outlet_id: p.outlet_id, kind: p.kind, status: "published", recipient_id: p.recipient_id, pickup_from: p.pickup_from, pickup_to: p.pickup_to,
    pickup_on: businessDate(new Date(p.pickup_from)), published_by: by, published_at: now.toISOString(),
    lines: p.lines.map((l, i) => ({ line_id: l.line_id, line_no: i + 1, food_kind: l.food_kind, item_id: l.item_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: l.qty_milli, unit: l.unit, expires_on: l.expires_on, unit_price_minor: null, currency: null })),
    handovers: [], ...{ labels: CARES_PROFILE.labels, note_key: CARES_PROFILE.note_key },
  });
}
function withdrawListing(w: World, who: Who, id: string, body: unknown): Response {
  const cmd = envelopeOf<S["CaresListingWithdrawV1"]>(body, "cares.listing.withdraw.v1");
  if (cmd.payload.listing_id !== id) refuse(422, "invalid_payload");
  allow(who.m, ["owner", "manager", "judge"], "book_write_refused");
  const l = w.listings.get(id);
  if (!l || !sees(who.m, l.outlet_id)) return notFound();
  return once(w, who, cmd, 200, () => {
    if (l.status !== "published") refuse(409, "illegal_transition");
    l.status = "withdrawn";
    return result(cmd, id);
  });
}
function recordHandover(w: World, who: Who, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["CaresHandoverRecordV1"]>(body, "cares.handover.record.v1");
  const p = cmd.payload;
  allow(who.m, ["owner", "manager", "staff", "judge"], "book_write_refused");
  const l = w.listings.get(p.listing_id);
  if (!l || !sees(who.m, l.outlet_id)) return notFound();
  return once(w, who, cmd, 200, () => {
    if (l.status !== "published") refuse(409, "illegal_transition");
    const given = (lineId: string) => l.handovers.filter((h) => h.status === "recorded").reduce((s, h) => s + (h.lines.find((x) => x.listing_line_id === lineId)?.qty_milli ?? 0), 0);
    for (const x of p.lines) {
      const line = l.lines.find((y) => y.line_id === x.listing_line_id);
      if (!line) refuse(422, "invalid_payload");
      if (given(x.listing_line_id) + x.qty_milli > line!.qty_milli) refuse(409, "conflict", "qty_exceeds_listed");
    }
    l.handovers.push({ handover_id: p.handover_id, allocation_id: null, status: "recorded", handed_at: now.toISOString(), recorded_by: who.m.member_id, voided_by: null, void_reason_code: null, lines: p.lines });
    if (l.lines.every((y) => given(y.line_id) >= y.qty_milli)) l.status = "closed";
    return result(cmd, p.handover_id);
  });
}
function createPo(w: World, who: Who, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["PurchasingPoCreateV1"]>(body, "purchasing.po.create.v1");
  const p = cmd.payload;
  allow(who.m, DECIDE_ROLES);
  if (!Array.isArray(p.outlet_ids) || p.outlet_ids.length === 0 || !Array.isArray(p.lines) || p.lines.length === 0) refuse(422, "invalid_payload");
  if (!p.outlet_ids.every((o) => sees(who.m, o))) refuse(403, "forbidden", "authority_denied");
  if (!seedSuppliers(now).some((s) => s.supplier_id === p.supplier_id)) return notFound();
  return once(w, who, cmd, 201, () => result(cmd, execute(w, "purchasing.po.create.v1", p as unknown as Json, now, who.m.member_id)));
}

/** 15 §10: purchasing.grn.receive.v1 with core's rules. A batch for batch-tracked stock and none for the rest (400);
 *  the order line's price when the cost is null; 409 for an order that is not committed; the order is received once
 *  every line has come in (judged only for someone who sees all the order's outlets). */
function receiveGoods(w: World, who: Who, body: unknown, now: Date): Response {
  const cmd = envelopeOf<S["PurchasingGrnReceiveV1"]>(body, "purchasing.grn.receive.v1");
  const p = cmd.payload;
  allow(who.m, ["owner", "manager", "staff", "judge"]);
  if (!UUID7.test(p.grn_id) || !Array.isArray(p.lines) || p.lines.length === 0 || p.lines.some((l) => !UUID7.test(l.grn_line_id) || !(l.qty_milli > 0))) refuse(422, "invalid_payload");
  if (!outletById(p.outlet_id)) return notFound();
  if (!sees(who.m, p.outlet_id)) refuse(403, "forbidden", "authority_denied");
  const supplier = seedSuppliers(now).find((x) => x.supplier_id === p.supplier_id && x.active);
  if (!supplier) refuse(400, "bad_request");
  const po = p.po_id ? w.pos.get(p.po_id) : null;
  if (p.po_id && (!po || !po.outlet_ids.some((o) => sees(who.m, o)))) return notFound();
  return once(w, who, cmd, 201, () => {
    if (po && (po.status !== "committed" || po.supplier.supplier_id !== p.supplier_id || !po.outlet_ids.includes(p.outlet_id))) refuse(409, "conflict");
    const lines = p.lines.map((l) => {
      const ing = INGREDIENTS.items.find((i) => i.ingredient_id === l.ingredient_id);
      const poLine = po ? po.lines.find((x) => x.po_line_id === l.po_line_id) : null;
      if (!ing || (po && (!poLine || poLine.ingredient_id !== l.ingredient_id)) || ing.tracked_by_batch !== (l.batch !== null)) refuse(400, "bad_request");
      if (l.currency !== CURRENCY) refuse(422, "currency_mismatch");
      const cost = l.unit_cost_minor ?? poLine?.unit_price_minor;
      if (cost === undefined || cost === null) refuse(400, "bad_request");
      return { grn_line_id: l.grn_line_id, po_line_id: l.po_line_id, ingredient_id: l.ingredient_id, batch_id: l.batch?.batch_id ?? null, qty_milli: l.qty_milli, unit: l.unit, unit_cost_minor: cost!, currency: CURRENCY };
    });
    w.grns.set(p.grn_id, { grn_id: p.grn_id, outlet_id: p.outlet_id, supplier: { supplier_id: supplier!.supplier_id, name: supplier!.name, kind: supplier!.kind, label: supplier!.label }, po_id: p.po_id, received_at: p.received_at ?? now.toISOString(), received_by: who.m.member_id, note: p.note, lines });
    if (po && seesAll(who.m, po.outlet_ids)) {
      const got = (poLineId: string) => [...w.grns.values()].filter((g) => g.po_id === po.po_id).reduce((t, g) => t + g.lines.filter((x) => x.po_line_id === poLineId).reduce((u, x) => u + x.qty_milli, 0), 0);
      if (po.lines.every((l) => got(l.po_line_id) >= l.qty_milli)) po.status = "received";
    }
    return result(cmd, p.grn_id);
  });
}

// ---------------------------------------------------------------- live updates
function stream(w: World, who: Who, url: URL, req: Request): Response {
  const topics = (url.searchParams.get("topics") ?? "").split(",").filter(Boolean);
  if (topics.length === 0 || topics.length > 10) return fail(400, "bad_request");
  for (const t of topics) {
    const [kind, id] = t.split(":");
    const ok = kind === "kds" ? !!id && !!outletById(id) && sees(who.m, id)
      : kind === "order" ? !!id && w.orders.has(id) && sees(who.m, w.orders.get(id)!.order.outlet_id)
      : kind === "inbox" ? id === DEMO_TENANT_ID && (who.m.role === "owner" || who.m.role === "manager")
      : false;
    if (!ok) return notFound(); // any topic this person may not read refuses the whole request, never a 403
  }
  const wants = (e: LiveEvent) => topics.some((t) => {
    const [kind, id] = t.split(":");
    return (kind === "kds" && e.outletId === id) || (kind === "order" && e.orderId === id) || (kind === "inbox" && e.inbox);
  });
  const last = /^o=(\d+)$/.exec(req.headers.get("Last-Event-ID") ?? "");
  let cursor = last ? Number(last[1]) : w.events.length;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      const opened = Date.now();
      let beat = opened;
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
      send(`retry: 1000\nid: o=${cursor}\nevent: ready\ndata: {}\n\n`);
      const tick = () => {
        while (cursor < w.events.length) {
          const e = w.events[cursor]!;
          cursor++;
          if (wants(e)) send(`id: o=${cursor}\ndata: ${JSON.stringify(e.body)}\n\n`);
        }
        if (Date.now() - beat >= 20_000) {
          send(": hb\n\n");
          beat = Date.now();
        }
        if (Date.now() - opened >= 50_000) {
          send(`event: reconnect\ndata: {"reason":"max_age"}\n\n`);
          stop();
        }
      };
      timer = setInterval(tick, 500);
      req.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Munim-Mock": "true" } });
}

/** Mock only: a synthetic web order at the outlet, so the kitchen gets a pickup ticket (03 §2). */
function webOrder(w: World, who: Who, body: unknown, now: Date): Response {
  const outletId = (body as { outlet_id?: string } | null)?.outlet_id ?? "";
  if (!outletById(outletId) || !sees(who.m, outletId)) return notFound();
  const n = w.orders.size;
  const picks = [ITEMS.find((i) => i.slug === "hazelnut_croissant")!, ITEMS.find((i) => i.slug === "cold_coffee")!];
  const orderId = id7(`order:web:${n}:${now.getTime()}`);
  const ticketNo = (w.ticketNo.get(outletId) ?? 0) + 1;
  const { placed } = buildOrder({
    orderId, outletId, ticketNo, channelId: CHANNEL_ID, deviceId: null, invoiceNo: null, kind: "pickup", tableRef: null, status: "placed", createdAt: now.toISOString(),
    promisedAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
    lines: [
      { line_id: id7(`line:web:${orderId}:0`), item_id: itemId(picks[0]!.slug), variant_id: null, option_ids: [], qty_milli: 2000, note: null },
      { line_id: id7(`line:web:${orderId}:1`), item_id: itemId(picks[1]!.slug), variant_id: null, option_ids: [id7(`option:${picks[1]!.slug}:milk:oat`)], qty_milli: 1000, note: "Less ice, please" },
    ],
  }, now);
  w.ticketNo.set(outletId, ticketNo);
  w.orders.set(orderId, placed);
  emit(w, "munim.orders.order.placed.v1", { order_id: orderId, outlet_id: outletId, channel_id: CHANNEL_ID, status: "placed", placed_at: now.toISOString() }, { outletId, orderId });
  for (const t of placed.tickets) emit(w, "munim.kitchen.ticket.created.v1", { ticket_id: t.ticket_id, order_id: orderId, outlet_id: outletId, station: t.station, status: t.status }, { outletId, orderId });
  return staffJson(201, { order_id: orderId, ticket_no: ticketNo, by: who.m.member_id });
}

// ---------------------------------------------------------------- routing
/** True for a request the member half answers: every /v1 path except the storefront's, the public Cares pages,
 *  and a guest's stream (which sends no Authorization). */
export const isStaffRequest = (req: Request, path: string): boolean =>
  !path.startsWith("/v1/storefront/") && !path.startsWith("/v1/cares-network/") && (path !== "/v1/stream" || req.headers.has("Authorization"));

export async function handleStaff(req: Request, path: string, url: URL, now: Date): Promise<Response> {
  try {
    if (path === "/v1/me/tenants") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      const found = MEMBERS.find((x) => x.token === token);
      if (!found) return fail(401, "unauthenticated");
      return staffJson(200, { tenants: [{ tenant_id: DEMO_TENANT_ID, tenant_name: TENANT.name, role: found.me.role }] } satisfies S["TenancyMeTenants"]);
    }
    const who = member(req);
    const w = books(now);
    const m = who.m;
    const q = (k: string) => url.searchParams.get(k);
    const x = (re: RegExp) => re.exec(path);
    let body: unknown = undefined;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        return fail(400, "bad_request");
      }
    }

    if (req.method === "GET") {
      if (path === "/v1/me") return staffJson(200, m);
      if (path === "/v1/tenant") return staffJson(200, TENANT);
      // Like core today: every outlet of the business, whatever the person's scope (screens filter by GET /v1/me).
      if (path === "/v1/outlets") return staffJson(200, MEMBER_OUTLETS);
      if (path === "/v1/channels") return staffJson(200, CHANNELS);
      if (path === "/v1/devices") return staffJson(200, DEVICES); // tenant-wide too, like core
      if (path === "/v1/catalogue/menu") {
        const outlet = q("outlet") ?? "", kind = q("channel_kind");
        if (!kind || !UUID7.test(outlet)) return fail(400, "bad_request");
        if (!outletById(outlet) || !sees(m, outlet)) return notFound();
        return staffJson(200, menuFor(outlet, kind, now));
      }
      if (path === "/v1/orders") {
        const outlet = q("outlet"), status = q("status"), date = q("business_date");
        if (outlet && !sees(m, outlet)) return notFound();
        const items = [...w.orders.values()].map((p) => p.order).filter((o) => sees(m, o.outlet_id) && (!outlet || o.outlet_id === outlet) && (!status || o.status === status) && (!date || o.business_date === date));
        items.sort((a, b) => b.created_at.localeCompare(a.created_at));
        return staffJson(200, { items: items.map(orderListItem), next_cursor: null } satisfies S["V1OrdersList"]);
      }
      let r = x(/^\/v1\/orders\/([^/:]+)$/);
      if (r) {
        const p = w.orders.get(r[1]!);
        return p && sees(m, p.order.outlet_id) ? staffJson(200, p.order) : notFound();
      }
      if (path === "/v1/kitchen/board") {
        const outlet = q("outlet") ?? "";
        if (!UUID7.test(outlet)) return fail(400, "bad_request");
        if (!outletById(outlet) || !sees(m, outlet)) return notFound();
        return staffJson(200, boardOf(outlet, q("station"), w.orders, now));
      }
      if (path === "/v1/inbox") return staffJson(200, inbox(w, m));
      if (path === "/v1/drafts") {
        const status = q("status") ?? "proposed", outlet = q("outlet");
        if (outlet && !sees(m, outlet)) return notFound();
        const items = [...w.drafts.values()].filter((d) => visibleDraft(m, d) && (!outlet || d.sd.draft.outlet_ids.includes(outlet)) && (status === "decided" ? d.decision !== null : d.sd.draft.status === status)).map((d) => ({ draft: d.sd.draft, decision: d.decision, unverified_refs: detailOf(d).unverified_refs }));
        return staffJson(200, { items, has_more: false, next_cursor: null } satisfies S["V1DraftsResponse"]);
      }
      r = x(/^\/v1\/drafts\/([^/:]+)$/);
      if (r) {
        const d = w.drafts.get(r[1]!);
        return d && visibleDraft(m, d) ? staffJson(200, detailOf(d)) : notFound();
      }
      r = x(/^\/v1\/snapshots\/([^/:]+)$/);
      if (r) return openSnapshot(w, who, r[1]!);
      if (path === "/v1/threads") {
        const items = [...w.threads.values()].filter((t) => t.created_by === m.member_id)
          .map((t) => ({ thread_id: t.thread_id, specialist: t.specialist, created_by: t.created_by, outlet_scope: t.outlet_scope, created_at: t.created_at, updated_at: t.updated_at }));
        return staffJson(200, { items, next_cursor: null } satisfies S["V1ThreadsResponse"]);
      }
      r = x(/^\/v1\/threads\/([^/:]+)$/);
      if (r) {
        const t = w.threads.get(r[1]!);
        return t && t.created_by === m.member_id ? staffJson(200, t) : notFound();
      }
      if (path === "/v1/specialists") return staffJson(200, SPECIALISTS);
      if (path === "/v1/cares/profile") return staffJson(200, CARES_PROFILE);
      if (path === "/v1/cares/recipients") {
        const outlet = q("outlet");
        if (!outlet) return fail(400, "bad_request");
        return outletById(outlet) && sees(m, outlet) ? staffJson(200, RECIPIENTS) : notFound();
      }
      if (path === "/v1/cares/listings") {
        const outlet = q("outlet"), status = q("status"), kind = q("kind");
        if (outlet && !sees(m, outlet)) return notFound();
        const items = [...w.listings.values()].filter((l) => sees(m, l.outlet_id) && (!outlet || l.outlet_id === outlet) && (!status || l.status === status) && (!kind || l.kind === kind));
        items.sort((a, b) => b.published_at.localeCompare(a.published_at));
        const views = items.map((l) => ({
          listing_id: l.listing_id, outlet_id: l.outlet_id, kind: l.kind, status: l.status, recipient_id: l.recipient_id, pickup_from: l.pickup_from, pickup_to: l.pickup_to,
          pickup_on: l.pickup_on, published_by: l.published_by, published_at: l.published_at, lines: l.lines, handovers: l.handovers,
        }));
        return staffJson(200, { items: views, next_cursor: null, labels: CARES_PROFILE.labels, note_key: CARES_PROFILE.note_key } satisfies S["V1CaresListings"]);
      }
      r = x(/^\/v1\/cares\/listings\/([^/:]+)$/);
      if (r) {
        const l = w.listings.get(r[1]!);
        return l && sees(m, l.outlet_id) ? staffJson(200, l) : notFound();
      }
      if (path === "/v1/suppliers") return staffJson(200, { items: seedSuppliers(now).map((s) => (m.role === "staff" ? { ...s, prices: [] } : s)) } satisfies S["V1Suppliers"]);
      r = x(/^\/v1\/suppliers\/([^/:]+)$/);
      if (r) {
        const s = seedSuppliers(now).find((y) => y.supplier_id === r![1]);
        return s ? staffJson(200, m.role === "staff" ? { ...s, prices: [] } : s) : notFound();
      }
      if (path === "/v1/purchase-orders") return staffJson(200, { items: [...w.pos.values()].filter((p) => p.outlet_ids.some((o) => sees(m, o))) } satisfies S["V1PurchaseOrders"]);
      r = x(/^\/v1\/purchase-orders\/([^/:]+)$/);
      if (r) {
        const p = w.pos.get(r[1]!);
        return p && p.outlet_ids.some((o) => sees(m, o)) ? staffJson(200, p) : notFound();
      }
      // 15 §10: goods-received notes in the person's outlets.
      if (path === "/v1/goods-received") {
        const items = [...w.grns.values()].filter((g) => sees(m, g.outlet_id)).sort((a, b) => b.received_at.localeCompare(a.received_at));
        return staffJson(200, { items } satisfies S["V1GoodsReceivedList"]);
      }
      r = x(/^\/v1\/goods-received\/([^/:]+)$/);
      if (r) {
        const g = w.grns.get(r[1]!);
        return g && sees(m, g.outlet_id) ? staffJson(200, g) : notFound();
      }
      if (path === "/v1/inventory/ingredients") return staffJson(200, INGREDIENTS);
      if (path === "/v1/inventory/reorder-levels") {
        const outlet = q("outlet");
        if (!outlet) return fail(400, "bad_request");
        return outletById(outlet) && sees(m, outlet) ? staffJson(200, reorderLevels(outlet, now)) : notFound();
      }
      if (path === "/v1/stream") return stream(w, who, url, req);
      return notFound();
    }

    if (req.method === "POST") {
      if (path === "/v1/orders:preview") return preview(body, who, now);
      if (path === "/v1/orders") return placeOrder(w, who, body, now);
      let r = x(/^\/v1\/orders\/([^/:]+):(accept|reject|advance)$/);
      if (r) return orderCommand(w, who, r[1]!, r[2]!, body);
      r = x(/^\/v1\/orders\/([^/:]+)\/tenders$/);
      if (r) return tender(w, who, r[1]!, body, now);
      r = x(/^\/v1\/kitchen\/tickets\/([^/:]+):advance$/);
      if (r) return advanceTicket(w, who, r[1]!, body, now);
      r = x(/^\/v1\/drafts\/([^/:]+):(approve|reject)$/);
      if (r) return decide(w, who, r[1]!, r[2] as "approve" | "reject", body, req, now);
      r = x(/^\/v1\/findings\/([^/:]+):dismiss$/);
      if (r) {
        const cmd = envelopeOf<S["FindingsDismissV1"]>(body, "findings.dismiss.v1");
        if (cmd.payload.finding_id !== r[1]) refuse(422, "invalid_payload");
        if (m.role === "staff") refuse(403, "forbidden", "authority_denied");
        const f = w.findings.get(r[1]!);
        if (!f) return notFound();
        return once(w, who, cmd, 200, () => {
          if (f.status !== "open") refuse(409, "conflict");
          f.status = "dismissed";
          f.updated_at = now.toISOString();
          emit(w, "inbox.finding", { status: "dismissed", pack: f.pack, type: f.type, severity: f.severity, outlet_ids: [], updated_at: f.updated_at }, { inbox: true });
          return result(cmd, f.finding_id);
        });
      }
      if (path === "/v1/snapshots") return mint(w, who, body, now);
      if (path === "/v1/ask") return ask(w, who, body, req, now);
      if (path === "/v1/cares/listings") return publishListing(w, who, body, now);
      r = x(/^\/v1\/cares\/listings\/([^/:]+):withdraw$/);
      if (r) return withdrawListing(w, who, r[1]!, body);
      if (path === "/v1/cares/handovers") return recordHandover(w, who, body, now);
      if (path === "/v1/purchase-orders") return createPo(w, who, body, now);
      if (path === "/v1/goods-received") return receiveGoods(w, who, body, now);
      if (path === "/v1/_mock/web-order") return webOrder(w, who, body, now);
      return notFound();
    }
    return notFound();
  } catch (e) {
    if (e instanceof Refuse) return e.res;
    if (e instanceof BadRequest) return fail(422, "invalid_payload");
    return fail(500, "internal");
  }
}

/** For tests: forget this instance's books (the next request re-seeds them). */
export const resetStaffBooks = () => {
  world = null;
};
export { COUNTER_CHANNEL_ID, posDevice };
