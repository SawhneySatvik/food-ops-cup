// findings.dismiss.v1 (T-084a): a person turns a finding down with a reason code. The person's own command, never
// drafted and never intel's: it changes only intel.finding.status (munim_core's one column grant, 0012), so it is
// operational, not a book. The reason code rides in the audit entry; no free text is accepted.
// Authority comes from core.command_authority('findings.dismiss.v1') — a migrator request (0023); until that row
// exists the command_log FK refuses and nothing is written (fails closed).
import { FindingsDismissV1 } from "@munim/contracts/findings";
import { evaluateAuthority } from "@munim/core-domain/authority";
import type { CommandHandler } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";

export const dismiss: CommandHandler = {
  type: "findings.dismiss.v1",
  async run(c, cmd) {
    const p = FindingsDismissV1.safeParse(cmd.payload);
    if (!p.success) throw new ApiError("invalid_payload");
    // RLS (outlet overlap) hides another outlet's finding: 404, never 403.
    const f = (await c.query<{ outlet_ids: string[]; status: string }>(`SELECT outlet_ids, status FROM intel.finding WHERE id = $1 FOR UPDATE`, [p.data.finding_id])).rows[0];
    if (!f) throw new ApiError("not_found");
    const s = (await c.query<{ role: string | null; outlets: string | null }>(
      `SELECT nullif(current_setting('app.role', true), '') AS role, nullif(current_setting('app.outlet_ids', true), '') AS outlets`)).rows[0]!;
    const rows = (await c.query<{ command_type: string; allowed_roles: string[]; scope: "outlet" | "tenant"; max_amount_minor: string | null }>(
      `SELECT command_type, allowed_roles, scope, max_amount_minor FROM core.command_authority WHERE command_type = 'findings.dismiss.v1'`)).rows
      .map((r) => ({ ...r, scope: f.outlet_ids.length ? r.scope : "tenant" as const, max_amount_minor: null }));
    const scope = s.outlets ? s.outlets.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : [];
    // A tenant-wide finding (no outlets) needs every outlet, as a tenant-wide draft does.
    const targets = f.outlet_ids.length ? f.outlet_ids : [null];
    const allowed = (f.outlet_ids.length > 0 || scope.includes("*"))
      && targets.every((t) => evaluateAuthority({ command_type: "findings.dismiss.v1", role: s.role ?? "", outlet_scope: scope, target_outlet_id: t }, rows).allow);
    if (!allowed) throw new ApiError("forbidden", "authority_denied");
    if (f.status !== "open") throw new ApiError("conflict");
    await c.query(`UPDATE intel.finding SET status = 'dismissed' WHERE id = $1 AND status = 'open'`, [p.data.finding_id]);
    return { entityId: p.data.finding_id, audit: [{ entity: "intel.finding", entityId: p.data.finding_id, before: { status: "open" }, after: { status: "dismissed", reason_code: p.data.reason_code } }] };
  },
};
