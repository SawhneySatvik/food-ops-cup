// file: scripts/staff-smoke.ts
// Proves the staff client against an API before any staff UI is built: who am I, the till (menu, preview, place,
// replay, key reuse, read, tender), the kitchen (board, live event, advance, stale advance), the inbox and drafts,
// snapshots, Ask (mock only unless STAFF_SMOKE_ASK=1), Cares, suppliers, T-128's reads (investigations, a desk, runs and traces,
// brands, the storefront page, campaigns; a Step investigation on the mock only), and the 401 / 404 rules.
//   Mock:     NEXT_PUBLIC_MUNIM_API=http://localhost:3000/mock npx tsx scripts/staff-smoke.ts
//   Real API: also STAFF_SMOKE_TOKENS=<path to {"owner": "<token>", "scoped": "<token>"}>. Tokens are read from that
//             file and never printed. "scoped" is a member with a list of outlets (counter staff on the mock).
//             MUNIM_DEMO_TENANT_ID (optional) names the business; otherwise the owner's first one.
// It writes to the API it is pointed at (one counter order, one card payment recorded, and that order's kitchen ticket
// moved to done, which completes the order), never decides a draft, and prints ids, statuses and counts only. Run it
// only against the mock or a local development copy of the API, never against a shared deployment.
import { readFileSync } from "node:fs";
import type { MunimError } from "../lib/munim/client";
import { attemptFor, envelope } from "../lib/munim/commands";
import { formatCell, renderSegment, snapRef } from "../lib/munim/refs";
import { DEMO_PEOPLE, DEMO_TENANT_ID, clientFor, tenantsFor } from "../lib/munim/session";
import { createStaffClient } from "../lib/munim/staff";
import { topic, watch } from "../lib/munim/staff-stream";
import { uuidv7 } from "../lib/munim/uuid";

const baseUrl = (process.env.NEXT_PUBLIC_MUNIM_API ?? "").replace(/\/+$/, "");
const tokensFile = process.env.STAFF_SMOKE_TOKENS;
const isMock = /\/mock$/.test(baseUrl);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const skip = (name: string, why: string) => console.log(`skip ${name}: ${why}`);
const why = (e: MunimError) => `${e.kind} ${e.status} ${e.code ?? ""} ${e.reasonCode ?? ""}`.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function people(): Promise<{ owner: string; scoped: string; tenantId: string }> {
  if (!tokensFile) {
    const by = (k: string) => DEMO_PEOPLE.find((p) => p.key === k)!.token;
    return { owner: by("owner"), scoped: by("counter"), tenantId: DEMO_TENANT_ID };
  }
  const t = JSON.parse(readFileSync(tokensFile, "utf8")) as { owner: string; scoped: string };
  // After a reseed a demo person belongs to several businesses: MUNIM_DEMO_TENANT_ID names the one to test.
  const named = process.env.MUNIM_DEMO_TENANT_ID;
  if (named) return { ...t, tenantId: named };
  const tenants = await tenantsFor(baseUrl, t.owner);
  if (!tenants.ok || tenants.data.tenants.length === 0) throw new Error(`tenants: ${tenants.ok ? "none" : why(tenants.error)}`);
  return { ...t, tenantId: tenants.data.tenants[0]!.tenant_id };
}

