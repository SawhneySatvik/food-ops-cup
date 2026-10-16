// Tenancy command handlers (T-020). Each is bound to ONE seeded command type and writes only that command's
// target_tables (db/README "Book guard"); the role/scope verdict is the database's (MB001/MB008 → 403).
// Currency, FY start, zones, aggregators and tax-id formats come from the country pack, never the payload.
import type { CommandEnvelope } from "@munim/contracts";
import { evaluateAuthority } from "@munim/core-domain/authority";
import {
  DemoSessionStartV1, NEGOTIATION_DEFAULTS, TenancyBrandCreateV1, TenancyChannelCreateV1, TenancyDeviceRegisterV1, TenancyMemberBindV1, TenancyMemberDeactivateV1,
  TenancyMemberInviteV1, TenancyMemberRoleSetV1, TenancyOnboardV1, TenancyOutletCreateV1, TenancyOutletUpdateV1, TenancyPolicySetV1, TenancyTenantUpdateV1,
} from "@munim/contracts/tenancy";
import type { Principal } from "../../auth/resolve.ts";
import type { AuditEntry, CommandHandler } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { DEFAULT_HOURS, KIND_DEFAULTS } from "./defaults.ts";
import { checkTaxIds, checkZone, loadPack, provisionTenant } from "./provision.ts";

type Member = Extract<Principal, { kind: "member" }>;
const tenantOf = async (c: Queryable) => (await c.query<{ t: string }>(`SELECT current_setting('app.tenant_id') AS t`)).rows[0]!.t;
const countryOf = async (c: Queryable) =>
  (await c.query<{ country_code: string }>(`SELECT country_code FROM core.tenant`)).rows[0]!.country_code;

/** Fixed command names (db: core.command_authority; tenancy.onboard.v1 / member.bind / role.set / deactivate
 *  seeded by 0015 A4 — the self-serve person is not an operator). */
export const TYPES = {
  onboard: "tenancy.onboard.v1",
  outletCreate: "tenancy.outlet.create.v1",
  outletUpdate: "tenancy.outlet.update.v1",
  tenantUpdate: "tenancy.tenant.update.v1",
  policySet: "tenancy.policy.set.v1",
  brandCreate: "tenancy.brand.create.v1",
  channelCreate: "tenancy.channel.create.v1",
  deviceRegister: "tenancy.device.register.v1",
  invite: "tenancy.member.invite.v1",
  bind: "tenancy.member.bind.v1",
  roleSet: "tenancy.member.role.set.v1",
  deactivate: "tenancy.member.deactivate.v1",
  demo: "demo.session.start.v1",
} as const;

function payload<T>(schema: { parse(x: unknown): T }, cmd: CommandEnvelope): T {
  try {
    return schema.parse(cmd.payload);
  } catch {
    throw new ApiError("invalid_payload");
  }
}

/** A member whose outlet scope is not '*' may act only on their own outlets (the guard says the same for
 *  book rows; for operational rows RLS would answer with a driver error). */
export function assertOutletInScope(m: Member, outlet_id: string): void {
  if (m.outlet_ids !== "*" && !m.outlet_ids.includes(outlet_id)) throw new ApiError("book_write_refused", "authority_denied");
}

/** Self-serve: a signed-in person becomes owner of a new tenant. The owner member row carries the verified
 *  IdP subject, so requireMember works on the very next request. */
/** R64 X-4: how many businesses one sign-in may create self-serve. A retry of the same envelope replays before this runs. */
export const ONBOARD_TENANT_CAP = 5;

