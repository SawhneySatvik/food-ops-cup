// Command handlers for the customer's own account commands (R41). Each runs inside executeCommand under the
// customer's own context (app.role = customer, app.customer_id = the principal), so the book guard judges every
// write as this customer's own (customer_target_tables + book_row_customer_owned) and RLS shows only their rows.
// Audit entries carry ids and flags only — never a name, phone, email or token: audit_log is append-only and
// must stay clean after an erasure.
import type { CommandEnvelope } from "@munim/contracts";
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
        // The database does the claim (0017 C1): it proves the token, refuses an order on a signed-in profile,
        // moves the order and its coupon uses, and marks the emptied guest profile merged so erasure reaches it (R41).
        const rows = (await c.query<{ entity: string; entity_id: string; from_customer_id: string | null }>(
          `SELECT entity, entity_id, from_customer_id FROM core.customer_claim_guest_token()`)).rows;
        if (rows.length === 0) throw new ApiError("not_found");
        for (const m of rows) {
          audit.push(m.entity === "core.customer"
            ? { entity: m.entity, entityId: m.entity_id, before: { merged_into: null }, after: { merged_into: spec.customerId, claimed_by: "guest_token" } }
            : { entity: m.entity, entityId: m.entity_id, before: { customer_id: m.from_customer_id }, after: { customer_id: spec.customerId, claimed_by: "guest_token" } });
        }
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

/** Placeholder for a NOT NULL name column of an erased customer's reservation or bulk order. */
export const ERASED_NAME = "[erased]";

/** R41 erasure (R1-M1). Personal text is blanked wherever this customer left it — reservations (name, phone,
 *  note), bulk orders (contact name, phone, note) and the notes on their order lines — then the profile itself and
 *  every guest profile merged into it are closed: core.customer_erasure (0004) blanks name, phone, email, idp_sub,
 *  email_verified_at and consent in the same row write and refuses any later change (MB007). Order rows, amounts
 *  and loyalty entries are kept. One audit entry per changed row, ids and column names only. */
export function erasureHandler(customerId: string): CommandHandler {
  return {
    type: ERASURE,
    async run(c) {
      const audit: AuditEntry[] = [];
      const blank = async (entity: string, sql: string, fields: string[], params: unknown[] = [customerId]) => {
        for (const r of (await c.query<{ id: string }>(sql, params)).rows) {
          audit.push({ entity, entityId: r.id, after: { erased_fields: fields } });
        }
      };
      await blank("core.reservation",
        `UPDATE core.reservation SET name = $2, phone = NULL, note = NULL
          WHERE customer_id = $1 AND (name <> $2 OR phone IS NOT NULL OR note IS NOT NULL) RETURNING id`, ["name", "phone", "note"], [customerId, ERASED_NAME]);
      await blank("core.bulk_order",
        `UPDATE core.bulk_order SET contact_name = $2, contact_phone = NULL, note = NULL
          WHERE customer_id = $1 AND (contact_name <> $2 OR contact_phone IS NOT NULL OR note IS NOT NULL) RETURNING id`, ["contact_name", "contact_phone", "note"], [customerId, ERASED_NAME]);
      await blank("core.order_line",
        `UPDATE core.order_line l SET note = NULL
          WHERE l.note IS NOT NULL
            AND EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = l.tenant_id AND o.id = l.order_id AND o.customer_id = $1) RETURNING l.id`, ["note"]);
      const r = await c.query(`UPDATE core.customer SET erased_at = now() WHERE id = $1 AND erased_at IS NULL`, [customerId]);
      if (r.rowCount !== 1) throw new ApiError("not_found");
      audit.push({ entity: "core.customer", entityId: customerId, after: { erased: true } });
      // Guest profiles merged into this one by the verified-email merge hold the same person's name, phone and email.
      // This context cannot see them (customer_scope; the guard's own-row rule), so 0016's definer erases them —
      // only after the profile itself is erased — and returns each one for its audit entry.
      for (const g of (await c.query<{ entity_id: string }>(`SELECT entity_id FROM core.customer_erase_merged_guests($1)`, [customerId])).rows) {
        audit.push({ entity: "core.customer", entityId: g.entity_id, after: { erased: true, merged_into: customerId } });
      }
      return { entityId: customerId, audit };
    },
  };
}
