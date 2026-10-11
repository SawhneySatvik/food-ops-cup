// provisionTenant(tx, spec) — the cross-module seam (W2 brief): used by POST /v1/onboarding (T-020) and by
// /platform/v1/tenants:provision (T-031). It only writes rows, inside the caller's transaction: the caller's
// executeCommand has set the command type (tenancy.provision.v1 for an operator, tenancy.onboard.v1 for a
// self-serve owner, demo.session.start.v1 for a demo), and the book guard judges every insert against it.
// Currency, FY start, time zones, aggregator channels and tax-id formats come from the tenant's country pack.
import { CountryPack } from "@munim/contracts/packs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { DEFAULT_HOURS, FIRST_POS_SERIES, KIND_DEFAULTS, type OnboardKind } from "./defaults.ts";

/** The wire fields of tenancy.provision.v1 (T-031's operator route passes exactly these) plus the optional
 *  extras self-serve onboarding and demo sessions add. Without `outlet` an operator-provisioned tenant starts
 *  with its owner member and chart only (not onboarded): the owner binds at first sign-in, adds the first
 *  outlet (tenancy.outlet.create.v1) and completes onboarding (tenancy.tenant.update.v1). */
export interface ProvisionSpec {
  tenant_id: string;
  name: string;
  country_code: string;
  is_demo: boolean;
  owner: {
    member_id: string;
    name: string;
    email: string;
    idp_sub?: string | null | undefined;
    /** `judge` only for a demo session's ephemeral member. */
    role?: "owner" | "judge" | undefined;
  };
  kind?: OnboardKind | undefined;
  /** true → `onboarded_at` is set now and the country is locked (R30). Default: only when an outlet is given. */
  onboarded?: boolean | undefined;
  outlet?: {
    outlet_id: string;
    name: string;
    address: string;
    tz?: string | undefined;
    hours?: { opens: string; closes: string } | undefined;
    tax_ids: Record<string, string>;
  } | undefined;
}

export interface ProvisionResult {
  tenant_id: string;
  outlet_ids: string[];
  owner_member_id: string;
  brand_id: string | null;
  channel_ids: string[];
  device_ids: string[];
  /** false when finance's seedChart is not present. */
  chart_seeded: boolean;
}

/** The active pack row for a country (latest version). Unknown or unpublished → out_of_pack_scope. */
export async function loadPack(c: Queryable, country_code: string): Promise<CountryPack> {
  const r = await c.query<{ doc: unknown }>(
    `SELECT doc FROM platform.country_pack WHERE code = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`, [country_code]);
  if (!r.rows[0]) throw new ApiError("out_of_pack_scope");
  return CountryPack.parse(r.rows[0].doc);
}

/** Tax ids: each code must be one the pack names and, when present, match its pattern. Absence is allowed
 *  (INFERENCE: ON3 says "optional"; the pack's `required` is for receipts, which warn instead). Names the
 *  offending code in `refs`, never the value. */
export function checkTaxIds(pack: CountryPack, tax_ids: Record<string, string>): void {
  const bad: string[] = [];
  for (const [code, value] of Object.entries(tax_ids)) {
    const def = pack.tax_ids.find((t) => t.code === code);
    if (!def || !new RegExp(def.pattern).test(value)) bad.push(`tax_id:${code}`);
  }
  if (bad.length) throw new ApiError("invalid_payload", null, { refs: bad });
}

export function checkZone(pack: CountryPack, tz: string): void {
  if (!pack.timezones.includes(tz)) throw new ApiError("invalid_payload", null, { refs: ["outlet:tz"] });
}

type SeedChart = (tx: Queryable, pack: CountryPack) => Promise<unknown>;

/** Finance's seedChart (T-026) when its module has landed; a missing module can never break boot. */
async function financeSeedChart(): Promise<SeedChart | null> {
  const file = join(import.meta.dirname, "..", "finance", "index.ts");
  if (!existsSync(file)) return null;
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { seedChart?: SeedChart };
  return mod.seedChart ?? null;
}

/** The first business policy's start. Kept after 2000-01-01 so tenancy's "a same-day version is refused" test still hits an equal date. */
export const POLICY_EPOCH = "2000-01-01";

