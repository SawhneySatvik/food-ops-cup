// [unit] items from the staff screens' checklists (10–15) that the mock cannot show on screen, plus the mock's own
// member rules (the 14 §10 and 15 §10 additions) exercised directly against mock-server/staff.ts.
import { beforeEach, describe, expect, it } from "vitest";
import type { MunimError } from "@/lib/munim/client";
import { caresGate, handoverAttempt, type CaresProfile, type Listing } from "@/lib/munim/cares-flow";
import { envelope } from "@/lib/munim/commands";
import { approveGate, numericFields, type DraftDetail } from "@/lib/munim/drafts";
import { namesFrom, ticketNews, type Board } from "@/lib/munim/kitchen";
import { formatCell, parseTyped, renderSegment } from "@/lib/munim/refs";
import { DEMO_PEOPLE, DEMO_TENANT_ID, type Me } from "@/lib/munim/session";
import { reasonText, staffErrorText } from "@/lib/munim/staff-copy";
import { uuidv7 } from "@/lib/munim/uuid";
import { handleStaff, resetStaffBooks } from "@/mock-server/staff";
import { id7 } from "@/mock-server/data";

const err = (e: Partial<MunimError>): MunimError => ({ kind: "invalid", status: 409, code: null, reasonCode: null, params: {}, retryAfterMs: null, ...e });
const token = (key: string) => DEMO_PEOPLE.find((p) => p.key === key)!.token;

async function call(method: "GET" | "POST", path: string, who: string, body?: unknown) {
  const url = new URL(`http://mock.test/mock${path}`);
  const req = new Request(url, {
    method,
    headers: { Authorization: `Bearer ${token(who)}`, "X-Munim-Tenant": DEMO_TENANT_ID, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleStaff(req, url.pathname.replace(/^\/mock/, ""), url, new Date());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string; reason_code: string | null } } };
}

describe("refs: AI numbers never reach the screen untraced", () => {
  it("a segment with a typed digit is one Cannot verify part", () => {
    expect(renderSegment({ text: "Butter came to 4860 rupees", refs: [] }, [])).toEqual([{ kind: "unverified", ref: null }]);
  });
  it("a ref missing from resolved_refs is Cannot verify", () => {
    const ref = `⟨snap:${uuidv7()}·0·waste_minor⟩`;
    expect(renderSegment({ text: `Waste ${ref}.`, refs: [] }, []).some((p) => p.kind === "unverified")).toBe(true);
  });
  it("cells format by their column's unit", () => {
    const f = { locale: "en-IN", currency: "INR" };
    expect(formatCell(486000, "waste_minor", f)).toBe("₹4,860.00");
    expect(formatCell(2460, "p80_sec", f)).toBe("41 min");
    expect(formatCell(12_000, "at_risk_qty_milli", f)).toBe("12");
  });
  it("typed values move as text, never through floating point", () => {
    expect(parseTyped("1,410.50", "unit_price_minor", "INR")).toBe(141050);
    expect(parseTyped("9", "qty_milli", "INR")).toBe(9000);
    expect(parseTyped("1.2345", "qty_milli", "INR")).toBeNull();
  });
});

describe("staff copy by code", () => {
  it("kitchen 409", () => expect(staffErrorText(err({ code: "illegal_transition" }), "kitchen")).toBe("Someone already moved this ticket. The board has been refreshed."));
  it("403 authority_denied", () => expect(staffErrorText(err({ kind: "refusal", status: 403, code: "forbidden", reasonCode: "authority_denied" }), "cares")).toBe("Your role can't do this. Ask the owner."));
  it("Cares refusals", () => {
    expect(reasonText("qty_exceeds_listed")).toBe("That's more than was listed.");
    expect(reasonText("listing_expired")).toBe("The pickup time has passed. Choose a later time.");
  });
});

describe("kitchen logic", () => {
  it("a name key the menus lack shows as words", () => expect(namesFrom([])("item.cardamom_knot")).toBe("Cardamom knot"));
  it("the first board announces nothing; then new and ready tickets", () => {
    const t = (id: string, no: number, status: Board["tickets"][number]["status"]) => ({ ticket_id: id, ticket_no: no, status }) as Board["tickets"][number];
    const a = { tickets: [t("a", 3, "preparing")] } as Board;
    const b = { tickets: [t("a", 3, "ready"), t("b", 9, "queued")] } as Board;
    expect(ticketNews(null, a)).toEqual([]);
    expect(ticketNews(a, b)).toEqual(["Ticket 3 ready", "New ticket 9"]);
  });
});

describe("Cares gate (stubbed profiles)", () => {
  const base = { available: true, enabled: true, profile: { status: "active" }, outlets: [{ outlet_id: "o1", active: true }] } as unknown as CaresProfile;
  it("on", () => expect(caresGate(base, "o1")).toBe("on"));
  it("not available", () => expect(caresGate({ ...base, available: false }, "o1")).toBe("cares_not_available"));
  it("not enabled", () => expect(caresGate({ ...base, enabled: false }, "o1")).toBe("cares_not_enabled"));
  it("paused", () => expect(caresGate({ ...base, profile: null }, "o1")).toBe("cares_paused"));
  it("outlet not opted in", () => expect(caresGate(base, "o2")).toBe("cares_not_opted_in"));
});

