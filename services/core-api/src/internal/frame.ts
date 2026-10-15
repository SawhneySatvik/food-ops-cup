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
//   - `ai_enabled`: the kill switch alone (T-127, R58), so intel can tell AI switched off (no AI answer at all) from over the
//     month's cap (live mode: each model call served from its recorded fixture or abstaining, T-125);
//   - the owner's negotiation bounds (R47 D7): the tenant-wide business policy in force on the frame's UTC date, each bound
//     defaulting to 9500 / 11000 bp of the reference price when unset. Outlet-level overrides are not served: the bound is per business;
//   - the pack's `licence_kinds` (code, holder, outlet kinds, `_unverified` as a flag) and `payroll_scope` (W3.2);
//   - per outlet, `cares_active` (ADR-015 §4): the Munim Cares mappings run only where it is set.
// No thread block: an ask's thread excerpt travels only in core's `/ask` body (T-088a `threadBlock`), which core binds
// to the run it mints — a run-frame `?thread_id=` would let intel name a thread nothing ties to the run (ruling, 11 Oct).
// No soft threshold is decided (ADR-014 §3.4 names a soft cap, no document sets it): the level is ok | hard.
import { NEGOTIATION_DEFAULTS } from "@munim/contracts/tenancy";
import { businessDate } from "@munim/core-domain/tz";
import { ApiError } from "../lib/errors.ts";
import { effectiveCap } from "../modules/ai_policy/index.ts";
import type { Queryable } from "../runtoken/index.ts";
import type { Run } from "./auth.ts";

interface PackDoc {
  currency: { code: string };
  severity_ladder: { critical_minor_gte: number; high_minor_gte: number; medium_minor_gte: number };
  detectors: Record<string, { thresholds: Record<string, number> }>;
  licence_kinds: Array<{ code: string; holder: "business" | "outlet"; outlet_kinds: Array<"restaurant" | "cloud_kitchen" | "store">; _unverified?: string[] }>;
  payroll_scope: "drafts" | "roster_only";
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

  // cares_active (ADR-015 §4): operator enablement on, the business's Cares profile active, the outlet opted in and active.
  const o = await c.query<{ id: string; name: string; kind: "restaurant" | "cloud_kitchen" | "store"; tz: string; cutoff: string; cares: boolean }>(
    `SELECT o.id, o.name, o.kind, o.tz, to_char(o.business_day_cutoff, 'HH24:MI') AS cutoff,
            EXISTS (SELECT 1 FROM platform.cares_enablement en JOIN core.cares_profile pr ON pr.tenant_id = en.tenant_id AND pr.status = 'active'
                      JOIN core.cares_outlet co ON co.tenant_id = en.tenant_id AND co.outlet_id = o.id AND co.active
                     WHERE en.tenant_id = o.tenant_id AND en.enabled) AS cares
       FROM core.outlet o ORDER BY o.id`);
  const inScope = run.scope[0] === "*" ? o.rows : o.rows.filter((r) => (run.scope as string[]).includes(r.id));
  const outlets = inScope.map((r) => ({ id: r.id, name: r.name, kind: r.kind, tz: r.tz, business_date: businessDate(at, r.tz, r.cutoff), cares_active: r.cares }));

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

  const pol = (await c.query<{ t: number | null; w: number | null }>(
    `SELECT negotiation_target_bp AS t, negotiation_walkaway_bp AS w FROM core.business_policy
      WHERE outlet_id IS NULL AND valid_from <= $1::date AND (valid_to IS NULL OR valid_to > $1::date)
      ORDER BY valid_from DESC, id LIMIT 1`, [at.toISOString().slice(0, 10)])).rows[0];

  return {
    pack: { code: pack.code, version: pack.version },
    currency: pack.doc.currency.code,
    severity_ladder: { critical_minor_gte: ladder.critical_minor_gte, high_minor_gte: ladder.high_minor_gte, medium_minor_gte: ladder.medium_minor_gte },
    detectors: Object.fromEntries(Object.entries(pack.doc.detectors).map(([id, d]) => [id, { thresholds: d.thresholds }])),
    outlets,
    budget,
    narration,
    ai_enabled: aiOn,
    negotiation: { target_bp: pol?.t ?? NEGOTIATION_DEFAULTS.target_bp, walkaway_bp: pol?.w ?? NEGOTIATION_DEFAULTS.walkaway_bp },
    // A kind with `_unverified` notes is flagged, never explained: the notes are pack prose, a watcher needs the code.
    licence_kinds: pack.doc.licence_kinds.map((k) => ({ code: k.code, holder: k.holder, outlet_kinds: k.outlet_kinds, unverified: (k._unverified?.length ?? 0) > 0 })),
    payroll_scope: pack.doc.payroll_scope,
  };
}