export async function provisionTenant(tx: Queryable, spec: ProvisionSpec): Promise<ProvisionResult> {
  const T = spec.tenant_id;
  const pack = await loadPack(tx, spec.country_code);
  const out = spec.outlet;
  const hours = out?.hours ?? DEFAULT_HOURS;
  const tz = out ? (out.tz ?? pack.default_timezone) : null;
  if (out && tz) {
    checkZone(pack, tz);
    checkTaxIds(pack, out.tax_ids);
  }
  const by = spec.owner.member_id;
  const role = spec.owner.role ?? "owner";

  // A tenant id that already exists is somebody else's (a retry of this very request replays before the
  // handler runs): refuse before touching a row.
  const taken = await tx.query(`SELECT 1 FROM core.tenant WHERE tenant_id = $1`, [T]);
  if (taken.rows[0]) throw new ApiError("conflict");

  await tx.query(
    `INSERT INTO core.tenant (tenant_id, name, country_code, base_currency, fy_start_month, is_demo, onboarded_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, $8)`,
    [T, spec.name, spec.country_code, pack.currency.code, pack.fy_start_month, spec.is_demo, spec.onboarded ?? out !== undefined, by]);
  await tx.query(
    `INSERT INTO core.member (tenant_id, id, idp_sub, name, email, is_ephemeral_judge, created_by) VALUES ($1, $2, $3, $4, $5, $6, $2)`,
    [T, by, spec.owner.idp_sub ?? null, spec.owner.name, spec.owner.email, role === "judge"]);
  await tx.query(
    `INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids, created_by) VALUES ($1, $2, $3, '{}', $2)`,
    [T, by, role]);
  // The tenant's first business policy (W2-R4): the columns' defaults — loyalty 1 point per 1,000 minor of net, a
  // point worth 10 at redemption, no targets — in force from POLICY_EPOCH. A later policy is a new row. R47 D9: the epoch, not "today", so the
  // owner can date a first target back over the history already imported (policy.set needs a valid_from after the row it replaces).
  await tx.query(
    `INSERT INTO core.business_policy (tenant_id, id, valid_from, created_by) VALUES ($1, $2, $3::date, $4)`,
    [T, uuidv7(), POLICY_EPOCH, by]);

  let brand_id: string | null = null;
  const channel_ids: string[] = [];
  const device_ids: string[] = [];
  if (out) {
    const d = KIND_DEFAULTS[spec.kind ?? "restaurant"];
    await tx.query(
      `INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address, tax_ids, default_prep_min, pickup_slot_min, pickup_lead_min, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [T, out.outlet_id, out.name, d.outlet_kind, tz, out.address, JSON.stringify(out.tax_ids),
       d.default_prep_min, d.pickup_slot_min, d.pickup_lead_min, by]);
    for (let weekday = 0; weekday < 7; weekday++) {
      await tx.query(
        `INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, weekday, opens_at, closes_at, created_by) VALUES ($1, $2, $3, 'weekly', $4, $5, $6, $7)`,
        [T, uuidv7(), out.outlet_id, weekday, hours.opens, hours.closes, by]);
    }
    brand_id = uuidv7();
    await tx.query(`INSERT INTO core.brand (tenant_id, id, name, outlet_ids, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [T, brand_id, spec.name, [out.outlet_id], by]);

    const channels = d.channels.map((ch) => ({ kind: ch.kind as string, name: ch.name }));
    if (d.aggregators) for (const a of pack.aggregators) channels.push({ kind: `aggregator:${a.code}`, name: a.display_name });
    for (const ch of channels) {
      const id = uuidv7();
      channel_ids.push(id);
      await tx.query(`INSERT INTO core.channel (tenant_id, id, name, kind, created_by) VALUES ($1, $2, $3, $4, $5)`, [T, id, ch.name, ch.kind, by]);
    }
    // core.device is operational (registration is a member command; heartbeats are not books).
    device_ids.push(uuidv7());
    await tx.query(`INSERT INTO core.device (tenant_id, id, outlet_id, kind, invoice_series, created_by) VALUES ($1, $2, $3, 'pos', $4, $5)`,
      [T, device_ids[0], out.outlet_id, FIRST_POS_SERIES, by]);
    if (d.kds) {
      device_ids.push(uuidv7());
      await tx.query(`INSERT INTO core.device (tenant_id, id, outlet_id, kind, invoice_series, created_by) VALUES ($1, $2, $3, 'kds', NULL, $4)`,
        [T, device_ids[1], out.outlet_id, by]);
    }
  }

  const seed = await financeSeedChart();
  if (seed) await seed(tx, pack);
  return { tenant_id: T, outlet_ids: out ? [out.outlet_id] : [], owner_member_id: by, brand_id, channel_ids, device_ids, chart_seeded: seed !== null };
}