export const onboardHandler = (who: { sub: string; email: string }): CommandHandler => ({
  type: TYPES.onboard,
  async run(c, cmd) {
    const p = payload(TenancyOnboardV1, cmd);
    // Serialised per sign-in, so two onboardings in parallel cannot both take the last place.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('tenancy.onboard:' || $1, 0))`, [who.sub]);
    const owned = await c.query<{ n: string }>(`SELECT count(*) AS n FROM core.memberships_for_sub($1) WHERE role = 'owner'`, [who.sub]);
    if (Number(owned.rows[0]!.n) >= ONBOARD_TENANT_CAP) throw new ApiError("forbidden");
    const r = await provisionTenant(c, {
      tenant_id: p.tenant_id, name: p.business_name, country_code: p.country_code, kind: p.kind, is_demo: false, onboarded: true,
      owner: { member_id: p.owner_member_id, name: p.owner_name, email: who.email, idp_sub: who.sub, role: "owner" },
      outlet: { outlet_id: p.outlet_id, ...p.outlet },
    });
    return {
      entityId: r.tenant_id,
      audit: [
        { entity: "core.tenant", entityId: r.tenant_id, after: { kind: p.kind, country_code: p.country_code, onboarded: true } },
        { entity: "core.outlet", entityId: p.outlet_id, after: { channels: r.channel_ids.length, devices: r.device_ids.length } },
        { entity: "core.member", entityId: p.owner_member_id, after: { role: "owner" } },
      ],
    };
  },
});

export const demoHandler: CommandHandler = {
  type: TYPES.demo,
  async run(c, cmd) {
    const p = payload(DemoSessionStartV1, cmd);
    const r = await provisionTenant(c, {
      tenant_id: p.tenant_id, name: "Sample business (demo)", country_code: p.country_code, kind: p.kind, is_demo: true, onboarded: true,
      owner: { member_id: p.member_id, name: p.judge_label, email: `judge-${p.member_id}@demo.invalid`, idp_sub: p.idp_sub, role: "judge" },
      outlet: { outlet_id: p.outlet_id, name: "Sample outlet", address: "Synthetic address (sample data)", tax_ids: {} },
    });
    return {
      entityId: r.tenant_id,
      audit: [
        { entity: "core.tenant", entityId: r.tenant_id, after: { is_demo: true, country_code: p.country_code } },
        { entity: "core.member", entityId: p.member_id, after: { role: "judge", ephemeral: true } },
      ],
    };
  },
};

export const outletCreateHandler: CommandHandler = {
  type: TYPES.outletCreate,
  async run(c, cmd) {
    const p = payload(TenancyOutletCreateV1, cmd);
    const pack = await loadPack(c, await countryOf(c));
    checkZone(pack, p.tz);
    checkTaxIds(pack, p.tax_ids);
    const t = await tenantOf(c);
    const d = KIND_DEFAULTS[p.kind === "store" ? "shop" : p.kind];
    await c.query(
      `INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address, tax_ids, default_prep_min, pickup_slot_min, pickup_lead_min, phone, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_setting('app.member_id')::uuid)`,
      [t, p.outlet_id, p.name, p.kind, p.tz, p.address, JSON.stringify(p.tax_ids), d.default_prep_min, d.pickup_slot_min, d.pickup_lead_min, p.phone ?? null]);
    for (let weekday = 0; weekday < 7; weekday++) {
      await c.query(
        `INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, weekday, opens_at, closes_at, created_by)
         VALUES ($1, $2, $3, 'weekly', $4, $5, $6, current_setting('app.member_id')::uuid)`,
        [t, uuidv7(), p.outlet_id, weekday, DEFAULT_HOURS.opens, DEFAULT_HOURS.closes]);
    }
    return { entityId: p.outlet_id, audit: [{ entity: "core.outlet", entityId: p.outlet_id, after: { name: p.name, kind: p.kind } }] };
  },
};

const OUTLET_COLUMNS = [
  "name", "address", "accepting_orders", "busy_extra_min", "default_prep_min", "cancel_window_min", "reschedule_window_min",
  "pickup_slot_min", "pickup_lead_min", "upi_vpa", "business_day_cutoff", "phone",
] as const;

