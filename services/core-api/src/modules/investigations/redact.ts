// Verdicts per viewer (R-D ruling, W3 close review: "redact per viewer"). An investigation is visible to every member
// whose outlet scope covers it (0020), but its verdicts are read from templates with their own minimum role
// (finance.close_status and finance.margin_bridge are advisor+). So:
//   - an item whose template is above the viewer's role, or whose verdict snapshots do not all open for the viewer
//     (loadSnapshots), shows as `restricted`: no verdict, no refs, no narration segment;
//   - the investigation's own status (view, list, SSE `inbox.investigation`) is `restricted` unless the viewer can open
//     every template the playbook judges on (its items and its residual) — `done` or `no_driver_found` would otherwise
//     tell them the verdict. Its stop reason is hidden with it, except `ceiling` to the investigation's creator (T-098
//     ruling): it says only that the owner lowered their role's ceiling, so their Auto run is now Plan — no verdict, no data.
import { PLAYBOOKS } from "@munim/core-domain/investigations";
import type { Queryable } from "../../runtoken/index.ts";
import { TEMPLATE_RANK } from "../approvals/index.ts";

export const RESTRICTED = "restricted" as const;

const templatesOf = (playbookId: string): string[] => {
  const pb = PLAYBOOKS[playbookId];
  return pb ? [...new Set([...pb.items.map((i) => i.template_id), pb.residual.template_id])] : [];
};

/** Template id → the minimum role of its latest version. */
export async function minRoles(q: Queryable, templateIds: readonly string[]): Promise<Map<string, string>> {
  const r = await q.query<{ id: string; min_role: string }>(
    `SELECT DISTINCT ON (id) id, min_role FROM evidence.snapshot_template WHERE id = ANY ($1::text[]) ORDER BY id, version DESC`, [templateIds]);
  return new Map(r.rows.map((x) => [x.id, x.min_role]));
}

export const roleOpens = (role: string, minRole: string | undefined) => (TEMPLATE_RANK[role] ?? 0) >= (TEMPLATE_RANK[minRole ?? ""] ?? 99);

/** The playbooks (of `playbookIds`) whose every template `role` may open: their status is shown to this viewer. */
export async function statusVisible(q: Queryable, role: string, playbookIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(playbookIds)];
  const mins = await minRoles(q, ids.flatMap(templatesOf));
  return new Set(ids.filter((p) => templatesOf(p).length > 0 && templatesOf(p).every((t) => roleOpens(role, mins.get(t)))));
}

/** The stop reason shown beside a `restricted` status: `ceiling` to the investigation's creator, otherwise none. */
export const restrictedStopReason = (stopReason: string | null, createdBy: string, viewerId: string | undefined): "ceiling" | null =>
  stopReason === "ceiling" && viewerId !== undefined && createdBy === viewerId ? "ceiling" : null;

/** Every playbook id this module knows: the list's status filter is limited to the ones the viewer may read. */
export const PLAYBOOK_IDS = Object.keys(PLAYBOOKS);
