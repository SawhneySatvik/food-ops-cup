// GET /internal/intel/v1/run-frame (T-040b; 04 §1 RunFrame, ADR-014 §6.1 block 5, §14 C1). What a run needs that its
// token does not carry, read fresh per run on the run's munim_svc transaction:
//   - the tenant's country pack (code, version), its currency, `severity_ladder` and `detectors.*.thresholds` (rule 7);
//   - the outlets in the run's scope with their business date now (core's one tz module, the outlet's cutoff).
//     core.outlet is tenant-visible under RLS, so the scope filter is here;
//   - the month's AI budget (F11 O-2) from T-090's `effectiveCap` (the `intel.ai_budget_left` template): effective cap =
//     least(operator limit, owner cap in the budget's currency), hard_left = cap − spent. Control data for intel,
//     never shown (a person sees the template's snapshot);
//   - the narration mode: `model` only with AI on (`intel.enabled`), a budget for the month, and hard_left > 0.
//     Run tokens are never refused for budget: at the cap a run still gets its frame and runs rules only;
// No thread block: an ask's thread excerpt travels only in core's `/ask` body (T-088a `threadBlock`), which core binds
// to the run it mints — a run-frame `?thread_id=` would let intel name a thread nothing ties to the run (ruling, 11 Oct).
// No soft threshold is decided (ADR-014 §3.4 names a soft cap, no document sets it): the level is ok | hard.
import { businessDate } from "@munim/core-domain/tz";
import { ApiError } from "../lib/errors.ts";
import { effectiveCap } from "../modules/ai_policy/index.ts";
import type { Queryable } from "../runtoken/index.ts";
import type { Run } from "./auth.ts";

interface PackDoc {
  currency: { code: string };
  severity_ladder: { critical_minor_gte: number; high_minor_gte: number; medium_minor_gte: number };
  detectors: Record<string, { thresholds: Record<string, number> }>;
}

/** The first day of `at`'s UTC month (platform.llm_budget.month). */
export const budgetMonth = (at: Date) => `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;

export async function runFrame(c: Queryable, run: Run, at: Date) {
  const p = await c.query<{ code: string; version: number; doc: PackDoc }>(
    `SELECT p.code, p.version, p.doc FROM core.tenant t
       JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      ORDER BY p.version DESC LIMIT 1`);
  const pack = p.rows[0];
  if (!pack) throw new ApiError("unavailable");
  const ladder = pack.doc.severity_ladder;

  const o = await c.query<{ id: string; name: string; kind: "restaurant" | "cloud_kitchen" | "store"; tz: string; cutoff: string }>(
    `SELECT id, name, kind, tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff FROM core.outlet ORDER BY id`);
  const inScope = run.scope[0] === "*" ? o.rows : o.rows.filter((r) => (run.scope as string[]).includes(r.id));
  const outlets = inScope.map((r) => ({ id: r.id, name: r.name, kind: r.kind, tz: r.tz, business_date: businessDate(at, r.tz, r.cutoff) }));

  // T-090's helper runs the `intel.ai_budget_left` template itself, so these numbers equal any snapshot a person sees.
  const cap = await effectiveCap(c, budgetMonth(at));
  const budget = cap && {
    month: cap.month, currency: cap.currency, owner_cap_minor: cap.owner_cap_minor, operator_limit_minor: cap.operator_limit_minor,
    effective_cap_minor: cap.effective_cap_minor, spent_minor: cap.spent_minor, hard_left_minor: cap.left_minor,
    level: cap.left_minor > 0 ? ("ok" as const) : ("hard" as const),
  };

  const flag = await c.query<{ value: unknown }>(`SELECT value FROM platform.feature_flag WHERE key = 'intel.enabled'`);
  const aiOn = flag.rows[0]?.value === true;
  const narration = aiOn && budget?.level === "ok" ? ("model" as const) : ("template" as const);

  return {
    pack: { code: pack.code, version: pack.version },
    currency: pack.doc.currency.code,
    severity_ladder: { critical_minor_gte: ladder.critical_minor_gte, high_minor_gte: ladder.high_minor_gte, medium_minor_gte: ladder.medium_minor_gte },
    detectors: Object.fromEntries(Object.entries(pack.doc.detectors).map(([id, d]) => [id, { thresholds: d.thresholds }])),
    outlets,
    budget,
    narration,
  };
}
