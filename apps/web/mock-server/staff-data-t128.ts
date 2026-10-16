// file: mock-server/staff-data-t128.ts
// T-128's part of the synthetic bakery for the mock: the margin-fall investigation's snapshots and its scripted verdicts,
// the specialists' runs and their trace events (ids and short labels only), the cloud-kitchen brands a test can switch on,
// the storefront page's built-in document, and the customers specialist's win-back campaign (its churn segment, finding and
// draft). All invented; every object has the exact shape of a Munim response. Numbers are snapshot cells, never prose.
import type { Schemas } from "@/lib/munim/types";
import { CURRENCY, id7 } from "./data";
import { CARES_RUN, GOMTI_NAGAR, HAZRATGANJ, MEMBERS, OWNER_ID, RUN, businessDate, snapshotOf, type Snapshot } from "./staff-data";

type S = Schemas;
type Investigation = S["V1Investigation"];
type Specialist = Investigation["checklist"][number]["specialist"];
type Col = { name: string; type: "integer" | "text" | "uuid" | "date" | "boolean" | "timestamptz" };
const col = (name: string, type: Col["type"] = "integer"): Col => ({ name, type });
const ref = (s: string, row: number, column: string) => `⟨snap:${s}·${row}·${column}⟩`;
const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The first of the month `back` months before the one holding `isoDate`. */
export const monthStart = (isoDate: string, back: number) => {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10);
};

export const T128_COLUMNS: Record<string, Col[]> = {
  "finance.margin_bridge": [col("component", "text"), col("prior_minor"), col("current_minor"), col("delta_minor"), col("share_bp")],
  "finance.close_status": [col("item_code", "text"), col("done", "boolean"), col("open_count")],
  "intel.investigation_cost_estimate": [col("currency", "text"), col("per_step_minor"), col("steps_in_history"), col("remaining_items"), col("remaining_steps"), col("estimate_minor"), col("label", "text")],
  "intel.agent_track_record": [col("specialist", "text"), col("proposed"), col("approved"), col("edited"), col("rejected"), col("stale"), col("abstained")],
  "customers.churn_segments": [col("customer_id", "uuid"), col("orders_90d"), col("median_gap_days"), col("days_since_last"), col("monthly_spend_minor"), col("segment", "text"), col("at_risk_count"), col("regular_count"), col("at_risk_spend_minor")],
  "finance.pnl": [col("key", "text"), col("revenue_minor"), col("cogs_minor"), col("channel_fees_minor"), col("labour_minor"), col("other_minor"), col("net_minor")],
};
/** core's min_role: finance templates are advisor and up; the rest manager and up. */
export const T128_MIN_ROLE: Record<string, "manager" | "advisor"> = {
  "finance.margin_bridge": "advisor", "finance.close_status": "advisor", "finance.pnl": "advisor",
  "intel.investigation_cost_estimate": "manager", "intel.agent_track_record": "manager", "customers.churn_segments": "manager",
};

// ---------------------------------------------------------------- the margin-fall investigation
/** The bridge for the month pair: the same picture the Cobnut seed plants (half-price knots in the later month, a shorter
 *  month with fewer weekends). Σ deltas = margin_delta_minor; share_bp = delta × 10,000 ÷ |margin delta| (core's rule). */
