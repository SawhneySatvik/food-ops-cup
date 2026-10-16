// [unit] T-128's screens: the libraries behind them (contrast, the office's words, investigation words, the rollup's month)
// and the mock's new member routes, exercised directly against mock-server/staff.ts. Expected values are the brief's, core's
// (the margin_fall verdict rule, R67's demo-only paths, 0034's authority rows) and WCAG's published reference ratios — never
// read from the code under test.
import { beforeEach, describe, expect, it } from "vitest";
import type { MunimError } from "@/lib/munim/client";
import { envelope } from "@/lib/munim/commands";
import { modesUpTo, monthBefore } from "@/lib/munim/investigation-words";
import { bubbleOf, deskOf, type Trace } from "@/lib/munim/office";
import { lastMonth } from "@/lib/munim/owner-figures";
import { BUILT_IN, PRESETS, contrast, moveSection, readout, themeOk, themeVars } from "@/lib/munim/page-theme";
import { DEMO_PEOPLE, DEMO_TENANT_ID } from "@/lib/munim/session";
import { staffErrorText } from "@/lib/munim/staff-copy";
import { uuidv7 } from "@/lib/munim/uuid";
import { id7 } from "@/mock-server/data";
import { handleStaff, livePage, resetStaffBooks } from "@/mock-server/staff";
import { GOMTI_NAGAR, HAZRATGANJ } from "@/mock-server/staff-data";
import { tracesOf, seedRuns } from "@/mock-server/staff-data-t128";