async function main(): Promise<void> {
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("set NEXT_PUBLIC_MUNIM_API to an absolute URL, e.g. http://localhost:3000/mock");
  const who = await people();
  const owner = clientFor(baseUrl, { token: who.owner, tenantId: who.tenantId });
  const scoped = clientFor(baseUrl, { token: who.scoped, tenantId: who.tenantId });

  // ---- who and where ----
  const me = await owner.getMe();
  if (me.ok) check("me (owner)", me.data.role === "owner" && me.data.outlet_ids === "*", `${me.data.role}, outlets ${me.data.outlet_ids === "*" ? "all" : me.data.outlet_ids.length}`);
  else check("me (owner)", false, why(me.error));
  const meScoped = await scoped.getMe();
  if (meScoped.ok) check("me (scoped)", Array.isArray(meScoped.data.outlet_ids) && meScoped.data.outlet_ids.length > 0, `${meScoped.data.role}, ${Array.isArray(meScoped.data.outlet_ids) ? meScoped.data.outlet_ids.length : "all"} outlet(s)`);
  else check("me (scoped)", false, why(meScoped.error));
  const tenant = await owner.getTenant();
  if (!tenant.ok) throw new Error(`tenant: ${why(tenant.error)}`);
  const fmt = { locale: "en-IN", currency: tenant.data.base_currency };
  const outlets = await owner.listOutlets();
  if (!outlets.ok) throw new Error(`outlets: ${why(outlets.error)}`);
  const kitchenOutlets = outlets.data.outlets.filter((o) => o.kind === "restaurant" || o.kind === "cloud_kitchen");
  check("outlets", kitchenOutlets.length > 0, outlets.data.outlets.map((o) => `${o.name} (${o.kind})`).join(", "));
  // The scoped member's outlets come from GET /v1/me (GET /v1/outlets lists every outlet of the business).
  const scopedIds = meScoped.ok && Array.isArray(meScoped.data.outlet_ids) ? meScoped.data.outlet_ids : null;
  const outlet = kitchenOutlets.find((o) => scopedIds?.includes(o.id)) ?? kitchenOutlets[0]!;
  const channels = await owner.listChannels();
  const counter = channels.ok ? channels.data.channels.find((c) => c.kind === "counter" && c.active) : undefined;
  check("counter channel", counter !== undefined, channels.ok ? `${channels.data.channels.length} channel(s)` : why(channels.error));
  if (!counter) throw new Error("no active counter channel");

  // ---- the till ----
  const menu = await owner.getMenu(outlet.id, "counter");
  if (!menu.ok) throw new Error(`menu: ${why(menu.error)}`);
  const entry = menu.data.entries.find((e) => e.available && e.option_groups.every((g) => !g.required));
  if (!entry) throw new Error("no simple item on the counter menu");
  check("counter menu", true, `${menu.data.entries.length} entries, business date ${menu.data.business_date}, first simple item ${entry.display_name ?? entry.name_key}`);
  const line = { item_id: entry.item_id, variant_id: entry.variant_id, option_ids: [] as string[], qty_milli: 1000, barcode: null };
  const previewBody = { outlet_id: outlet.id, channel_id: counter.id, brand_id: entry.brand_id, kind: "takeaway" as const, pickup_window_id: null, promised_at: null, coupon_codes: [], loyalty_redeem_points: 0, lines: [line] };
  const preview = await owner.previewOrder(previewBody);
  if (!preview.ok) throw new Error(`preview: ${why(preview.error)}`);
  check("preview", preview.data.label === "preview" && preview.data.refusals.length === 0, `total ${formatCell(preview.data.total_minor, "total_minor", { locale: "en-IN", currency: preview.data.currency })}`);

  const attempt = attemptFor(null, JSON.stringify([previewBody, preview.data.total_minor]), "orders.place.v1", () => ({
    order_id: uuidv7(), outlet_id: outlet.id, channel_id: counter.id, brand_id: entry.brand_id, device_id: null, kind: "takeaway" as const,
    table_ref: null, pickup_window_id: null, promised_at: null, external_ref: null,
    lines: [{ line_id: uuidv7(), ...line, note: null }], coupon_codes: [], loyalty_redeem_points: 0,
    preview_total_minor: preview.data.total_minor, client_totals: null,
  }));
  const placed = await owner.placeOrder(attempt.body);
  if (!placed.ok) throw new Error(`place: ${why(placed.error)}`);
  const orderId = placed.data.entity_id;
  check("place", placed.status === 201 && !placed.replayed && orderId === attempt.body.payload.order_id, `entity is the order, status ${placed.status}`);
  const again = attemptFor(attempt, JSON.stringify([previewBody, preview.data.total_minor]), "orders.place.v1", () => { throw new Error("a retry must reuse the attempt"); });
  const replay = await owner.placeOrder(again.body);
  check("replay", replay.ok && replay.replayed && replay.data.entity_id === orderId, replay.ok ? `replayed=${replay.replayed}` : why(replay.error));
  const reused = await owner.placeOrder({ ...attempt.body, payload: { ...attempt.body.payload, kind: "dine_in" } });
  check("same key, new body is 409", !reused.ok && reused.error.code === "idempotency_conflict", reused.ok ? "accepted" : why(reused.error));
  const order = await owner.getOrder(orderId);
  if (!order.ok) throw new Error(`order: ${why(order.error)}`);
  check("read order", order.data.status === "placed" && order.data.remaining_minor === order.data.total_minor, `ticket ${order.data.ticket_no}, ${order.data.status}, remaining = total`);

  // ---- the kitchen ----
  let events = 0;
  const stop = watch({ baseUrl, session: { token: who.owner, tenantId: who.tenantId }, topics: [topic.kds(outlet.id)], onWake: () => { events++; } });
  await sleep(1500);
  const opened = events;
  const board = await owner.getBoard(outlet.id);
  if (!board.ok) throw new Error(`board: ${why(board.error)}`);
  const ticket = board.data.tickets.find((t) => t.order_id === orderId);
  check("board", ticket !== undefined && ticket.status === "queued", `${board.data.tickets.length} live ticket(s), ours ${ticket ? `${ticket.status}, ${ticket.colour}, lane ${ticket.lane}` : "missing"}`);
  if (!ticket) throw new Error("our ticket is not on the board");
  const move = envelope("kitchen.ticket.advance.v1", { ticket_id: ticket.ticket_id, from_status: "queued" as const, to_status: "preparing" as const });
  const advanced = await owner.advanceTicket(ticket.ticket_id, move);
  check("advance ticket", advanced.ok, advanced.ok ? "queued -> preparing" : why(advanced.error));
  await sleep(2500);
  stop();
  check("live event", events > opened, `${events - opened} wake-up(s) after the move`);
  const stale = await owner.advanceTicket(ticket.ticket_id, envelope("kitchen.ticket.advance.v1", { ticket_id: ticket.ticket_id, from_status: "queued" as const, to_status: "preparing" as const }));
  check("stale advance is 409", !stale.ok && stale.error.status === 409 && stale.error.code === "illegal_transition", stale.ok ? "accepted" : why(stale.error));

  // ---- payment (recorded only) ----
  const due = await owner.getOrder(orderId);
  if (!due.ok) throw new Error(`order: ${why(due.error)}`);
  const tender = await owner.recordTender(orderId, envelope("orders.tender.record.v1", { tender_id: uuidv7(), order_id: orderId, method: "card" as const, tendered_minor: null, amount_minor: due.data.remaining_minor, currency: due.data.currency, ref: "SMOKE-0001" }));
  const paid = await owner.getOrder(orderId);
  check("tender", tender.ok && paid.ok && paid.data.remaining_minor === 0, tender.ok ? `status ${paid.ok ? paid.data.status : "?"}, remaining 0` : why(tender.error));
  // Hand it over (paid first): the ticket goes to done and core completes the order, so no paid order is left waiting.
  const ready = await owner.advanceTicket(ticket.ticket_id, envelope("kitchen.ticket.advance.v1", { ticket_id: ticket.ticket_id, from_status: "preparing" as const, to_status: "ready" as const }));
  const handed = ready.ok ? await owner.advanceTicket(ticket.ticket_id, envelope("kitchen.ticket.advance.v1", { ticket_id: ticket.ticket_id, from_status: "ready" as const, to_status: "done" as const })) : ready;
  const closed = await owner.getOrder(orderId);
  check("hand over", handed.ok && closed.ok && closed.data.status === "completed", handed.ok ? `ticket done, order ${closed.ok ? closed.data.status : "?"}` : why(handed.error));

  // ---- inbox, drafts, snapshots ----
  const inbox = await owner.listInbox();
  if (!inbox.ok) check("inbox", false, why(inbox.error));
  else {
    const drafts = inbox.data.items.flatMap((i) => (i.kind === "draft" ? [i.draft] : []));
    check("inbox", true, `${inbox.data.items.length}${inbox.data.next_cursor ? "+" : ""} item(s), ${drafts.length} draft(s)`);
    const d = drafts[0];
    if (!d) skip("draft detail", "no draft in the inbox");
    else {
      const detail = await owner.getDraft(d.draft_id);
      check("draft detail", detail.ok, detail.ok ? `${detail.data.draft.command_type}, ${detail.data.unverified_refs.length} unverified ref(s), ${detail.data.history.length} history row(s)` : why(detail.error));
      // Proves the approve wiring without deciding anything: a payload draft_id that is not the path id is refused.
      const wrong = await owner.approveDraft(d.draft_id, envelope("drafts.approve.v1", { draft_id: uuidv7(), command_type: d.command_type, edited_payload: null, reason: null }));
      check("approve with a wrong draft_id is 422", !wrong.ok && wrong.error.status === 422, wrong.ok ? "approved!" : why(wrong.error));
    }
  }
  const snap = await owner.mintSnapshot({ template_id: "kitchen.ticket_coverage", params: { outlet_id: outlet.id, from: order.data.business_date, to: order.data.business_date } });
  if (!snap.ok) check("mint snapshot", false, why(snap.error));
  else {
    const ref = snapRef(snap.data.snapshot_id, 0, "tickets");
    const parts = renderSegment({ text: `Tickets today: ${ref}`, refs: [`snap:${snap.data.snapshot_id}`] }, [{ ref, value: snap.data.rows[0]?.tickets ?? null }]);
    const shown = parts.map((p) => (p.kind === "text" ? p.text : p.kind === "value" ? formatCell(p.value, "tickets", fmt) : "Cannot verify")).join("");
    const tickets = snap.data.rows[0]?.tickets;
    check("mint snapshot", snap.status === 201 && snap.data.rows.length === 1 && typeof tickets === "number" && Number.isInteger(tickets) && parts.some((p) => p.kind === "value"), shown);
    const reopened = await owner.getSnapshot(snap.data.snapshot_id);
    check("open snapshot", reopened.ok && reopened.data.sha256 === snap.data.sha256, reopened.ok ? `${reopened.data.row_count} row(s)` : why(reopened.error));
  }
  // A local check of refs.ts (no call): a model-typed number never reaches the screen.
  const forged = renderSegment({ text: "Sales were 4200 today", refs: [] }, []);
  check("free digits are not shown (local)", forged.length === 1 && forged[0]!.kind === "unverified");
  const unknown = await owner.getSnapshot(uuidv7());
  check("unknown snapshot is 404", !unknown.ok && unknown.error.kind === "not_found", unknown.ok ? "opened" : why(unknown.error));

  // ---- Ask (the real API calls a live model: off unless asked for) ----
  if (!isMock && process.env.STAFF_SMOKE_ASK !== "1") skip("ask", "real API; set STAFF_SMOKE_ASK=1 to call the model");
  else {
    const asked = await owner.ask({ question: "How many kitchen tickets did we have today?" });
    if (!asked.ok) check("ask", asked.error.status === 503, `${why(asked.error)} (503 = AI unavailable: hide the surface)`);
    else {
      const a = asked.data.answer;
      const values = a.envelope.segments.flatMap((s) => renderSegment(s, a.resolved_refs)).filter((p) => p.kind === "value").length;
      check("ask", a.envelope.abstained || values > 0, a.envelope.abstained ? `abstained: ${a.envelope.reason_code}` : `${a.envelope.segments.length} segment(s), ${values} cited value(s)`);
      const thread = await owner.getThread(asked.data.thread_id);
      check("thread", thread.ok && thread.data.turns.length >= 1, thread.ok ? `${thread.data.turns.length} turn(s)` : why(thread.error));
    }
  }

  // ---- Cares and suppliers ----
  const cares = await owner.getCaresProfile();
  check("cares profile", cares.ok && cares.data.labels.data === "Measured on synthetic data", cares.ok ? `available ${cares.data.available}, enabled ${cares.data.enabled}` : why(cares.error));
  // Every supplier must be simulated and labelled (20 §2); an empty list cannot pass.
  const suppliers = await owner.listSuppliers();
  const items = suppliers.ok ? suppliers.data.items : [];
  const labelled = items.filter((s) => s.kind === "simulated" && s.label === "Simulated supplier").length;
  check("suppliers", items.length > 0 && labelled === items.length, suppliers.ok ? `${items.length} supplier(s), ${labelled} simulated and labelled` : why(suppliers.error));

  // ---- T-128: investigations, the office, brands, the storefront page, campaigns (reads; a Step investigation on the mock) ----
  const policy = await owner.getAiPolicy();
  check("ai policy", policy.ok && policy.data.ceilings.some((c) => c.role === "owner"), policy.ok ? `${policy.data.ceilings.length} role ceilings` : why(policy.error));
  const invs = await owner.listInvestigations();
  check("investigations", invs.ok, invs.ok ? `${invs.data.items.length} visible` : why(invs.error));
  if (isMock) {
    const id = uuidv7();
    const made = await owner.createInvestigation({ investigation_id: id, playbook_id: "margin_fall", params: { period_month: "2026-09-01", compare_month: "2026-08-01" } });
    const stepped = made.ok ? await owner.continueInvestigation(id, 1) : made;
    check("investigation: create and run step 1", stepped.ok && stepped.data.steps_done === 1, stepped.ok ? `${stepped.data.status}` : why(stepped.error));
  } else skip("investigation step", "the real API would write an investigation");
  const desk = await owner.getSpecialistDesk("inventory_purchasing");
  check("a specialist's desk", desk.ok && desk.data.specialist.id === "inventory_purchasing", desk.ok ? `${desk.data.findings.length} finding(s), ${desk.data.drafts.length} draft(s)` : why(desk.error));
  const runs = await owner.listRuns();
  const firstRun = runs.ok ? runs.data.items[0] : undefined;
  if (!firstRun) check("runs", runs.ok, runs.ok ? "none yet" : why(runs.error));
  else {
    const t = await owner.getTraces(firstRun.run_id);
    check("a run's trace", t.ok && t.data.run_id === firstRun.run_id, t.ok ? `${t.data.events.length} event(s)` : why(t.error));
  }
  const brands = await owner.listBrands();
  check("brands", brands.ok, brands.ok ? `${brands.data.brands.length} brand(s)` : why(brands.error));
  const pages = await owner.listStorefrontPages();
  check("storefront page versions", pages.ok, pages.ok ? `${pages.data.versions.length} version(s), live ${pages.data.live ? `v${pages.data.live.version}` : "none"}` : why(pages.error));
  const campaigns = await owner.listCampaigns();
  check("campaigns", campaigns.ok && campaigns.data.campaigns.every((c) => c.never_auto_sent), campaigns.ok ? `${campaigns.data.campaigns.length} campaign(s)` : why(campaigns.error));

  // ---- credentials and scope ----
  const noToken = await createStaffClient({ baseUrl, token: () => "", tenantId: who.tenantId }).listOutlets();
  check("no token is 401", !noToken.ok && noToken.error.status === 401, noToken.ok ? "served" : why(noToken.error));
  const wrongTenant = await clientFor(baseUrl, { token: who.owner, tenantId: uuidv7() }).listOutlets();
  check("wrong tenant is 404", !wrongTenant.ok && wrongTenant.error.kind === "not_found", wrongTenant.ok ? "served" : why(wrongTenant.error));
  const outside = scopedIds ? kitchenOutlets.find((o) => !scopedIds.includes(o.id)) : undefined;
  if (!outside) skip("board outside scope", scopedIds ? "the scoped member sees every kitchen outlet" : "GET /v1/me did not answer");
  else {
    const b = await scoped.getBoard(outside.id);
    check("board outside scope is 404", !b.ok && b.error.kind === "not_found", b.ok ? "served" : why(b.error));
  }
}

main()
  .catch((e: unknown) => {
    failed++;
    console.log(`FAIL ${e instanceof Error ? e.message : "error"}`);
  })
  .finally(() => {
    console.log(failed === 0 ? "staff smoke: all ok" : `staff smoke: ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
