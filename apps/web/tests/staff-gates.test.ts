// [unit] Who gets an Approve button, and the mock refusing the same people core refuses: the role per draft type, the
// outlet gate over every target outlet, staff never deciding, and approve-with-edits never rewriting the draft.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { envelope } from "@/lib/munim/commands";
import { approveGate, numericFields, withEdits, type DraftDetail } from "@/lib/munim/drafts";
import { CAN, DEMO_PEOPLE, DEMO_TENANT_ID, type Me } from "@/lib/munim/session";
import { id7 } from "@/mock-server/data";
import { handleStaff, resetStaffBooks } from "@/mock-server/staff";
import { HAZRATGANJ, MEMBERS } from "@/mock-server/staff-data";

// A manager at Hazratganj, added for these tests only: the seeded manager (Farah) works at Gomti Nagar and cannot see
// the Hazratganj Cares draft at all (404), so she could not show that the draft's type is what refuses a manager.
const HZG_MANAGER = { token: "test_manager_hazratganj", me: { member_id: id7("member:test_manager_hzg"), tenant_id: DEMO_TENANT_ID, name: "Test manager", role: "manager" as const, outlet_ids: [HAZRATGANJ] } };
const token = (who: string) => (who === "hzg_manager" ? HZG_MANAGER.token : DEMO_PEOPLE.find((p) => p.key === who)!.token);

async function call(method: "GET" | "POST", path: string, who: string, body?: unknown) {
  const url = new URL(`http://mock.test/mock${path}`);
  const req = new Request(url, {
    method,
    headers: { Authorization: `Bearer ${token(who)}`, "X-Munim-Tenant": DEMO_TENANT_ID, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleStaff(req, path, url, new Date());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string; reason_code: string | null } } };
}
const me = async (who: string) => (await call("GET", "/v1/me", who)).body as unknown as Me;
const detail = async (draftId: string, who: string) => (await call("GET", `/v1/drafts/${draftId}`, who)).body as unknown as DraftDetail;
const gateFor = async (draftId: string, who: string) => {
  const d = await detail(draftId, who);
  return approveGate(d, numericFields(d), await me(who));
};
const approve = (draftId: string, commandType: string, who: string, edited: unknown = null, reason: string | null = null) =>
  call("POST", `/v1/drafts/${draftId}:approve`, who, envelope("drafts.approve.v1", { draft_id: draftId, command_type: commandType, edited_payload: edited, reason }));

const CARES = id7("draft:cares_sourdough");
const POOLED = id7("draft:po_butter_pooled");
const PREP = id7("draft:prep_time");

beforeAll(() => { MEMBERS.push(HZG_MANAGER); });
afterAll(() => { MEMBERS.splice(MEMBERS.indexOf(HZG_MANAGER), 1); });
beforeEach(() => resetStaffBooks());

describe("a donation is the owner's to decide (core: cares.listing.publish.v1 is owner and judge)", () => {
  it("a manager who sees the Cares draft gets no Approve, and the mock refuses with 403", async () => {
    expect(await gateFor(CARES, "hzg_manager")).toEqual({ kind: "not_for_you", why: "role" });
    const r = await approve(CARES, "cares.listing.publish.v1", "hzg_manager");
    expect([r.status, r.body.error?.reason_code]).toEqual([403, "authority_denied"]);
  });
  it("the owner gets Approve on the same draft", async () => {
    expect(await gateFor(CARES, "owner")).toEqual({ kind: "open" });
  });
});

describe("core judges every target outlet: the pooled order covers both outlets", () => {
  it("Farah (Gomti Nagar) sees it by overlap, gets no Approve, and the mock refuses with 403", async () => {
    expect((await call("GET", `/v1/drafts/${POOLED}`, "manager")).status).toBe(200);
    expect(await gateFor(POOLED, "manager")).toEqual({ kind: "not_for_you", why: "outlets" });
    const r = await approve(POOLED, "purchasing.po.create.v1", "manager");
    expect([r.status, r.body.error?.reason_code]).toEqual([403, "authority_denied"]);
  });
  it("the owner may approve it as proposed", async () => {
    expect(await gateFor(POOLED, "owner")).toEqual({ kind: "open" });
    expect((await approve(POOLED, "purchasing.po.create.v1", "owner")).status).toBe(200);
  });
});

describe("staff never decide", () => {
  it("counter and kitchen staff get no Approve on any draft, cannot open the inbox, and the mock refuses with 403", async () => {
    for (const who of ["counter", "kitchen"]) {
      const m = await me(who);
      expect(CAN.inbox!.includes(m.role)).toBe(false);
      const d = await detail(PREP, "owner");
      expect(approveGate(d, numericFields(d), m)).toEqual({ kind: "not_for_you", why: "staff" });
      const r = await approve(PREP, "kitchen.prep_time.set.v1", who);
      expect(r.status).toBe(403);
    }
  });
});

describe("approve with edits stores the typed value on the decision, never in the draft", () => {
  it("the draft's command_payload still holds the proposed ref after an edited approval", async () => {
    const before = await detail(PREP, "owner");
    const proposed = (before.draft.payload as { prep_sec: unknown }).prep_sec;
    expect(typeof proposed === "string" && proposed.startsWith("⟨snap:")).toBe(true);
    const owner = await me("owner");
    const r = await approve(PREP, "kitchen.prep_time.set.v1", "owner", withEdits(before.draft.payload, { "/prep_sec": 1500 }, owner.member_id), "Checked with the kitchen");
    expect(r.status).toBe(200);
    const after = await detail(PREP, "owner");
    expect(after.decision?.verdict).toBe("edited");
    expect((after.draft.payload as { prep_sec: unknown }).prep_sec).toBe(proposed);
  });
});