const BRIDGE: Array<[string, number, number]> = [
  ["revenue_volume", 22_480_000, 21_760_000], ["revenue_price", 0, 0], ["deal_discount", -410_000, -2_090_000], ["cogs_supplier_price", 0, 0],
  ["cogs_volume_mix", -120_000, -118_000], ["waste", -160_000, -151_000], ["channel_fees", 0, 0], ["labour", 0, 0], ["other", -90_000, -95_000],
  ["unexplained", 3_000, 1_000],
];
export function bridgeRows(): Snapshot["rows"] {
  const prior = BRIDGE.reduce((s, r) => s + r[1], 0);
  const current = BRIDGE.reduce((s, r) => s + r[2], 0);
  const total = Math.abs(current - prior);
  const row = (component: string, p: number, c: number) => ({ component, prior_minor: p, current_minor: c, delta_minor: c - p, share_bp: Math.round(((c - p) * 10_000) / total) });
  return [...BRIDGE.map(([k, p, c]) => row(k, p, c)), row("margin_delta_minor", prior, current)];
}
const CLOSE_ITEMS = ["pos_days_closed", "settlements_imported", "bank_imported", "breaks_resolved", "supplier_invoices_matched", "stock_counted", "payroll_approved", "gst_zero_diff", "pnl_produced"];
/** `waiting`: the later month's bank lines stop short of its last day (bank_imported open), as an un-imported statement. */
const closeRows = (waiting: boolean): Snapshot["rows"] =>
  CLOSE_ITEMS.map((item_code) => ({ item_code, done: !(waiting && item_code === "bank_imported"), open_count: waiting && item_code === "bank_imported" ? 4 : 0 }));

/** The playbook as core's margin_fall lists it: item, owning specialist, the bridge components it reads, its words. */
export const PLAYBOOK: Array<{ item: string; specialist: Specialist; components: string[]; what: string }> = [
  { item: "data_complete", specialist: "finance", components: [], what: "" },
  { item: "supplier_price", specialist: "inventory_purchasing", components: ["cogs_supplier_price"], what: "Supplier prices" },
  { item: "waste", specialist: "inventory_purchasing", components: ["waste"], what: "Waste" },
  { item: "deals", specialist: "catalogue", components: ["deal_discount"], what: "Deals and discounts" },
  { item: "channel_fees", specialist: "finance", components: ["channel_fees"], what: "Channel fees" },
  { item: "labour", specialist: "people", components: ["labour"], what: "Labour cost" },
  { item: "volume_mix", specialist: "catalogue", components: ["revenue_volume", "cogs_volume_mix"], what: "Sales volume and mix" },
];
const signature = (specialist: Specialist) => ({ key: "investigation.signature.specialist" as const, specialist, name_key: `specialist.${specialist}.name` });

export interface InvestigationState {
  view: Investigation;
  /** The snapshots a step judges on, minted for this investigation (ids derived from its id). */
  snapshots: Snapshot[];
}

export function investigationSnapshots(id: string, params: Investigation["params"], waiting: boolean, at: string): Snapshot[] {
  const scope = ["*"] as Snapshot["outlet_scope"];
  return [
    snapshotOf(id7(`inv:${id}:bridge`), "finance.margin_bridge", params, T128_COLUMNS["finance.margin_bridge"]!, bridgeRows(), { run: id7(`inv:${id}:run`) }, scope, at),
    snapshotOf(id7(`inv:${id}:close:p`), "finance.close_status", { period_month: params.period_month, outlet_id: null }, T128_COLUMNS["finance.close_status"]!, closeRows(waiting), { run: id7(`inv:${id}:run`) }, scope, at),
    snapshotOf(id7(`inv:${id}:close:c`), "finance.close_status", { period_month: params.compare_month, outlet_id: null }, T128_COLUMNS["finance.close_status"]!, closeRows(false), { run: id7(`inv:${id}:run`) }, scope, at),
    snapshotOf(id7(`inv:${id}:estimate`), "intel.investigation_cost_estimate", { investigation_id: id }, T128_COLUMNS["intel.investigation_cost_estimate"]!,
      [{ currency: CURRENCY, per_step_minor: 0, steps_in_history: 3, remaining_items: PLAYBOOK.length, remaining_steps: 1, estimate_minor: 0, label: "estimate (computed)" }], { member: OWNER_ID }, scope, at),
  ];
}

/** One item's verdict and the cells it read, by core's rules (close_status: the three items' open_count in both months; a
 *  bridge item: Σ share_bp of its components × sign of the margin delta ≥ 1,000 bp). */
