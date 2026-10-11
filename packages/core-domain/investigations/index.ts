// Investigations: the deterministic half (ADR-014 §7.2–§7.4). Verdicts are read from the item's own snapshots, the
// status from the checklist; nothing here sees a model. core-api's investigations module mints and stores.
import { snapRef } from "@munim/contracts";
import type { InvestigationStatus, ItemStatus, ParamSource, Playbook, PlaybookItem, Rule } from "./playbooks.ts";

export * from "./playbooks.ts";

export interface Cell { snapshot_id: string; row: number; column: string }
export interface Snap { snapshot_id: string; rows: ReadonlyArray<Readonly<Record<string, unknown>>> }
export interface Judged { status: ItemStatus; cells: Cell[] }

/** A template's params from a playbook entry: `$name` → the investigation's param; anything else is literal. */
export function bindParams(from: Readonly<Record<string, ParamSource>>, params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(from).map(([k, v]) => [k, typeof v === "string" && v.startsWith("$") ? params[v.slice(1)] : v]));
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const rowOf = (s: Snap, key: string, value: string) => s.rows.findIndex((r) => r[key] === value);

/** The verdict of one rule over the item's snapshots (one per `params_from` entry; null = not mintable for this
 *  member, e.g. above their role → cannot_verify). The cells are what the verdict read, for the narration. */
export function judge(rule: Rule, snaps: ReadonlyArray<Snap | null>): Judged {
  const cells: Cell[] = [];
  if (rule.kind === "close_status") {
    let done = snaps.length > 0;
    for (const s of snaps) {
      if (!s) { done = false; continue; }
      for (const code of rule.items) {
        const i = rowOf(s, "item_code", code);
        if (i < 0) { done = false; continue; }
        cells.push({ snapshot_id: s.snapshot_id, row: i, column: "open_count" });
        if (s.rows[i]!.done !== true) done = false;
      }
    }
    return { status: done ? "supported" : "cannot_verify", cells };
  }
  const s = snaps[0];
  if (!s) return { status: "cannot_verify", cells };
  const total = rowOf(s, "component", "margin_delta_minor");
  let score = 0;
  let readable = total >= 0;
  for (const c of rule.components) {
    const i = rowOf(s, "component", c);
    if (i < 0) { readable = false; continue; }
    cells.push({ snapshot_id: s.snapshot_id, row: i, column: "delta_minor" }, { snapshot_id: s.snapshot_id, row: i, column: "share_bp" });
    const share = num(s.rows[i]!.share_bp);
    if (share === null) readable = false;
    else score += share;
  }
  const sign = total >= 0 ? Math.sign(num(s.rows[total]!.delta_minor) ?? 0) : 0;
  if (!readable || sign === 0) return { status: "cannot_verify", cells };
  return { status: score * sign >= rule.min_bp ? "supported" : "refuted", cells };
}

/** The bridge residual within the bar (|share_bp| ≤ max_bp); null when it cannot be read. */
export function residualWithin(s: Snap | null, component: string, maxBp: number): { ok: boolean; cell: Cell | null } {
  if (!s) return { ok: false, cell: null };
  const i = rowOf(s, "component", component);
  const share = i < 0 ? null : num(s.rows[i]!.share_bp);
  return { ok: share !== null && Math.abs(share) <= maxBp, cell: i < 0 ? null : { snapshot_id: s.snapshot_id, row: i, column: "share_bp" } };
}

/** Items a step evaluates: every non-frozen item whose data gate (if any) is supported by now — the gate itself is
 *  judged first, so a gate supported in this step opens its gated items in the same step. */
export function evaluable(item: PlaybookItem, statuses: Readonly<Record<string, ItemStatus>>): boolean {
  return item.data_gate === null || statuses[item.data_gate] === "supported";
}

/** §7.4, computed after a step's verdicts. `done` here is a candidate: core re-judges every frozen item on fresh
 *  snapshots first, and any flip reopens that item and keeps the investigation `open`. */
export function nextStatus(pb: Playbook, statuses: Readonly<Record<string, ItemStatus>>, residualOk: boolean, stepsDone: number): InvestigationStatus {
  const atMax = stepsDone >= pb.max_steps;
  if (statuses[pb.gate] !== "supported") return atMax ? "cannot_verify" : "waiting";
  const drivers = pb.items.filter((i) => i.item_id !== pb.gate).map((i) => statuses[i.item_id] ?? "pending");
  if (drivers.includes("supported") && residualOk) return "done";
  if (!drivers.includes("pending")) return "no_driver_found";
  return atMax ? "exhausted" : "open";
}

/** The item's template sentence for a verdict, citing its cells (digit-free: the refs carry every number). */
export function templateSentence(item: PlaybookItem, status: Exclude<ItemStatus, "pending">, cells: readonly Cell[]): string {
  return item.narration[status].replace("{cells}", cells.map((c) => snapRef(c.snapshot_id, c.row, c.column)).join(", "));
}