describe("mock member rules (14 §10, 15 §10)", () => {
  beforeEach(() => resetStaffBooks());

  it("the inbox holds the expiry finding, the Cares proposal and the pooled purchase order", async () => {
    const r = await call("GET", "/v1/inbox", "owner");
    const items = r.body.items as { kind: string }[];
    // T-128 (R67): plus the Customers desk's lapsing-regulars finding and its win-back campaign draft.
    expect(items.length).toBe(10);
    expect(items.filter((i) => i.kind === "draft").length).toBe(6);
  });

  it("staff cannot mint or decide; a staff withdraw is book_write_refused", async () => {
    const mint = await call("POST", "/v1/snapshots", "counter", { template_id: "inventory.expiry_risk", params: { outlet_id: id7("outlet:hazratganj"), days: 7, as_of: "2026-10-14" } });
    expect(mint.status).toBe(404);
    const draftId = id7("draft:cares_sourdough");
    const approve = await call("POST", `/v1/drafts/${draftId}:approve`, "counter", envelope("drafts.approve.v1", { draft_id: draftId, command_type: "cares.listing.publish.v1", edited_payload: null, reason: null }));
    expect(approve.status).toBe(403);
    const listingId = id7("listing:tonight");
    const w = await call("POST", `/v1/cares/listings/${listingId}:withdraw`, "counter", envelope("cares.listing.withdraw.v1", { listing_id: listingId }));
    expect([w.status, w.body.error?.code]).toEqual([403, "book_write_refused"]);
  });

  it("approving the Cares proposal publishes the listing under the approver; a part hand-over over the listed qty is refused", async () => {
    const draftId = id7("draft:cares_sourdough");
    const ok = await call("POST", `/v1/drafts/${draftId}:approve`, "owner", envelope("drafts.approve.v1", { draft_id: draftId, command_type: "cares.listing.publish.v1", edited_payload: null, reason: null }));
    expect([ok.status, ok.body.type]).toEqual([200, "cares.listing.publish.v1"]);
    const listing = (await call("GET", `/v1/cares/listings/${ok.body.entity_id as string}`, "owner")).body as unknown as Listing;
    expect(listing.status).toBe("published");
    expect(listing.lines[0]!.qty_milli).toBe(12_000);
    const tooMuch = handoverAttempt(null, listing, { [listing.lines[0]!.line_id]: 13_000 });
    const r = await call("POST", "/v1/cares/handovers", "counter", tooMuch.body);
    expect([r.status, r.body.error?.reason_code]).toEqual([409, "qty_exceeds_listed"]);
  });

  it("a PO draft's quantity and price trace to the quote cells; approved as proposed, then received in full", async () => {
    const draftId = id7("draft:po_nuts");
    const detail = (await call("GET", `/v1/drafts/${draftId}`, "owner")).body as unknown as DraftDetail;
    const owner = (await call("GET", "/v1/me", "owner")).body as unknown as Me;
    expect(approveGate(detail, numericFields(detail), owner)).toEqual({ kind: "open" });
    const ok = await call("POST", `/v1/drafts/${draftId}:approve`, "owner", envelope("drafts.approve.v1", { draft_id: draftId, command_type: "purchasing.po.create.v1", edited_payload: null, reason: null }));
    expect(ok.status).toBe(200);
    const po = (await call("GET", `/v1/purchase-orders/${ok.body.entity_id as string}`, "owner")).body as unknown as { po_id: string; status: string; total_minor: number; lines: { po_line_id: string; ingredient_id: string; qty_milli: number; unit: string }[]; supplier: { supplier_id: string }; outlet_ids: string[] };
    // 9 kg at the round-two quote of ₹1,410.00 per kg, worked out by the mock as core would.
    expect([po.status, po.total_minor]).toEqual(["committed", 1_269_000]);
    const grn = (batch: boolean) => envelope("purchasing.grn.receive.v1", {
      grn_id: uuidv7(), outlet_id: po.outlet_ids[0]!, supplier_id: po.supplier.supplier_id, po_id: po.po_id, received_at: null, note: null,
      lines: po.lines.map((l) => ({ grn_line_id: uuidv7(), po_line_id: l.po_line_id, ingredient_id: l.ingredient_id, qty_milli: l.qty_milli, unit: l.unit, unit_cost_minor: null, currency: "INR", batch: batch ? { batch_id: uuidv7(), batch_code: "HZ-1", expires_on: null, mrp_minor: null } : null })),
    });
    expect((await call("POST", "/v1/goods-received", "owner", grn(false))).status).toBe(400); // hazelnuts are batch-tracked
    expect((await call("POST", "/v1/goods-received", "owner", grn(true))).status).toBe(201);
    expect(((await call("GET", `/v1/purchase-orders/${po.po_id}`, "owner")).body as { status: string }).status).toBe("received");
    const again = await call("POST", "/v1/goods-received", "owner", grn(true));
    expect([again.status, again.body.error?.code]).toEqual([409, "conflict"]);
  });
});