export function judgeItem(item: (typeof PLAYBOOK)[number], snaps: Snapshot[]): { status: "supported" | "refuted" | "cannot_verify"; refs: string[] } {
  const [bridge, closeP, closeC] = snaps as [Snapshot, Snapshot, Snapshot];
  if (item.item === "data_complete") {
    const refs: string[] = [];
    let done = true;
    for (const s of [closeP, closeC]) {
      for (const code of ["pos_days_closed", "settlements_imported", "bank_imported"]) {
        const i = s.rows.findIndex((r) => r.item_code === code);
        refs.push(ref(s.snapshot_id, i, "open_count"));
        if (s.rows[i]!.done !== true) done = false;
      }
    }
    return { status: done ? "supported" : "cannot_verify", refs };
  }
  const total = bridge.rows.findIndex((r) => r.component === "margin_delta_minor");
  const sign = Math.sign(Number(bridge.rows[total]!.delta_minor));
  let score = 0;
  const refs: string[] = [];
  for (const c of item.components) {
    const i = bridge.rows.findIndex((r) => r.component === c);
    refs.push(ref(bridge.snapshot_id, i, "delta_minor"), ref(bridge.snapshot_id, i, "share_bp"));
    score += Number(bridge.rows[i]!.share_bp);
  }
  return { status: score * sign >= 1000 ? "supported" : "refuted", refs };
}

/** Core's digit-free template sentence for a verdict, citing the cells (refs joined by ", "). */
export function sentence(item: (typeof PLAYBOOK)[number], status: "supported" | "refuted" | "cannot_verify", refs: string[]): string {
  const cells = refs.join(", ");
  if (item.item === "data_complete") {
    return status === "supported" ? `The tills, payouts and bank lines are complete for the months compared ${cells}.`
      : `Some tills, payouts or bank lines are still missing for the months compared, so the answer waits for them ${cells}.`;
  }
  return status === "supported" ? `${item.what} moved the margin the same way as the total change ${cells}.`
    : status === "refuted" ? `${item.what} does not explain this margin change ${cells}.`
    : `${item.what} cannot be checked from the books for these months ${cells}.`;
}

export function newInvestigation(req: S["V1InvestigationCreateRequest"], by: string, now: Date): Investigation {
  const at = now.toISOString();
  const mode = req.mode ?? "step";
  const estimateId = id7(`inv:${req.investigation_id}:estimate`);
  return {
    investigation_id: req.investigation_id, playbook_id: req.playbook_id, params: req.params, outlet_scope: req.outlet_scope ?? ["*"], mode,
    status: "open", stop_reason: null, created_by: by, steps_done: 0, max_steps: 10, created_at: at, updated_at: at,
    checklist: PLAYBOOK.map((p) => ({ item_id: p.item, label_key: `investigation.margin_fall.${p.item}`, specialist: p.specialist, signature: signature(p.specialist), status: "pending", frozen: false, snapshot_ids: [], refs: [] })),
    plan: mode === "step" ? null : {
      items: PLAYBOOK.map((p) => ({ item_id: p.item, label_key: `investigation.margin_fall.${p.item}`, specialist: p.specialist })),
      specialists: [...new Set(PLAYBOOK.map((p) => p.specialist))],
      estimate: { label: "estimate (computed)", status: "computed", snapshot_id: estimateId, estimate_ref: ref(estimateId, 0, "estimate_minor"), currency_ref: ref(estimateId, 0, "currency") },
      approved_by: null, approved_at: null,
    },
    steps: [], resolved_refs: [],
  };
}