export const outletUpdateHandler = (m: Member): CommandHandler => ({
  type: TYPES.outletUpdate,
  async run(c, cmd) {
    const p = payload(TenancyOutletUpdateV1, cmd);
    const cur = await c.query<{ id: string }>(`SELECT id FROM core.outlet WHERE id = $1`, [p.outlet_id]);
    if (!cur.rows[0]) throw new ApiError("not_found");
    // The UPDATE reaches the book guard (outlet scope, MB001): a manager of outlet A touching outlet B is refused by
    // the database, not by a lookup that pretends B does not exist.
    const sets: string[] = [];
    const args: unknown[] = [p.outlet_id];
    for (const col of OUTLET_COLUMNS) {
      if (p[col] !== undefined) { args.push(p[col]); sets.push(`${col} = $${args.length}`); }
    }
    if (p.tax_ids !== undefined) {
      checkTaxIds(await loadPack(c, await countryOf(c)), p.tax_ids);
      args.push(JSON.stringify(p.tax_ids));
      sets.push(`tax_ids = $${args.length}`);
    }
    if (sets.length) {
      const r = await c.query(`UPDATE core.outlet SET ${sets.join(", ")} WHERE id = $1`, args);
      if (r.rowCount !== 1) throw new ApiError("book_write_refused", "authority_denied");
    } else assertOutletInScope(m, p.outlet_id);
    // R1-M2: each weekly calendar row changed is audited on its own, as it was (locked) and as it is now.
    const hours: AuditEntry[] = [];
    if (p.hours) {
      const was = await c.query<{ id: string; weekday: number; opens_at: string | null; closes_at: string | null; closed: boolean }>(
        `SELECT id, weekday, opens_at::text, closes_at::text, closed FROM core.outlet_calendar WHERE outlet_id = $1 AND kind = 'weekly' ORDER BY weekday FOR UPDATE`,
        [p.outlet_id]);
      const r = await c.query<{ id: string; weekday: number; opens_at: string | null; closes_at: string | null; closed: boolean }>(
        `UPDATE core.outlet_calendar SET opens_at = $2, closes_at = $3 WHERE outlet_id = $1 AND kind = 'weekly'
         RETURNING id, weekday, opens_at::text, closes_at::text, closed`, [p.outlet_id, p.hours.opens, p.hours.closes]);
      if (r.rowCount !== 7) throw new ApiError("book_write_refused", "authority_denied");
      for (const a of r.rows) {
        const { id: _b, ...before } = was.rows.find((b) => b.id === a.id)!;
        const { id: _a, ...after } = a;
        hours.push({ entity: "core.outlet_calendar", entityId: a.id, before, after });
      }
    }
    const { outlet_id: _id, ...changed } = p;
    return { entityId: p.outlet_id, audit: [{ entity: "core.outlet", entityId: p.outlet_id, after: changed }, ...hours] };
  },
});

export const tenantUpdateHandler: CommandHandler = {
  type: TYPES.tenantUpdate,
  async run(c, cmd) {
    const p = payload(TenancyTenantUpdateV1, cmd);
    const t = await tenantOf(c);
    const cur = (await c.query<{ country_code: string }>(`SELECT country_code FROM core.tenant WHERE tenant_id = $1`, [t])).rows[0];
    if (!cur) throw new ApiError("not_found");
    const sets: string[] = [];
    const args: unknown[] = [t];
    const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if (p.name !== undefined) set("name", p.name);
    if (p.home_tz !== undefined) {
      if (p.home_tz !== null) checkZone(await loadPack(c, cur.country_code), p.home_tz);
      set("home_tz", p.home_tz);
    }
    if (p.country_code !== undefined && p.country_code !== cur.country_code) {
      // After onboarding the UPDATE below is issued unchanged so the database refuses it (MB002 → 409 country_locked).
      // Before onboarding, the rows already created from the old pack must fit the new one (project rule 7).
      const pack = await loadPack(c, p.country_code);
      const done = await c.query(`SELECT 1 FROM core.tenant WHERE onboarded_at IS NOT NULL`);
      if (!done.rows[0]) {
        const misfit = await c.query(
          `SELECT 1 FROM core.outlet WHERE tz <> ALL ($1::text[])
           UNION ALL SELECT 1 FROM core.channel WHERE kind LIKE 'aggregator:%' AND NOT kind = ANY ($2::text[])
           UNION ALL SELECT 1 FROM core.outlet o, jsonb_object_keys(o.tax_ids) k WHERE NOT k = ANY ($3::text[])`,
          [pack.timezones, pack.aggregators.map((a) => `aggregator:${a.code}`), pack.tax_ids.map((t) => t.code)]);
        if (misfit.rows[0]) throw new ApiError("out_of_pack_scope");
      }
      set("country_code", p.country_code);
      set("base_currency", pack.currency.code);
      set("fy_start_month", pack.fy_start_month);
    }
    if (p.complete_onboarding) sets.push("onboarded_at = coalesce(onboarded_at, now())");
    if (sets.length) await c.query(`UPDATE core.tenant SET ${sets.join(", ")} WHERE tenant_id = $1`, args);
    return { entityId: t, audit: [{ entity: "core.tenant", entityId: t, after: p }] };
  },
};

