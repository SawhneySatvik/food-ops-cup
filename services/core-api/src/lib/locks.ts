// Per-outlet transaction locks shared across modules (R-A 2, R-A 3). Taken BEFORE a writer's re-checks, so a second
// writer waits for the first to commit and then re-checks against its rows (READ COMMITTED: each statement after the
// wait sees them). Held to commit. Sorted, so two writers over the same outlets cannot deadlock.
//   shift        history shift-log approvals
//   stock_count  history count approvals and live count submissions
import type { Queryable } from "../runtoken/index.ts";

export async function lockOutlets(c: Queryable, kind: "shift" | "stock_count", outletIds: readonly string[]): Promise<void> {
  for (const o of [...new Set(outletIds)].sort()) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.' || $1 || ':outlet:' || current_setting('app.tenant_id') || ':' || $2, 0))`, [kind, o]);
  }
}