/** Runs one step: every item not yet frozen is judged; a supported item freezes. Status by core's nextStatus. */
export function runStep(st: InvestigationState, member: string, triggeredBy: "member" | "plan" | "auto", now: Date): void {
  const v = st.view;
  const at = now.toISOString();
  const updates: Investigation["steps"][number]["item_updates"] = [];
  for (const c of v.checklist) {
    if (c.frozen) continue;
    const p = PLAYBOOK.find((x) => x.item === c.item_id)!;
    // Channel fees wait for the books to be complete (its data gate); data_complete is judged first, in this same step.
    if (p.item === "channel_fees" && v.checklist.find((x) => x.item_id === "data_complete")!.status !== "supported") continue;
    const j = judgeItem(p, st.snapshots);
    const snapIds = p.item === "data_complete" ? [st.snapshots[1]!.snapshot_id, st.snapshots[2]!.snapshot_id] : [st.snapshots[0]!.snapshot_id];
    updates.push({ item_id: c.item_id, specialist: c.specialist, from: c.status, to: j.status, frozen: j.status === "supported", reopened: false, snapshot_ids: snapIds, refs: j.refs });
    Object.assign(c, { status: j.status, frozen: j.status === "supported", snapshot_ids: snapIds, refs: j.refs });
  }
  v.steps_done += 1;
  const answerId = id7(`inv:${v.investigation_id}:answer:${v.steps_done}`);
  v.steps.push({
    step_no: v.steps_done, member_id: member, triggered_by: triggeredBy, started_at: at, item_updates: updates, tainted: false,
    narration: updates.length === 0 ? null : {
      answer_id: answerId,
      envelope: { answer_id: answerId, abstained: false, reason_code: null, follow_up: null,
        segments: updates.map((u) => ({ text: sentence(PLAYBOOK.find((x) => x.item === u.item_id)!, u.to as "supported" | "refuted" | "cannot_verify", u.refs), refs: [...new Set(u.refs.map((r) => `snap:${r.slice(6, 42)}`))] })) },
      signatures: updates.map((u) => signature(u.specialist)),
    },
  });
  const status = (id: string) => v.checklist.find((x) => x.item_id === id)!.status;
  const drivers = v.checklist.filter((x) => x.item_id !== "data_complete").map((x) => x.status);
  v.status = status("data_complete") !== "supported" ? "waiting" : drivers.includes("supported") ? "done" : drivers.includes("pending") ? "open" : "no_driver_found";
  v.stop_reason = v.status === "waiting" ? "waiting" : null;
  v.updated_at = at;
}

/** A waiting investigation from earlier: the month before last against the one before it, the bank statement short. */
export function seedInvestigations(now: Date): InvestigationState[] {
  const today = businessDate(now);
  const params = { period_month: monthStart(today, 2), compare_month: monthStart(today, 3) };
  const id = id7("investigation:earlier");
  const view = newInvestigation({ investigation_id: id, playbook_id: "margin_fall", params, mode: "step" }, OWNER_ID, new Date(now.getTime() - 26 * 3_600_000));
  const st = { view, snapshots: investigationSnapshots(id, params, true, view.created_at) };
  runStep(st, OWNER_ID, "member", new Date(now.getTime() - 25 * 3_600_000));
  return [st];
}

