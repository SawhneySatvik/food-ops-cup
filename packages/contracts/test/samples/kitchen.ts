import { S1, T, T_PG, snapRef, u } from "./_ids.ts";

const prepTime = { outlet_id: u(2), item_id: u(20), station: "tandoor", prep_sec: 900, valid_from: "2026-10-12" };
const prepList = {
  prep_list_id: u(120),
  outlet_id: u(2),
  business_date: "2026-10-12",
  lines: [{ ingredient_id: u(40), qty_milli: 2500000, unit: "g" }, { ingredient_id: u(41), qty_milli: 800, unit: "kg" }],
};
const ticketEvent = (id: number, type: string, data: Record<string, unknown>) => ({
  specversion: "1.0", id: u(id), source: `/tenants/${u(1)}/kitchen`, type, subject: u(11), time: T, datacontenttype: "application/json", tenantid: u(1),
  munimrun: "eyJhbGciOiJFZERTQSJ9.eyJydW5faWQiOiJ4In0.c2lnbmF0dXJl", data,
});
const base = { ticket_id: u(11), order_id: u(10), outlet_id: u(2), station: "tandoor" };
const board = {
  outlet_id: u(2),
  as_of: T_PG,
  stations: ["grill", "tandoor"],
  tickets: [{
    ticket_id: u(11), order_id: u(10), ticket_no: 47, business_date: "2026-10-09", station: "tandoor", status: "preparing", kind: "dine_in", table_ref: "T4",
    channel_kind: "counter", started_at: T, accepted_at: T, ready_at: null, due_at: T_PG, promised_at: null, lane: "now", surface_at: null, colour: "amber",
    lines: [{ line_no: 1, item_id: u(20), name_key: "menu.paneer_tikka", qty_milli: 1000, options: [], note: "no onion" }],
  }],
};

export const SAMPLES: Record<string, unknown> = {
  "kitchen.ticket.advance.v1": { ticket_id: u(11), from_status: "queued", to_status: "preparing" },
  "kitchen.prep_time.set.v1": prepTime,
  "kitchen.prep_list.create.v1": prepList,
  "proposal.kitchen.prep_time.set.v1": { ...prepTime, prep_sec: snapRef(S1, 0, "p80_sec") },
  "proposal.kitchen.prep_list.create.v1": {
    ...prepList,
    lines: [{ ingredient_id: u(40), qty_milli: snapRef(S1, 0, "prep_qty_milli"), unit: "g" }, { ingredient_id: u(41), qty_milli: snapRef(S1, 1, "prep_qty_milli"), unit: "kg" }],
  },
  "v1.kds.board": board,
  "v1.kitchen.prep_list": {
    outlet_id: u(2), business_date: "2026-10-12", state: "approved", reason_code: null,
    prep_list: { prep_list_id: u(120), status: "open", draft_id: u(90), lines: [{ ingredient_id: u(40), item_id: null, qty_milli: 2500000, unit: "g" }] },
  },
  "munim.kitchen.ticket.created.v1": ticketEvent(130, "munim.kitchen.ticket.created.v1", { ...base, status: "queued" }),
  "munim.kitchen.ticket.advanced.v1": ticketEvent(131, "munim.kitchen.ticket.advanced.v1", { ...base, status: "preparing", from_status: "queued" }),
};
