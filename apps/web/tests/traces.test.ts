// [unit] C3 (found by the production journey): the office asked for GET /v1/traces/<run>?limit=500, core caps a page at 100 and
// answers 400, and the mock never capped, so no test saw it. The mock now enforces core's paging rules, and the staff client
// follows next_after_seq. Expected numbers are core's (services/core-api/src/modules/traces: 1 <= limit <= 100, after_seq >= 0,
// a full page may have more behind it), typed here by hand.
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_PEOPLE, DEMO_TENANT_ID } from "@/lib/munim/session";
import { createStaffClient } from "@/lib/munim/staff";
import { handle } from "@/mock-server/handler";
import { resetStaffBooks } from "@/mock-server/staff";
import { ASK_RUN } from "@/mock-server/staff-data-t128";

const token = DEMO_PEOPLE.find((p) => p.key === "owner")!.token;
const fromMock = async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  return handle(req, new URL(req.url).pathname.replace(/^\/mock\/v1\//, "").split("/"));
};
const client = (fetch: typeof globalThis.fetch) => createStaffClient({ baseUrl: "http://mock.test/mock", token: () => token, tenantId: DEMO_TENANT_ID, fetch });
const headers = { Authorization: `Bearer ${token}`, "X-Munim-Tenant": DEMO_TENANT_ID };

beforeEach(() => resetStaffBooks());

describe("the mock holds core's trace paging rules", () => {
  it("a limit over 100, below 1 or not a whole number is a 400; so is a negative or fractional after_seq; 100 is fine", async () => {
    const status = async (query: string) => (await fromMock(`http://mock.test/mock/v1/traces/${ASK_RUN}?${query}`, { headers })).status;
    expect([await status("limit=500"), await status("limit=101"), await status("limit=0"), await status("limit=1.5"), await status("after_seq=-1"), await status("after_seq=x")])
      .toEqual([400, 400, 400, 400, 400, 400]);
    expect([await status("limit=100"), await status("limit=1"), await status("after_seq=3&limit=100"), await status("")]).toEqual([200, 200, 200, 200]);
  });
  it("a full page names where to resume, a short page ends the run's events", async () => {
    const page = async (query: string) => (await (await fromMock(`http://mock.test/mock/v1/traces/${ASK_RUN}?${query}`, { headers })).json()) as { events: { seq: number }[]; next_after_seq: number | null };
    const first = await page("limit=4");
    expect([first.events.map((e) => e.seq), first.next_after_seq]).toEqual([[1, 2, 3, 4], 4]);
    const rest = await page("after_seq=4&limit=100");
    expect([rest.events.map((e) => e.seq), rest.next_after_seq]).toEqual([[5, 6, 7, 8, 9], null]);
  });
});

describe("the staff client reads a whole trace within core's cap", () => {
  it("against the mock: the Ask run's nine events, in seq order", async () => {
    const r = await client(fromMock).getTraces(ASK_RUN);
    expect(r.ok && r.data.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("against a run of 250 events: three requests, none over 100, no event lost or repeated", async () => {
    const seen: { after: string | null; limit: string | null }[] = [];
    const total = 250;
    const run = "019f0000-0000-7000-8000-0000000000aa";
    const core = async (input: RequestInfo | URL): Promise<Response> => {
      const u = new URL(new Request(input).url);
      const after = Number(u.searchParams.get("after_seq") ?? 0), limit = Number(u.searchParams.get("limit") ?? 100);
      seen.push({ after: u.searchParams.get("after_seq"), limit: u.searchParams.get("limit") });
      if (limit < 1 || limit > 100) return new Response(JSON.stringify({ error: { code: "bad_request", message: "x", reason_code: null, params: {} } }), { status: 400, headers: { "Content-Type": "application/json" } });
      const events = Array.from({ length: total }, (_, i) => i + 1).filter((n) => n > after).slice(0, limit)
        .map((seq) => ({ run_id: run, id: `e${seq}`, seq, parent_id: null, actor: "manager", at: "2026-10-16T00:00:00.000Z", kind: "route", payload: {} }));
      return new Response(JSON.stringify({ run_id: run, events, next_after_seq: events.length === limit ? events.at(-1)!.seq : null }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const r = await client(core).getTraces(run);
    expect(r.ok && r.data.events.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(seen.map((s) => [s.after, s.limit])).toEqual([["0", "100"], ["100", "100"], ["200", "100"]]);
  });
  it("a failing page is the answer: the error, not a partial trace", async () => {
    let n = 0;
    const flaky = async (input: RequestInfo | URL): Promise<Response> => {
      n++;
      if (n === 2) return new Response(JSON.stringify({ error: { code: "unavailable", message: "x", reason_code: null, params: {} } }), { status: 503, headers: { "Content-Type": "application/json" } });
      const events = Array.from({ length: 100 }, (_, i) => ({ run_id: "r", id: `e${i}`, seq: i + 1, parent_id: null, actor: "manager", at: "2026-10-16T00:00:00.000Z", kind: "route", payload: {} }));
      return new Response(JSON.stringify({ run_id: "r", events, next_after_seq: 100 }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const r = await client(flaky).getTraces("019f0000-0000-7000-8000-0000000000aa");
    expect([r.ok, !r.ok && r.error.status]).toEqual([false, 503]);
  });
});
