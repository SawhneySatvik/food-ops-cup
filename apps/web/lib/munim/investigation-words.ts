// file: lib/munim/investigation-words.ts
// Words for investigations (T-128). Core sends keys and codes only — the playbook's item label keys, statuses, stop reasons
// and modes — never prose; this file is where they become a person's words. Plain TypeScript, no React.
import type { Schemas } from "./types";

/** The status pill's tones (components/staff/source.tsx PillTone). */
type PillTone = "new" | "work" | "ready" | "done" | "stop" | "warn" | "late";

type Investigation = Schemas["V1Investigation"];
export type InvestigationStatus = Investigation["status"];
export type ItemStatus = Investigation["checklist"][number]["status"];
export type Mode = Investigation["mode"];

export const PLAYBOOK_WORDS: Record<string, string> = { margin_fall: "Why did the margin fall?" };

/** margin_fall's checklist, as questions (packages/core-domain/investigations/playbooks.ts label keys). */
const ITEM: Record<string, string> = {
  "investigation.margin_fall.data_complete": "Are the books complete for both months?",
  "investigation.margin_fall.supplier_price": "Did supplier prices go up?",
  "investigation.margin_fall.waste": "Did more food go to waste?",
  "investigation.margin_fall.deals": "Did deals and discounts cost more?",
  "investigation.margin_fall.channel_fees": "Did delivery-app fees go up?",
  "investigation.margin_fall.labour": "Did labour cost more?",
  "investigation.margin_fall.volume_mix": "Did you sell less, or a cheaper mix?",
};
export const itemWords = (labelKey: string): string => ITEM[labelKey] ?? "A check on the books";

export const STATUS: Record<InvestigationStatus, { words: string; tone: PillTone }> = {
  open: { words: "Open", tone: "work" },
  waiting: { words: "Waiting for the books", tone: "warn" },
  done: { words: "Done", tone: "ready" },
  no_driver_found: { words: "No single cause found", tone: "done" },
  cannot_verify: { words: "Cannot verify", tone: "stop" },
  cancelled: { words: "Cancelled", tone: "done" },
  exhausted: { words: "Stopped at its step limit", tone: "done" },
  restricted: { words: "Not shown at your role", tone: "done" },
};

export const ITEM_STATUS: Record<ItemStatus, { words: string; tone: PillTone }> = {
  pending: { words: "Not checked yet", tone: "new" },
  supported: { words: "Explains it", tone: "ready" },
  refuted: { words: "Doesn't explain it", tone: "done" },
  cannot_verify: { words: "Cannot verify", tone: "stop" },
  restricted: { words: "Not shown at your role", tone: "done" },
};

/** Why a Plan or Auto run stopped (null = it is running or ended in a final status). */
export const STOP_REASON: Record<string, string> = {
  waiting: "Waiting for the books: some tills, payouts or bank lines for these months are not in yet. It goes on once they are.",
  abstain: "Munim couldn't write up a step from the books, so it stopped. Run the next step to try again.",
  budget: "This month's AI budget is used up, so it stopped.",
  scope: "The outlets it covers changed, so it stopped.",
  ceiling: "Auto is no longer allowed for your role, so it went back to Plan: run each next step yourself.",
  draft: "It stopped at a proposal waiting in your inbox.",
};

export const MODE: Record<Mode, { name: string; how: string }> = {
  step: { name: "Step by step", how: "You run each step and read it before the next." },
  plan: { name: "Plan", how: "Munim shows its plan and what it may cost; once you approve it, every step runs." },
  auto: { name: "Auto", how: "Approve once; Munim keeps going by itself when new data arrives, within your role's limit and this month's AI budget." },
};
const RANK: Record<Mode, number> = { step: 1, plan: 2, auto: 3 };
/** The modes a role may pick, up to its ceiling (GET /v1/ai/policy). */
export const modesUpTo = (ceiling: Mode): Mode[] => (["step", "plan", "auto"] as const).filter((m) => RANK[m] <= RANK[ceiling]);

export const TRIGGERED: Record<string, string> = { member: "run by a person", plan: "run by the approved plan", auto: "run on its own (Auto)" };

export const isTerminal = (s: InvestigationStatus): boolean => ["done", "no_driver_found", "cannot_verify", "cancelled", "exhausted"].includes(s);

/** "2026-09-01" → "September 2026" (a month named by its first day; no time zone involved). */
export const monthWords = (first: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${first}T00:00:00Z`));

/** The first of the month `back` months before the one holding `isoDate` (calendar arithmetic, no zone). */
export function monthBefore(isoDate: string, back: number): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10);
}