/** tenancy.policy.set.v1 — a new dated version of the business policy (owner; the authority row and the book guard decide who). The
 *  version in force for the scope is closed at the new `valid_from`, the new one carries every column not set over from it. */
export const policySetHandler: CommandHandler = {
  type: TYPES.policySet,
  async run(c, cmd) {
    const p = payload(TenancyPolicySetV1, cmd);
    if (p.outlet_id) await assertOutlets(c, [p.outlet_id]);
    const cur = (await c.query<Record<string, any>>(
      `SELECT id, valid_from::text AS valid_from, target_margin_bp, margin_floor_bp, labour_target_bp, min_payment_days, loyalty_earn_per_minor, loyalty_point_value_minor,
              negotiation_target_bp, negotiation_walkaway_bp
         FROM core.business_policy WHERE outlet_id IS NOT DISTINCT FROM $1 AND valid_to IS NULL FOR UPDATE`, [p.outlet_id])).rows[0];
    if (cur && cur.valid_from >= p.valid_from) throw new ApiError("conflict");
    const next = {
      target_margin_bp: p.target_margin_bp ?? cur?.target_margin_bp ?? null, margin_floor_bp: p.margin_floor_bp ?? cur?.margin_floor_bp ?? null,
      labour_target_bp: p.labour_target_bp ?? cur?.labour_target_bp ?? null, min_payment_days: p.min_payment_days ?? cur?.min_payment_days ?? null,
      loyalty_earn_per_minor: cur?.loyalty_earn_per_minor ?? 1000, loyalty_point_value_minor: cur?.loyalty_point_value_minor ?? 10,
      negotiation_target_bp: p.negotiation_target_bp ?? cur?.negotiation_target_bp ?? null,
      negotiation_walkaway_bp: p.negotiation_walkaway_bp ?? cur?.negotiation_walkaway_bp ?? null,
    };
    // R47 D7: judged on the effective pair, so setting one bound cannot cross the other (or the default of the other).
    if ((next.negotiation_target_bp ?? NEGOTIATION_DEFAULTS.target_bp) > (next.negotiation_walkaway_bp ?? NEGOTIATION_DEFAULTS.walkaway_bp)) throw new ApiError("invalid_payload");
    if (next.margin_floor_bp !== null && next.target_margin_bp !== null && next.margin_floor_bp > next.target_margin_bp) throw new ApiError("invalid_payload");
    const id = uuidv7();
    if (cur) await c.query(`UPDATE core.business_policy SET valid_to = $2 WHERE id = $1`, [cur.id, p.valid_from]);
    await c.query(
      `INSERT INTO core.business_policy (tenant_id, id, outlet_id, target_margin_bp, margin_floor_bp, labour_target_bp, min_payment_days, loyalty_earn_per_minor,
                                         loyalty_point_value_minor, negotiation_target_bp, negotiation_walkaway_bp, valid_from, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_setting('app.member_id')::uuid)`,
      [id, p.outlet_id, next.target_margin_bp, next.margin_floor_bp, next.labour_target_bp, next.min_payment_days, next.loyalty_earn_per_minor,
        next.loyalty_point_value_minor, next.negotiation_target_bp, next.negotiation_walkaway_bp, p.valid_from]);
    return {
      entityId: id,
      audit: [
        ...(cur ? [{ entity: "core.business_policy", entityId: cur.id, before: { valid_to: null }, after: { valid_to: p.valid_from } }] : []),
        { entity: "core.business_policy", entityId: id, after: { outlet_id: p.outlet_id, valid_from: p.valid_from, labour_target_bp: next.labour_target_bp, target_margin_bp: next.target_margin_bp,
          margin_floor_bp: next.margin_floor_bp, min_payment_days: next.min_payment_days, negotiation_target_bp: next.negotiation_target_bp, negotiation_walkaway_bp: next.negotiation_walkaway_bp } },
      ],
    };
  },
};

