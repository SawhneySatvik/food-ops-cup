// file: lib/munim/office.ts
// The AI office (T-128; screens/back-office.md B1, in Cobnut's look): which desk a trace event belongs to and what its
// bubble says. Input is only a run's trace events, which carry kinds, actors and short labels (template ids, pack ids, ids),
// never text a model or a person wrote — so every word here is ours, chosen by kind, and no number is ever drawn: a figure
// lives in the finding or draft the event links to. Plain TypeScript, no React.
import { specialistName } from "./staff-copy";
import { templateWords } from "./template-words";
import type { Schemas } from "./types";

export type Trace = Schemas["V1TracesResponse"]["events"][number];
export type Run = Schemas["V1RunResponse"];

/** The nine desks, in floor-plan order: the Manager at reception, then the eight specialists. */
export const DESKS = ["manager", "catalogue", "kitchen", "inventory_purchasing", "finance", "people", "customers", "compliance", "market"] as const;
export type Desk = (typeof DESKS)[number];
/** Beside the desks: the simulated suppliers' bay and the owner's desk, where a proposal lands. */
export type Spot = Desk | "suppliers" | "owner";

/** What each desk owns, in a line (packages/contracts intel/specialists.ts, in a person's words). */
export const DESK_BLURB: Record<Desk, string> = {
  manager: "Hears every question first and hands it to the right desk.",
  catalogue: "True dish margins, prices, deals and the menu.",
  kitchen: "Ticket times, remakes, prep lists and prep times.",
  inventory_purchasing: "Stock, waste, shortfalls, supplier prices and purchase orders.",
  finance: "Payouts, fees, tax, the month's close and the margin.",
  people: "Rosters, overtime and labour against sales.",
  customers: "Regulars, coupons, reviews and win-back messages.",
  compliance: "Licences, logs, temperatures and equipment.",
  market: "Festivals, the weather, competitors and goals.",
};

const isDesk = (x: string): x is Desk => (DESKS as readonly string[]).includes(x);

/** "manager" → the Manager; "specialist:<pack>" / "watcher:<pack>" → that pack's desk; anything else → the Manager. */
export function deskOf(actor: string): Desk {
  const pack = actor.includes(":") ? actor.slice(actor.indexOf(":") + 1) : actor;
  return isDesk(pack) ? pack : "manager";
}

const label = (e: Trace, key: string): string | null => {
  const v = (e.payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
};

export interface Bubble {
  /** Where the event happens. */
  spot: Spot;
  /** The desk that did it (for a supplier or owner spot: the desk that went there). */
  desk: Desk;
  words: string;
  tone: "work" | "found" | "draft" | "stop" | "cannot";
  /** A finding or draft the event names, for its link. */
  findingId: string | null;
  draftId: string | null;
}

/** One event as a bubble (B1's table: one animation per kind). */
export function bubbleOf(e: Trace): Bubble {
  const desk = deskOf(e.actor);
  const base = { desk, spot: desk as Spot, findingId: null, draftId: null };
  switch (e.kind) {
    case "route": {
      const to = label(e, "to");
      return { ...base, tone: "work", words: to && isDesk(to) && to !== "manager" ? `Routing to ${specialistName(to)}` : "Writing the answer" };
    }
    case "skill_load":
      return { ...base, tone: "work", words: `Reading the ${specialistName(desk)} notes` };
    case "subagent_start":
      return { ...base, tone: "work", words: "On it" };
    case "subagent_end":
      return { ...base, tone: "work", words: "Done" };
    case "tool_call": {
      const t = label(e, "template");
      return { ...base, tone: "work", words: t ? `Checking ${templateWords(t).toLowerCase()}` : "Checking the books" };
    }
    case "tool_result": {
      const out = label(e, "outcome") ?? "ok";
      return out.startsWith("fail:") ? { ...base, tone: "stop", words: "Refused a quote against your rules" } : { ...base, tone: "work", words: "Got the rows" };
    }
    case "a2a_send":
      return { ...base, spot: "suppliers", tone: "work", words: "Asking a simulated supplier for a quote" };
    case "a2a_receive":
      return { ...base, spot: "suppliers", tone: "work", words: "Quote received from a simulated supplier" };
    case "finding":
      return { ...base, tone: "found", words: "Found something", findingId: label(e, "finding_id") };
    case "draft":
      return { ...base, spot: "owner", tone: "draft", words: "Needs your approval", draftId: label(e, "draft_id") };
    case "abstain":
      return { ...base, tone: "cannot", words: "Cannot verify" };
    case "review": {
      const verdict = (e.payload as { verdict?: string }).verdict;
      return { ...base, tone: verdict === "pass" ? "work" : verdict === "fail" ? "stop" : "cannot", words: verdict === "pass" ? "A quote passed your rules" : verdict === "fail" ? "Refused a quote against your rules" : "Cannot verify a quote" };
    }
    default:
      return { ...base, tone: "stop", words: "Stopped" };
  }
}

const TRIGGER: Record<string, string> = {
  ask: "A question in Ask Munim", watch_sweep: "The watchers' sweep", event: "A request for quotes", brief: "The morning brief", ingest: "An import", auto_step: "An investigation running on its own",
};
/** A run in the picker: what started it and which desk. */
export const runWords = (r: Run): string => `${TRIGGER[r.trigger] ?? "A run"} · ${specialistName(deskOf(r.actor))}`;
