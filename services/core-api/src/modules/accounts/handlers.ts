// Command handlers for the customer's own account commands (R41). Each runs inside executeCommand under the
// customer's own context (app.role = customer, app.customer_id = the principal), so the book guard judges every
// write as this customer's own (customer_target_tables + book_row_customer_owned) and RLS shows only their rows.
// Audit entries carry ids and flags only — never a name, phone, email or token: audit_log is append-only and
// must stay clean after an erasure.
import type { CommandEnvelope } from "@munim/contracts";
import { asSystem } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AuditEntry, CommandHandler, HandlerOutput } from "../../commit/index.ts";

export const LINK = "customers.account.link.v1";
export const PROFILE_UPDATE = "customers.profile.update.v1";
export const CONSENT_SET = "customers.consent.set.v1";
export const DATA_EXPORT = "customers.data.export.v1";
export const ERASURE = "customers.erasure.request.v1";

export interface LinkSpec {
  tenantId: string;
  customerId: string;
  /** false: first sign-in here — the handler creates the profile row with `customerId`. */
  profileExists: boolean;
  sub: string;
  /** From the verified IdP token only. */
  email: string | null;
  emailVerified: boolean;
  /** hex(sha256(guest token)) when the request claims a guest order (also set as app.guest_access_hash). */
  claimHash: string | null;
}

/** customers.account.link.v1: create this merchant's profile on first sign-in, then claim the guest order the
 *  presented token proves, then (verified email only) the matching guest profiles' orders, reservations and bulk
 *  orders through core.customer_claim_verified_email_guests() (0015 A10). */
export function linkHandler(spec: LinkSpec): CommandHandler {
  return {
    type: LINK,
    async run(c, command: CommandEnvelope): Promise<HandlerOutput> {
      const p = command.payload as { name: string; phone: string | null };
      const audit: AuditEntry[] = [];
      if (!spec.profileExists) {
        await c.query(
          `INSERT INTO core.customer (tenant_id, id, name, phone, email, is_guest, idp_sub, email_verified_at, created_by)
           VALUES ($1, $2, $3, $4, $5, false, $6, CASE WHEN $7::boolean THEN now() END, $2)`,
          [spec.tenantId, spec.customerId, p.name, p.phone, spec.email, spec.sub, spec.emailVerified]);
        audit.push({ entity: "core.customer", entityId: spec.customerId, after: { is_guest: false, linked: true, email_verified: spec.emailVerified } });
      }

      if (spec.claimHash) {
        // Visible only because the claim context carries the token's hash (0014 customer_scope on core.order).
        const hit = (await c.query<{ id: string; customer_id: string | null }>(
          `SELECT id, customer_id FROM core."order" WHERE guest_access_hash = decode($1, 'hex')`, [spec.claimHash])).rows;
        const o = hit.length === 1 ? hit[0]! : undefined;
        if (!o) throw new ApiError("not_found");
        if (o.customer_id === spec.customerId) throw new ApiError("conflict");
        if (o.customer_id !== null) {
          // Only a guest checkout's order is claimable: an order already on another signed-in profile stays
          // there (a leaked tracker link must not move someone's history). Core-owned check, nothing returned.
          const owner = await asSystem(c, async () => (await c.query<{ guest: boolean }>(
            `SELECT (is_guest AND idp_sub IS NULL AND erased_at IS NULL) AS guest FROM core.customer WHERE id = $1`,
            [o.customer_id])).rows[0]);
          if (!owner?.guest) throw new ApiError("not_found");
        }
        const upd = await c.query(
          `UPDATE core."order" SET customer_id = $1 WHERE id = $2 AND guest_access_hash = decode($3, 'hex')`,
          [spec.customerId, o.id, spec.claimHash]);
        if (upd.rowCount !== 1) throw new ApiError("not_found");
        audit.push({ entity: "core.order", entityId: o.id, before: { customer_id: o.customer_id }, after: { customer_id: spec.customerId, claimed_by: "guest_token" } });
      }

      if (spec.emailVerified && spec.email !== null) {
        // One row per changed book row (moved order / reservation / bulk order, and each merged guest profile as
        // core.customer); every one is audited (db/README "verified-email merge").
        const changed = (await c.query<{ entity: string; entity_id: string; from_customer_id: string }>(
          `SELECT entity, entity_id, from_customer_id FROM core.customer_claim_verified_email_guests()`)).rows;
        for (const m of changed) {
          audit.push(m.entity === "core.customer"
            ? { entity: m.entity, entityId: m.entity_id, before: { merged_into: null }, after: { merged_into: spec.customerId, claimed_by: "verified_email" } }
            : { entity: m.entity, entityId: m.entity_id, before: { customer_id: m.from_customer_id }, after: { customer_id: spec.customerId, claimed_by: "verified_email" } });
        }
      }

      if (audit.length === 0) throw new ApiError("conflict"); // already linked, nothing to claim
      return { entityId: spec.customerId, audit };
    },
  };
}

export function profileUpdateHandler(customerId: string): CommandHandler {
  return {
    type: PROFILE_UPDATE,
    async run(c, command) {
      const p = command.payload as { name: string; phone: string | null };
      const r = await c.query(`UPDATE core.customer SET name = $2, phone = $3 WHERE id = $1`, [customerId, p.name, p.phone]);
      if (r.rowCount !== 1) throw new ApiError("not_found");
      return { entityId: customerId, audit: [{ entity: "core.customer", entityId: customerId, after: { fields: ["name", "phone"] } }] };
    },
  };
}

export function consentHandler(customerId: string): CommandHandler {
  return {
    type: CONSENT_SET,
    async run(c, command) {
      const p = command.payload as { marketing: boolean };
      const r = await c.query(
        `UPDATE core.customer SET consent = jsonb_build_object('marketing', $2::boolean, 'at', to_jsonb(now())) WHERE id = $1`,
        [customerId, p.marketing]);
      if (r.rowCount !== 1) throw new ApiError("not_found");
      return { entityId: customerId, audit: [{ entity: "core.customer", entityId: customerId, after: { marketing: p.marketing } }] };
    },
  };
}

/** The export itself writes nothing (target_tables = '{}'): the command records that it was requested. */
export function exportHandler(customerId: string): CommandHandler {
  return {
    type: DATA_EXPORT,
    async run(c) {
      const r = await c.query(`SELECT 1 FROM core.customer WHERE id = $1`, [customerId]);
      if (r.rowCount !== 1) throw new ApiError("not_found");
      return { entityId: customerId, audit: [{ entity: "core.customer", entityId: customerId, after: { exported: true } }] };
    },
  };
}

/** Setting erased_at is all core-api does: core.customer_erasure (0004) blanks name, phone, email, idp_sub,
 *  email_verified_at and consent in the same row write, and refuses any later change (MB007). */
export function erasureHandler(customerId: string): CommandHandler {
  return {
    type: ERASURE,
    async run(c) {
      const r = await c.query(`UPDATE core.customer SET erased_at = now() WHERE id = $1 AND erased_at IS NULL`, [customerId]);
      if (r.rowCount !== 1) throw new ApiError("not_found");
      return { entityId: customerId, audit: [{ entity: "core.customer", entityId: customerId, after: { erased: true } }] };
    },
  };
}