export const brandCreateHandler: CommandHandler = {
  type: TYPES.brandCreate,
  async run(c, cmd) {
    const p = payload(TenancyBrandCreateV1, cmd);
    await assertOutlets(c, p.outlet_ids);
    await c.query(`INSERT INTO core.brand (tenant_id, id, name, outlet_ids, created_by) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, current_setting('app.member_id')::uuid)`,
      [p.brand_id, p.name, p.outlet_ids]);
    return { entityId: p.brand_id, audit: [{ entity: "core.brand", entityId: p.brand_id, after: { name: p.name } }] };
  },
};

export const channelCreateHandler: CommandHandler = {
  type: TYPES.channelCreate,
  async run(c, cmd) {
    const p = payload(TenancyChannelCreateV1, cmd);
    if (p.kind.startsWith("aggregator:")) {
      const pack = await loadPack(c, await countryOf(c));
      if (!pack.aggregators.some((a) => `aggregator:${a.code}` === p.kind)) throw new ApiError("out_of_pack_scope");
    }
    await c.query(`INSERT INTO core.channel (tenant_id, id, name, kind, created_by) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, current_setting('app.member_id')::uuid)`,
      [p.channel_id, p.name, p.kind]);
    return { entityId: p.channel_id, audit: [{ entity: "core.channel", entityId: p.channel_id, after: { kind: p.kind } }] };
  },
};

export const deviceRegisterHandler = (m: Member): CommandHandler => ({
  type: TYPES.deviceRegister,
  async run(c, cmd) {
    const p = payload(TenancyDeviceRegisterV1, cmd);
    // core.device is operational, so the book guard never judges this write: role and outlet scope are core.command_authority's,
    // checked here (C1 S2-7: a staff member must not register a POS device with its own invoice series).
    const row = (await c.query<{ allowed_roles: string[]; scope: string }>(
      `SELECT allowed_roles, scope FROM core.command_authority WHERE command_type = $1`, [TYPES.deviceRegister])).rows[0];
    const verdict = row && evaluateAuthority(
      { command_type: TYPES.deviceRegister, role: m.role, outlet_scope: m.outlet_ids === "*" ? ["*"] : m.outlet_ids, target_outlet_id: p.outlet_id },
      [{ command_type: TYPES.deviceRegister, ...row, max_amount_minor: null }]);
    if (!verdict?.allow) throw new ApiError("forbidden", "authority_denied");
    if ((p.kind === "pos") === (p.invoice_series === null)) throw new ApiError("invalid_payload", null, { refs: ["device:invoice_series"] });
    await assertOutlets(c, [p.outlet_id]);
    await c.query(`INSERT INTO core.device (tenant_id, id, outlet_id, kind, invoice_series, created_by) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)`,
      [p.device_id, p.outlet_id, p.kind, p.invoice_series, m.member_id]);
    return { entityId: p.device_id, audit: [{ entity: "core.device", entityId: p.device_id, after: { outlet_id: p.outlet_id, kind: p.kind } }] };
  },
});

async function assertOutlets(c: Queryable, ids: readonly string[]) {
  const r = await c.query<{ n: string }>(`SELECT count(*) n FROM core.outlet WHERE id = ANY($1::uuid[])`, [ids]);
  if (Number(r.rows[0]!.n) !== new Set(ids).size) throw new ApiError("not_found");
}

export const inviteHandler: CommandHandler = {
  type: TYPES.invite,
  async run(c, cmd) {
    const p = payload(TenancyMemberInviteV1, cmd);
    // A manager or staff member is tied to outlets; only owner/advisor may span all of them.
    if ((p.role === "manager" || p.role === "staff") && p.outlet_ids.length === 0) throw new ApiError("invalid_payload", null, { refs: ["member:outlet_ids"] });
    if (p.outlet_ids.length) await assertOutlets(c, p.outlet_ids);
    const email = p.email.toLowerCase();
    const dup = await c.query(`SELECT 1 FROM core.member WHERE lower(email) = $1 AND active`, [email]);
    if (dup.rows[0]) throw new ApiError("conflict");
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email, created_by) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, current_setting('app.member_id')::uuid)`,
      [p.member_id, p.name, email]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids, created_by) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, current_setting('app.member_id')::uuid)`,
      [p.member_id, p.role, p.outlet_ids]);
    return { entityId: p.member_id, audit: [{ entity: "core.member", entityId: p.member_id, after: { role: p.role, outlet_ids: p.outlet_ids } }] };
  },
};

