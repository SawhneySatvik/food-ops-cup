// [unit] "Request quotes" (go-live B-1): the words for every status core's negotiation can answer, one envelope per thing
// confirmed, and the mock's purchasing.rfq.request.v1 route, read through the staff client the screens use (the outcome
// headers included). Expected words are the brief's and core's status list (contracts IntelNegotiateResponse), not the code's.
import { beforeEach, describe, expect, it } from "vitest";
import type { MunimError } from "@/lib/munim/client";
import { DEMO_PEOPLE, DEMO_TENANT_ID } from "@/lib/munim/session";
import { createStaffClient } from "@/lib/munim/staff";
import { rfqAttempt, rfqErrorText, rfqOutcome } from "@/lib/munim/supply-flow";
import { id7 } from "@/mock-server/data";
import { handle } from "@/mock-server/handler";
import { resetStaffBooks } from "@/mock-server/staff";
import { GOMTI_NAGAR, HAZRATGANJ, ING } from "@/mock-server/staff-data";

const STATUSES = ["drafted", "draft_refused", "no_shortfall", "no_suppliers", "no_reference_price", "no_quote", "no_passing_quote", "model_blocked", "not_simulated"];
const err = (e: Partial<MunimError>): MunimError => ({ kind: "server", status: 500, code: null, reasonCode: null, params: {}, retryAfterMs: null, ...e });

/** The staff client the screens use, with its fetch answered by the in-app mock (no server, no network). */
function staff(who: string, force?: string) {
  const token = DEMO_PEOPLE.find((p) => p.key === who)!.token;
  return createStaffClient({
    baseUrl: "http://mock.test/mock", token: () => token, tenantId: DEMO_TENANT_ID,
    extraHeaders: (): Record<string, string> => (force ? { "X-Mock-Force-Negotiation": force } : {}),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      return handle(req, new URL(req.url).pathname.replace(/^\/mock\/v1\//, "").split("/"));
    },
  });
}

beforeEach(() => resetStaffBooks());

describe("what came of a request for quotes, in words", () => {
  it("the brief's three outcomes", () => {
    expect(rfqOutcome("drafted", "d-1")).toEqual({ text: "Quotes requested — a purchase order is waiting for approval.", draftId: "d-1", inbox: true });
    expect(rfqOutcome("no_shortfall", null).text).toMatch(/^No shortfall yet\./);
    expect(rfqOutcome("no_quote", null).text).toMatch(/^No supplier could quote\./);
  });
  it("every status core answers has its own words; only a drafted one opens a draft", () => {
    const texts = STATUSES.map((s) => rfqOutcome(s, "d-1"));
    expect(new Set(texts.map((t) => t.text)).size).toBe(STATUSES.length);
    expect(texts.filter((t) => t.draftId !== null).length).toBe(1);
    for (const t of texts) expect(t.text).not.toMatch(/\d/); // no number in the copy: numbers come from the books only
  });
  it("a replay carries no status: the request is on record and its draft, if any, is in the inbox", () => {
    expect(rfqOutcome(null, null)).toMatchObject({ draftId: null, inbox: true });
    expect(rfqOutcome(null, null).text).toMatch(/already requested/);
  });
  it("a lost answer (network, gateway 504) says look before asking again; 503 says nothing was drafted", () => {
    expect(rfqErrorText(err({ kind: "network", status: 0 }))).toMatch(/Look in your inbox/);
    expect(rfqErrorText(err({ status: 504 }))).toMatch(/Look in your inbox/);
    expect(rfqErrorText(err({ status: 503, code: "unavailable" }))).toMatch(/Nothing was drafted/);
  });
});

describe("one envelope per thing confirmed", () => {
  it("the same ingredient and outlets (in any order) reuse the envelope; other outlets are a new request; no quantity is sent", () => {
    const a = rfqAttempt(null, ING("hazelnuts"), [HAZRATGANJ, GOMTI_NAGAR]);
    expect(rfqAttempt(a, ING("hazelnuts"), [GOMTI_NAGAR, HAZRATGANJ])).toBe(a);
    const b = rfqAttempt(a, ING("hazelnuts"), [HAZRATGANJ]);
    expect(b.body.command_id).not.toBe(a.body.command_id);
    expect(Object.keys(a.body.payload).sort()).toEqual(["ingredient_id", "outlet_ids", "rfq_id"]);
  });
});

describe("the mock's POST /v1/rfq-requests through the staff client", () => {
  it("the owner, hazelnuts, both outlets: drafted, the draft id in its header, and that draft is in the inbox", async () => {
    const c = staff("owner");
    const a = rfqAttempt(null, ING("hazelnuts"), [HAZRATGANJ, GOMTI_NAGAR]);
    const r = await c.requestQuotes(a.body);
    expect(r.result.ok && r.result.status).toBe(201);
    expect([r.negotiation, r.draftId]).toEqual(["drafted", id7("draft:po_nuts")]);
    const d = await c.getDraft(r.draftId!);
    expect(d.ok && d.data.draft.status).toBe("proposed");
    // The same envelope again: the stored answer, replayed, with no outcome headers (core sends them on the first answer only).
    const again = await c.requestQuotes(a.body);
    expect([again.result.ok && again.result.replayed, again.negotiation, again.draftId]).toEqual([true, null, null]);
  });
  it("each status core can answer comes through its header", async () => {
    for (const s of STATUSES) {
      const r = await staff("owner", s).requestQuotes(rfqAttempt(null, ING("butter"), [HAZRATGANJ]).body);
      expect([s, r.result.ok, r.negotiation]).toEqual([s, true, s]);
    }
  });
  it("another ingredient has no shortfall on the mock", async () => {
    expect((await staff("owner").requestQuotes(rfqAttempt(null, ING("butter"), [HAZRATGANJ]).body)).negotiation).toBe("no_shortfall");
  });
  it("Farah (Gomti Nagar manager) may ask for her outlet, not for Hazratganj; counter staff may not ask at all", async () => {
    expect((await staff("manager").requestQuotes(rfqAttempt(null, ING("hazelnuts"), [GOMTI_NAGAR]).body)).result.ok).toBe(true);
    for (const [who, outlets] of [["manager", [HAZRATGANJ, GOMTI_NAGAR]], ["counter", [HAZRATGANJ]]] as const) {
      const r = await staff(who).requestQuotes(rfqAttempt(null, ING("hazelnuts"), outlets).body);
      expect(r.result.ok ? null : [r.result.error.status, r.result.error.reasonCode]).toEqual([403, "authority_denied"]);
      expect(r.negotiation).toBeNull();
    }
  });
  it("an unknown ingredient is 400", async () => {
    const r = await staff("owner").requestQuotes(rfqAttempt(null, id7("ing:nothing"), [HAZRATGANJ]).body);
    expect(r.result.ok ? null : r.result.error.status).toBe(400);
  });
});
