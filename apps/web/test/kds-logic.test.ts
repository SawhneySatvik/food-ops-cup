// T-062 pure rules: the transition table mirrors core's one-step chain, the cue never shows late before due_at, and
// the sort puts red first.
import { expect, test } from "vitest";
import { messages } from "../lib/i18n/index.ts";
import { actionFor, channelLabel, cueOf, humanize, nextDueMs, NEXT, sortTickets, stationCounts, type Ticket } from "../lib/kds/logic.ts";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const tk = (o: Partial<Ticket>): Ticket => ({
  ticket_id: "t", order_id: "o", ticket_no: 1, business_date: "2026-10-13", station: "kitchen", status: "queued", kind: "takeaway", table_ref: null,
  channel_kind: "counter", started_at: new Date(T0 - 60_000).toISOString(), accepted_at: null, ready_at: null, due_at: new Date(T0 + 600_000).toISOString(),
  promised_at: null, lane: "now", surface_at: null, colour: "normal", lines: [], ...o,
});

test("transitions are one step forward only, ending at done", () => {
  expect(NEXT).toEqual({ queued: "preparing", preparing: "ready", ready: "done", done: null });
  expect(actionFor(tk({ status: "queued" }))).toEqual({ to: "preparing", key: "kds.action.start" });
  expect(actionFor(tk({ status: "preparing" }))).toEqual({ to: "ready", key: "kds.action.ready" });
  expect(actionFor(tk({ status: "ready", kind: "dine_in" }))?.key).toBe("kds.action.served");
  expect(actionFor(tk({ status: "ready", kind: "pickup" }))?.key).toBe("kds.action.picked_up");
  expect(actionFor(tk({ status: "done" }))).toBeNull();
});

test("every action key and its _aria twin exist in the messages", () => {
  for (const s of ["queued", "preparing", "ready"] as const) for (const kind of ["dine_in", "takeaway"] as const) {
    const key = actionFor(tk({ status: s, kind }))!.key;
    expect(messages[key]).toBeTruthy();
    expect(messages[`${key}_aria`]).toBeTruthy();
  }
});

test("cue: core's colour is shown; late is derived only once now >= due_at; ready/done are never late", () => {
  const due = T0 + 600_000;
  expect(cueOf(tk({}), T0)).toBe("new");
  expect(cueOf(tk({ status: "preparing" }), T0)).toBe("in_progress");
  expect(cueOf(tk({ colour: "amber" }), T0)).toBe("at_risk");
  expect(cueOf(tk({ colour: "red" }), T0)).toBe("late");
  expect(cueOf(tk({ colour: "amber" }), due - 1)).toBe("at_risk");
  expect(cueOf(tk({ colour: "amber" }), due)).toBe("late");
  expect(cueOf(tk({ status: "ready", colour: "normal" }), due + 999_999)).toBe("ready");
  expect(cueOf(tk({ due_at: null, colour: "normal" }), due + 999_999)).toBe("new");
});

test("sort: late first, then at risk, then oldest", () => {
  const due = T0 + 600_000;
  const a = tk({ ticket_id: "a", ticket_no: 1, started_at: new Date(T0 - 10_000).toISOString() });
  const b = tk({ ticket_id: "b", ticket_no: 2, colour: "amber", started_at: new Date(T0 - 5_000).toISOString() });
  const c = tk({ ticket_id: "c", ticket_no: 3, colour: "red", started_at: new Date(T0).toISOString() });
  const d = tk({ ticket_id: "d", ticket_no: 4, started_at: new Date(T0 - 20_000).toISOString() });
  expect(sortTickets([a, b, c, d], T0).map((x) => x.ticket_id)).toEqual(["c", "b", "d", "a"]);
  expect(sortTickets([a, d], due + 1).map((x) => x.ticket_id)).toEqual(["d", "a"]); // both late: oldest first
});

test("nextDueMs: earliest future due of a ticket still in the kitchen's hands", () => {
  const a = tk({ due_at: new Date(T0 + 5_000).toISOString() });
  const b = tk({ due_at: new Date(T0 + 1_000).toISOString(), status: "ready" });
  const c = tk({ due_at: new Date(T0 - 1_000).toISOString() });
  expect(nextDueMs([a, b, c], T0)).toBe(T0 + 5_000);
  expect(nextDueMs([b, c], T0)).toBeNull();
});

test("humanize and station counts", () => {
  expect(humanize("paneer_tikka")).toBe("Paneer tikka");
  const m = stationCounts([tk({ station: "grill" }), tk({ station: "grill" }), tk({ station: "cold" })]);
  expect([...m]).toEqual([["grill", 2], ["cold", 1]]);
});

test("channel labels: known kinds, aggregator names, unknown kinds humanised; every key exists", () => {
  expect(channelLabel("table_qr")).toEqual({ key: "kds.channel.table_qr" });
  expect(channelLabel("own_site")).toEqual({ key: "kds.channel.own_site" });
  expect(channelLabel("aggregator:swiggy")).toEqual({ key: "kds.channel.aggregator", vars: { name: "Swiggy" } });
  expect(channelLabel("kiosk_wall")).toEqual({ text: "Kiosk wall" });
  expect(channelLabel("partner:acme")).toEqual({ text: "Partner · acme" });
  for (const k of ["counter", "table_qr", "pickup", "own_site", "aggregator:zomato"]) {
    const c = channelLabel(k);
    expect("key" in c && messages[c.key]).toBeTruthy();
  }
});