/** The invitee's first sign-in. `sub` and `email` are the verified IdP identity (never the payload). Exactly one
 *  subject ever binds: a different sub finds idp_sub already set → conflict; the same sub again is a no-op. */
export const bindHandler = (who: { sub: string; email: string }): CommandHandler => ({
  type: TYPES.bind,
  async run(c, cmd) {
    const p = payload(TenancyMemberBindV1, cmd);
    const taken = await c.query(`SELECT 1 FROM core.member WHERE idp_sub = $1 AND id <> $2`, [who.sub, p.member_id]);
    if (taken.rows[0]) throw new ApiError("conflict");
    const r = await c.query(
      `UPDATE core.member SET idp_sub = $2 WHERE id = $1 AND idp_sub IS NULL AND active AND lower(email) = lower($3)`,
      [p.member_id, who.sub, who.email]);
    let already = false;
    if (r.rowCount !== 1) {
      const cur = await c.query<{ idp_sub: string | null }>(`SELECT idp_sub FROM core.member WHERE id = $1 AND active AND lower(email) = lower($2)`, [p.member_id, who.email]);
      if (!cur.rows[0]) throw new ApiError("not_found");
      if (cur.rows[0].idp_sub !== who.sub) throw new ApiError("conflict");
      already = true;
    }
    return { entityId: p.member_id, audit: [{ entity: "core.member", entityId: p.member_id, after: { bound: true, already } }] };
  },
});

type MemberRow = { role: string; outlet_ids: string[]; active: boolean };
/** Another member of this tenant (not the caller, not a judge), with their membership. The caller changing their own
 *  role or deactivating themselves is refused: the tenant always keeps the owner who acts. */
async function otherMember(c: Queryable, memberId: string): Promise<MemberRow> {
  const self = (await c.query<{ me: string }>(`SELECT current_setting('app.member_id') AS me`)).rows[0]!.me;
  if (self === memberId) throw new ApiError("conflict");
  const row = (await c.query<MemberRow>(
    `SELECT ms.role, ms.outlet_ids, (m.active AND ms.active) AS active
       FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id WHERE m.id = $1`, [memberId])).rows[0];
  if (!row || row.role === "judge") throw new ApiError("not_found");
  return row;
}

export const roleSetHandler: CommandHandler = {
  type: TYPES.roleSet,
  async run(c, cmd) {
    const p = payload(TenancyMemberRoleSetV1, cmd);
    if ((p.role === "manager" || p.role === "staff") && p.outlet_ids.length === 0) throw new ApiError("invalid_payload", null, { refs: ["member:outlet_ids"] });
    if (p.outlet_ids.length) await assertOutlets(c, p.outlet_ids);
    const before = await otherMember(c, p.member_id);
    if (!before.active) throw new ApiError("conflict");
    await c.query(`UPDATE core.membership SET role = $2, outlet_ids = $3 WHERE member_id = $1`, [p.member_id, p.role, p.outlet_ids]);
    return { entityId: p.member_id, audit: [{ entity: "core.membership", entityId: p.member_id,
      before: { role: before.role, outlet_ids: before.outlet_ids }, after: { role: p.role, outlet_ids: p.outlet_ids } }] };
  },
};

export const deactivateHandler: CommandHandler = {
  type: TYPES.deactivate,
  async run(c, cmd) {
    const p = payload(TenancyMemberDeactivateV1, cmd);
    if (!(await otherMember(c, p.member_id)).active) throw new ApiError("conflict");
    await c.query(`UPDATE core.member SET active = false WHERE id = $1`, [p.member_id]);
    await c.query(`UPDATE core.membership SET active = false WHERE member_id = $1`, [p.member_id]);
    return { entityId: p.member_id, audit: [
      { entity: "core.member", entityId: p.member_id, before: { active: true }, after: { active: false } },
      { entity: "core.membership", entityId: p.member_id, before: { active: true }, after: { active: false } },
    ] };
  },
};