// ---------------------------------------------------------------- the office: runs and their traces
type Run = S["V1RunResponse"];
type Trace = S["V1TracesResponse"]["events"][number];
const runAt = (now: Date, mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();
export const ASK_RUN = RUN.ask;

export function seedRuns(now: Date): Run[] {
  const run = (run_id: string, trigger: Run["trigger"], actor: string, mins: number, scope: Run["outlet_scope"]): Run =>
    ({ run_id, trigger, actor, outlet_scope: scope, issued_at: runAt(now, mins), expires_at: runAt(now, mins - 15), ended_at: runAt(now, mins - 2) });
  return [
    run(RUN.ask, "ask", "manager", 40, ["*"]),
    run(RUN.negotiation, "event", "specialist:inventory_purchasing", 48, ["*"]),
    run(CARES_RUN, "watch_sweep", "watcher:inventory_purchasing", 55, [HAZRATGANJ]),
    run(RUN.waste, "watch_sweep", "watcher:inventory_purchasing", 58, [HAZRATGANJ]),
    run(RUN.kitchen, "watch_sweep", "watcher:kitchen", 60, [HAZRATGANJ]),
  ];
}

/** Each run's events, as intel records them: kinds, actors and labels (template ids, pack ids, ids), never text. */
export function tracesOf(runId: string, now: Date): Trace[] | null {
  const runs = seedRuns(now);
  const r = runs.find((x) => x.run_id === runId);
  if (!r) return null;
  const start = Date.parse(r.issued_at);
  const ev = (seq: number, kind: string, actor: string, payload: Record<string, string | string[]>): Trace =>
    ({ run_id: runId, id: id7(`trace:${runId}:${seq}`), seq, parent_id: null, actor, at: new Date(start + seq * 2_000).toISOString(), kind, payload } as Trace);
  if (runId === RUN.ask) {
    return [
      ev(1, "route", "manager", { to: "finance" }),
      ev(2, "skill_load", "specialist:finance", { pack: "finance" }),
      ev(3, "subagent_start", "specialist:finance", { pack: "finance" }),
      ev(4, "tool_call", "specialist:finance", { template: "people.labour_pct" }),
      ev(5, "tool_result", "specialist:finance", { template: "people.labour_pct", outcome: "ok" }),
      ev(6, "tool_call", "specialist:finance", { template: "finance.pnl" }),
      ev(7, "tool_result", "specialist:finance", { template: "finance.pnl", outcome: "ok" }),
      ev(8, "subagent_end", "specialist:finance", { pack: "finance" }),
      ev(9, "route", "manager", { to: "manager" }),
    ];
  }
  if (runId === RUN.negotiation) {
    const suppliers = ["steady", "discounter", "premium"];
    return [
      ev(1, "tool_call", "specialist:inventory_purchasing", { template: "inventory.shortfall" }),
      ev(2, "tool_result", "specialist:inventory_purchasing", { template: "inventory.shortfall", outcome: "ok" }),
      ...suppliers.flatMap((s, i) => [ev(3 + 2 * i, "a2a_send", "specialist:inventory_purchasing", { supplier: s, round: "1" }), ev(4 + 2 * i, "a2a_receive", "specialist:inventory_purchasing", { supplier: s, round: "1" })]),
      ev(9, "tool_call", "specialist:inventory_purchasing", { template: "purchasing.quote_compare" }),
      ev(10, "tool_result", "specialist:inventory_purchasing", { template: "purchasing.deal_inputs", outcome: "fail:budget_exceeded" }),
      ev(11, "tool_result", "specialist:inventory_purchasing", { template: "purchasing.deal_inputs", outcome: "ok" }),
      ev(12, "draft", "specialist:inventory_purchasing", { command_type: "purchasing.po.create.v1", draft_id: id7("draft:po_nuts"), status: "proposed" }),
    ];
  }
  if (runId === CARES_RUN) {
    return [
      ev(1, "tool_call", "watcher:inventory_purchasing", { template: "inventory.expiry_risk" }),
      ev(2, "tool_result", "watcher:inventory_purchasing", { template: "inventory.expiry_risk", outcome: "ok" }),
      ev(3, "finding", "watcher:inventory_purchasing", { finding_id: id7("finding:expiry"), detector: "inventory.expiry_risk" }),
      ev(4, "tool_call", "watcher:inventory_purchasing", { template: "cares.recipient_match" }),
      ev(5, "draft", "watcher:inventory_purchasing", { command_type: "cares.listing.publish.v1", draft_id: id7("draft:cares_sourdough"), status: "proposed" }),
    ];
  }
  if (runId === RUN.waste) {
    return [
      ev(1, "tool_call", "watcher:inventory_purchasing", { template: "inventory.waste_week" }),
      ev(2, "tool_result", "watcher:inventory_purchasing", { template: "inventory.waste_week", outcome: "ok" }),
      ev(3, "finding", "watcher:inventory_purchasing", { finding_id: id7("finding:butter"), detector: "inventory.waste_spike" }),
      ev(4, "tool_call", "watcher:customers", { template: "customers.churn_segments" }),
      ev(5, "finding", "watcher:customers", { finding_id: id7("finding:lapsing"), detector: "customers.regulars_lapsing" }),
      ev(6, "draft", "watcher:customers", { command_type: "customers.campaign.create.v1", draft_id: id7("draft:campaign"), status: "proposed" }),
    ];
  }
  return [
    ev(1, "tool_call", "watcher:kitchen", { template: "kitchen.ticket_times" }),
    ev(2, "tool_result", "watcher:kitchen", { template: "kitchen.ticket_times", outcome: "ok" }),
    ev(3, "finding", "watcher:kitchen", { finding_id: id7("finding:cake"), detector: "kitchen.ticket_drift" }),
    ev(4, "draft", "watcher:kitchen", { command_type: "kitchen.prep_time.set.v1", draft_id: id7("draft:prep_time"), status: "proposed" }),
    ev(5, "abstain", "watcher:kitchen", { detector: "kitchen.remakes", reason: "insufficient_history" }),
  ];
}

// ---------------------------------------------------------------- brands (a cloud-kitchen business, switched on by a test)
/** X-Mock-Brands: three: the till's menu splits into three brands by category, as a cloud kitchen's would. */
export const BRANDS = [
  { id: id7("brand:pastries"), name: "Cobnut Pastries (synthetic brand)", categories: ["pastries", "cookies"] },
  { id: id7("brand:cakes"), name: "Praline & Co (synthetic brand)", categories: ["cakes", "gift_boxes"] },
  { id: id7("brand:drinks"), name: "Hazel Brew (synthetic brand)", categories: ["drinks"] },
];
export const brandOf = (category: string): string | null => BRANDS.find((b) => b.categories.includes(category))?.id ?? null;
export const BRANDS_RESPONSE: S["V1Brands"] = { brands: BRANDS.map((b) => ({ id: b.id, name: b.name, outlet_ids: [HAZRATGANJ, GOMTI_NAGAR], active: true })) };

/** finance.pnl for a month, by outlet or by brand: rows as core's template returns them (key = the outlet or brand id). */
export function pnlRows(groupBy: string, brands: boolean): Snapshot["rows"] {
  const row = (key: string, revenue: number, cogs: number, labour: number) =>
    ({ key, revenue_minor: revenue, cogs_minor: cogs, channel_fees_minor: 0, labour_minor: labour, other_minor: 95_000, net_minor: revenue - cogs - labour - 95_000 });
  if (groupBy === "brand") return brands ? [row(BRANDS[0]!.id, 11_840_000, 0, 0), row(BRANDS[1]!.id, 6_720_000, 0, 0), row(BRANDS[2]!.id, 3_200_000, 0, 0)] : [row("unassigned", 21_760_000, 0, 0)];
  return [row(GOMTI_NAGAR, 7_930_000, 0, 1_600_000), row(HAZRATGANJ, 13_830_000, 0, 2_580_000)];
}

// ---------------------------------------------------------------- the storefront page
/** The storefront as built (Cobnut's own look and words): what the builder starts from and the shop shows with nothing live. */
export const BUILT_IN_PAGE: S["StorefrontPageDoc"] = {
  theme: { primary: "#7b3f1d", secondary: "#9e2f4e", accent: "#f6d9c8", radius: "round", layout: "hero-banner" },
  sections: [
    { kind: "hero", visible: true, badge: "Lucknow · two bakehouses · pickup only", tagline: "Baked at dawn. Boxed with care. Pick up warm." },
    { kind: "outlets", visible: true, title: "Pick your bakehouse" },
    { kind: "ribbon", visible: true },
    { kind: "cards", visible: true, cards: [
      { title: "Build a gift box", body: "Pick a box size and two to four truffle-cookie flavours, add a ribbon and a card. Choose an outlet to start." },
      { title: "Cakes with a message", body: "Celebration cakes by weight, classic or eggless, with your words piped on top." },
    ] },
  ],
};

// ---------------------------------------------------------------- the win-back campaign (R67, a demo business)
export const LAPSING = { run: RUN.waste, snapshot: id7("snap:churn"), finding: id7("finding:lapsing"), draft: id7("draft:campaign") };
const REGULARS = Array.from({ length: 6 }, (_, i) => id7(`customer:regular:${i + 1}`));

export function churnSnapshot(now: Date): Snapshot {
  const today = businessDate(now);
  const rows: Snapshot["rows"] = [
    ...REGULARS.map((customer_id, i) => ({ customer_id, orders_90d: 9, median_gap_days: 5, days_since_last: 36 + i, monthly_spend_minor: 88_200, segment: "at_risk", at_risk_count: null, regular_count: null, at_risk_spend_minor: null })),
    { customer_id: null, orders_90d: null, median_gap_days: null, days_since_last: null, monthly_spend_minor: null, segment: null, at_risk_count: 6, regular_count: 20, at_risk_spend_minor: 529_200 },
  ];
  return snapshotOf(LAPSING.snapshot, "customers.churn_segments", { outlet_id: HAZRATGANJ, as_of: today }, T128_COLUMNS["customers.churn_segments"]!, rows, { run: LAPSING.run }, [HAZRATGANJ], new Date(now.getTime() - 55 * 60_000).toISOString());
}
const SIGMA = 6;

export function lapsingFinding(now: Date): S["V1Finding"] {
  const at = new Date(now.getTime() - 54 * 60_000).toISOString();
  const s = LAPSING.snapshot;
  const rows = churnSnapshot(now).rows[SIGMA]!;
  return {
    finding_id: LAPSING.finding, run_id: LAPSING.run, pack: "customers", type: "customers.regulars_lapsing", severity: "medium", status: "open", confidence_bp: 10_000,
    dedupe_key: `customers.regulars_lapsing:${HAZRATGANJ}:w`,
    envelope: {
      finding_id: LAPSING.finding, impact_ref: ref(s, SIGMA, "at_risk_spend_minor"), abstained: false, reason_code: null,
      segments: [{ text: `${ref(s, SIGMA, "at_risk_count")} regular customers have stayed away well past their usual gap between orders, alongside ${ref(s, SIGMA, "regular_count")} who still come; together they spent ${ref(s, SIGMA, "at_risk_spend_minor")} a month.`, refs: [`snap:${s}`] }],
    },
    resolved_refs: ["at_risk_count", "regular_count", "at_risk_spend_minor"].map((c) => ({ ref: ref(s, SIGMA, c), value: rows[c]! })),
    created_at: at, updated_at: at,
  };
}

/** The customers specialist's win-back draft, by code (intel's regulars_lapsing mapping): the audience is the Σ row's
 *  at_risk_count of this very segment; a fixed message template; nothing is ever sent. */
export function campaignDraft(now: Date): S["V1Draft"] {
  const at = new Date(now.getTime() - 53 * 60_000).toISOString();
  const s = LAPSING.snapshot;
  const day = addDays(businessDate(now), 1);
  return {
    draft_id: LAPSING.draft, outlet_ids: [HAZRATGANJ], source: "intel:customers", finding_id: LAPSING.finding, run_id: LAPSING.run, status: "proposed", created_at: at, updated_at: at,
    command_type: "customers.campaign.create.v1",
    payload: { campaign_id: id7("campaign:winback"), name: "Win back regulars who have stopped coming", channel: "sms", outlet_ids: [HAZRATGANJ], segment_snapshot_id: s,
      audience_count: ref(s, SIGMA, "at_risk_count"), message_key: "campaign.win_back", placeholders: [], coupon_id: null, send_at: `${day}T12:00:00Z`, window_from: null, window_to: null },
    resolved_refs: [{ path: "/audience_count", ref: ref(s, SIGMA, "at_risk_count"), value: 6 }],
    evidence: [`snap:${s}`], based_on: [{ ref: ref(s, SIGMA, "at_risk_count"), template_id: "customers.churn_segments", params: churnSnapshot(now).params, expected: 6 }],
  };
}

export const MEMBER_NAME = (id: string) => MEMBERS.find((m) => m.me.member_id === id)?.me.name ?? "";