const token = (key: string) => DEMO_PEOPLE.find((p) => p.key === key)!.token;
type Body = Record<string, unknown> & { error?: { code: string; reason_code: string | null } };
async function call(method: "GET" | "POST", path: string, who: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://mock.test/mock${path}`);
  const req = new Request(url, {
    method,
    headers: { Authorization: `Bearer ${token(who)}`, "X-Munim-Tenant": DEMO_TENANT_ID, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleStaff(req, path.split("?")[0]!, url, new Date());
  return { status: res.status, body: (await res.json()) as Body, headers: res.headers };
}
const err = (e: Partial<MunimError>): MunimError => ({ kind: "refusal", status: 403, code: "forbidden", reasonCode: null, params: {}, retryAfterMs: null, ...e });
const digits = /\p{Nd}/u;

beforeEach(() => resetStaffBooks());

describe("page theme: the contrast the editor shows (WCAG 2.x)", () => {
  it("matches WCAG's reference ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(Number(contrast("#777777", "#ffffff").toFixed(2))).toBe(4.48);
  });
  it("every preset and the built-in page pass; a light primary and a dark accent do not", () => {
    for (const p of PRESETS) expect(themeOk({ ...BUILT_IN.theme, ...p.colours }), p.name).toBe(true);
    expect(themeOk(BUILT_IN.theme)).toBe(true);
    expect(readout("primary", "#f0b429").ok).toBe(false);
    expect(readout("accent", "#5b3a78").ok).toBe(false);
    expect(readout("primary", "nope").ok).toBe(false);
  });
  it("white text on a dark primary, ink on a light one; corners by the radius", () => {
    const v = themeVars({ ...BUILT_IN.theme, primary: "#1f4e6b", secondary: "#dcebc9", radius: "soft" }) as Record<string, string>;
    expect([v["--on-primary"], v["--on-secondary"], v["--radius-card"]]).toEqual(["#ffffff", "#2a1a12", "12px"]);
  });
  it("moving a section up or down keeps every section once; out of range changes nothing", () => {
    const kinds = (s: typeof BUILT_IN.sections) => s.map((x) => x.kind);
    expect(kinds(moveSection(BUILT_IN.sections, 3, 2))).toEqual(["hero", "outlets", "cards", "ribbon"]);
    expect(kinds(moveSection(BUILT_IN.sections, 0, -1))).toEqual(kinds(BUILT_IN.sections));
  });
});

describe("the office: desks and bubbles from trace events", () => {
  it("an actor's desk", () => {
    expect(["manager", "specialist:finance", "watcher:kitchen", "specialist:inventory_purchasing", "something:else"].map(deskOf))
      .toEqual(["manager", "finance", "kitchen", "inventory_purchasing", "manager"]);
  });
  it("supplier traffic goes to the bay, a draft to the owner's desk with its link, an abstention is Cannot verify", () => {
    const ev = (kind: string, payload: Record<string, string>) => ({ run_id: uuidv7(), id: uuidv7(), seq: 1, parent_id: null, actor: "specialist:inventory_purchasing", at: new Date().toISOString(), kind, payload }) as Trace;
    expect(bubbleOf(ev("a2a_send", { supplier: "steady" })).spot).toBe("suppliers");
    const d = bubbleOf(ev("draft", { draft_id: id7("draft:po_nuts"), command_type: "purchasing.po.create.v1" }));
    expect([d.spot, d.draftId, d.tone]).toEqual(["owner", id7("draft:po_nuts"), "draft"]);
    expect(bubbleOf(ev("abstain", { reason: "insufficient_history" })).words).toBe("Cannot verify");
    expect(bubbleOf(ev("tool_result", { outcome: "fail:budget_exceeded" })).tone).toBe("stop");
  });
  it("no bubble of any seeded run carries a digit (no number is drawn in the office)", () => {
    const now = new Date();
    const words = seedRuns(now).flatMap((r) => tracesOf(r.run_id, now)!.map((e) => bubbleOf(e).words));
    expect(words.length).toBeGreaterThan(20);
    expect(words.filter((w) => digits.test(w))).toEqual([]);
  });
});

describe("investigation and month words", () => {
  it("modes up to a role's ceiling; calendar months by arithmetic", () => {
    expect([modesUpTo("step"), modesUpTo("plan"), modesUpTo("auto")]).toEqual([["step"], ["step", "plan"], ["step", "plan", "auto"]]);
    expect([monthBefore("2026-10-16", 1), monthBefore("2026-01-31", 1), lastMonth("2026-03-31")]).toEqual(["2026-09-01", "2025-12-01", "2026-02-01"]);
  });
  it("refusals in words", () => {
    expect(staffErrorText(err({ reasonCode: "demo_protected" }), "storefront")).toBe("This is switched off on the shared demo business so it keeps working for everyone.");
    expect(staffErrorText(err({ code: "invalid_payload", status: 422, reasonCode: "theme_contrast" }), "storefront")).toMatch(/too hard to read/);
    expect(staffErrorText(err({ reasonCode: "authority_denied" }), "storefront")).toBe("Your role can't do this. Ask the owner.");
  });
});

describe("mock: investigations (margin_fall)", () => {
  const params = { period_month: "2026-09-01", compare_month: "2026-08-01" };
  it("a plan shows its items, specialists and the estimate cell; the creator's approval runs it to done with the planted causes", async () => {
    const id = uuidv7();
    const opened = await call("POST", "/v1/investigations", "owner", { investigation_id: id, playbook_id: "margin_fall", params, mode: "plan" });
    expect(opened.status).toBe(201);
    const plan = opened.body.plan as { items: unknown[]; estimate: { estimate_ref: string } };
    expect(plan.items).toHaveLength(7);
    expect((opened.body.resolved_refs as Array<{ ref: string }>).map((r) => r.ref)).toContain(plan.estimate.estimate_ref);
    // The same id and body again replays; another body under it is a conflict.
    expect((await call("POST", "/v1/investigations", "owner", { investigation_id: id, playbook_id: "margin_fall", params, mode: "plan" })).headers.get("X-Munim-Replayed")).toBe("true");
    expect((await call("POST", "/v1/investigations", "owner", { investigation_id: id, playbook_id: "margin_fall", params: { period_month: "2026-08-01", compare_month: "2026-07-01" }, mode: "plan" })).status).toBe(409);
    const done = await call("POST", `/v1/investigations/${id}:approve-plan`, "owner", { mode: "plan" });
    const status = Object.fromEntries((done.body.checklist as Array<{ item_id: string; status: string }>).map((c) => [c.item_id, c.status]));
    expect([done.body.status, done.body.steps_done]).toEqual(["done", 1]);
    // Hand values (the mock's bridge: deals −7,012 bp and volume/mix −3,005 + 8 bp of a falling margin; the books complete).
    expect(status).toEqual({ data_complete: "supported", supplier_price: "refuted", waste: "refuted", deals: "supported", channel_fees: "refuted", labour: "refuted", volume_mix: "supported" });
    const step = (done.body.steps as Array<{ narration: { envelope: { segments: Array<{ text: string }> } } }>)[0]!;
    expect(step.narration.envelope.segments.every((s) => !digits.test(s.text.replace(/⟨[^⟩]*⟩/gu, "")))).toBe(true);
  });
  it("Step mode: the next step only (409 sequence_gap otherwise); waiting when the books are short; cancel is the creator's", async () => {
    const id = uuidv7();
    await call("POST", "/v1/investigations", "owner", { investigation_id: id, playbook_id: "margin_fall", params, outlet_scope: [GOMTI_NAGAR] }, { "X-Mock-Force-Investigation": "waiting" });
    expect((await call("POST", `/v1/investigations/${id}:continue`, "owner", { step_no: 2 })).body.error?.code).toBe("sequence_gap");
    const s1 = await call("POST", `/v1/investigations/${id}:continue`, "owner", { step_no: 1 });
    expect([s1.body.status, s1.body.stop_reason]).toEqual(["waiting", "waiting"]);
    // Farah manages Gomti Nagar: she sees it, restricted (finance figures are above her role), and cannot cancel it.
    const seen = await call("GET", `/v1/investigations/${id}`, "manager");
    expect([seen.status, seen.body.status, (seen.body.resolved_refs as unknown[]).length]).toEqual([200, "restricted", 0]);
    expect((await call("POST", `/v1/investigations/${id}:cancel`, "manager", {})).status).toBe(403);
    expect((await call("POST", `/v1/investigations/${id}:cancel`, "owner", {})).body.status).toBe("cancelled");
  });
  it("a mode above the role's ceiling is refused; staff see no all-outlet investigation", async () => {
    const r = await call("POST", "/v1/investigations", "manager", { investigation_id: uuidv7(), playbook_id: "margin_fall", params, mode: "auto", outlet_scope: [GOMTI_NAGAR] });
    expect([r.status, r.body.error?.reason_code]).toEqual([403, "mode_above_ceiling"]);
    expect((await call("GET", "/v1/investigations", "counter")).body.items).toEqual([]);
  });
});

describe("mock: desks, runs and traces", () => {
  it("a desk: its findings, waiting proposals and a track record of cells; the Manager has none; an unknown desk is 404", async () => {
    const d = await call("GET", "/v1/specialists/inventory_purchasing", "owner");
    expect((d.body.findings as Array<{ type: string }>).map((f) => f.type)).toContain("inventory.waste_spike");
    expect((d.body.drafts as Array<{ command_type: string }>).map((x) => x.command_type)).toContain("purchasing.po.create.v1");
    const cells = (d.body.track_record as { cells: Record<string, string> }).cells;
    expect(Object.values(cells).every((c) => c.startsWith("⟨snap:"))).toBe(true);
    expect((await call("GET", "/v1/specialists/manager", "owner")).body.track_record).toBeNull();
    expect((await call("GET", "/v1/specialists/nope", "owner")).status).toBe(404);
  });
  it("runs by scope: every run for the owner, Hazratganj's for its counter staff; a run outside it is 404", async () => {
    const all = (await call("GET", "/v1/runs", "owner")).body.items as Array<{ run_id: string; outlet_scope: string[] }>;
    const mine = (await call("GET", "/v1/runs", "counter")).body.items as Array<{ outlet_scope: string[] }>;
    expect(all.length).toBe(5);
    expect(mine.length).toBe(3);
    expect(mine.every((r) => r.outlet_scope.every((o) => o === HAZRATGANJ))).toBe(true);
    const wide = all.find((r) => r.outlet_scope[0] === "*")!;
    expect((await call("GET", `/v1/traces/${wide.run_id}`, "counter")).status).toBe(404);
  });
});

describe("mock: brands", () => {
  it("none for Cobnut; three for a cloud kitchen, and the till's entries carry their brand", async () => {
    expect((await call("GET", "/v1/brands", "owner")).body.brands).toEqual([]);
    const three = { "X-Mock-Brands": "three" };
    expect(((await call("GET", "/v1/brands", "owner", undefined, three)).body.brands as unknown[]).length).toBe(3);
    const menu = await call("GET", `/v1/catalogue/menu?outlet=${HAZRATGANJ}&channel_kind=counter`, "owner", undefined, three);
    expect((menu.body.entries as Array<{ brand_id: string | null }>).every((e) => e.brand_id !== null)).toBe(true);
  });
});

describe("mock: the storefront page", () => {
  const save = (who: string, based: number | null, doc: unknown = BUILT_IN) => call("POST", "/v1/storefront-pages", who, envelope("storefront.page.save.v1", { page_id: uuidv7(), based_on_version: based, doc }));
  it("the owner saves numbered versions; a stale base 409; low contrast 422; a single-outlet manager 403", async () => {
    expect((await save("owner", null)).status).toBe(201);
    expect((await save("owner", null)).body.error?.reason_code).toBe("page_version_stale");
    expect((await save("owner", 1, { ...BUILT_IN, theme: { ...BUILT_IN.theme, primary: "#f0b429" } })).body.error?.reason_code).toBe("theme_contrast");
    expect((await save("manager", 1)).status).toBe(403);
    expect((await save("owner", 1)).status).toBe(201);
    const list = (await call("GET", "/v1/storefront-pages", "owner")).body as { versions: Array<{ version: number }>; live: unknown };
    expect([list.versions.map((v) => v.version), list.live]).toEqual([[2, 1], null]);
  });
  it("publishing: refused on the demo business; on another it goes live for the shop, and the live one again is 409", async () => {
    await save("owner", null);
    const v = ((await call("GET", "/v1/storefront-pages", "owner")).body as { versions: Array<{ page_id: string }> }).versions[0]!;
    const publish = (headers: Record<string, string> = {}) => call("POST", `/v1/storefront-pages/${v.page_id}:publish`, "owner", envelope("storefront.page.publish.v1", { publish_id: uuidv7(), page_id: v.page_id }), headers);
    expect([(await publish()).status, (await publish()).body.error?.reason_code]).toEqual([403, "demo_protected"]);
    expect(livePage().page).toBeNull();
    expect((await publish({ "X-Mock-Demo": "off" })).status).toBe(200);
    expect(livePage().page?.version).toBe(1);
    expect((await publish({ "X-Mock-Demo": "off" })).status).toBe(409);
  });
});

describe("mock: the win-back campaign (R67)", () => {
  const DRAFT = id7("draft:campaign");
  it("the owner approves the Customers desk's draft → queued; a manager of one outlet cannot; record-sent only on a demo business", async () => {
    expect((await call("GET", `/v1/drafts/${DRAFT}`, "manager")).status).toBe(404); // Farah's outlet is not the campaign's
    const ok = await call("POST", `/v1/drafts/${DRAFT}:approve`, "owner", envelope("drafts.approve.v1", { draft_id: DRAFT, command_type: "customers.campaign.create.v1", edited_payload: null, reason: null }));
    expect(ok.status).toBe(200);
    const c = ((await call("GET", "/v1/campaigns", "owner")).body.campaigns as Array<{ campaign_id: string; status: string; never_auto_sent: boolean }>)[0]!;
    expect([c.status, c.never_auto_sent]).toEqual(["queued", true]);
    const sent = (headers: Record<string, string> = {}) => call("POST", "/v1/campaigns:record-sent", "owner", envelope("customers.campaign.record_sent.v1", { campaign_id: c.campaign_id }), headers);
    expect([(await sent({ "X-Mock-Demo": "off" })).status, (await sent({ "X-Mock-Demo": "off" })).body.error?.reason_code]).toEqual([403, "demo_only"]);
    expect((await sent()).status).toBe(200);
    expect(((await call("GET", "/v1/campaigns", "owner")).body.campaigns as Array<{ status: string }>)[0]!.status).toBe("sent");
    expect((await sent()).status).toBe(409);
  });
});
