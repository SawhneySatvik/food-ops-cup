// R64 X-2 (founder, 16 Oct 2026): on a demo business every visitor signs in as one of the same four demo people (R55 S-1), so
// core refuses the commands that would break the demo for everyone else: revoking a storefront key (the shop answers 404 until a
// reseed and a web rebuild), inviting, re-roling or deactivating a member (a picker card stops working, or an owner is planted),
// changing the monthly AI cap, and publishing a storefront page (R67 W-3: the live shop stays the seeded one; saving versions
// still works). Every other action works and is audited under the persona.
// The refusal starts once the demo business is onboarded: before that only the seed acts on it (worldgen completes onboarding
// after it has invited the demo people), so a reseed still works. A business that is not a demo is never refused here.
import type { Queryable } from "../runtoken/index.ts";
import { ApiError } from "./errors.ts";

/** Command types (and the one route action that is not a command) refused on an onboarded demo business. */
export const DEMO_PROTECTED: ReadonlySet<string> = new Set([
  "tenancy.member.invite.v1",
  "tenancy.member.role.set.v1",
  "tenancy.member.deactivate.v1",
  "ai_policy.cap.set.v1",
  "storefront.page.publish.v1",
  // storefront-keys.ts: not a command (no command_log row), named by its audit action.
  "tenancy.storefront_key.revoke",
]);

/** Throws 403 `forbidden` (`demo_protected`) when `action` is protected and the transaction's business (app.tenant_id) is an
 *  onboarded demo. */
export async function refuseOnDemo(c: Queryable, action: string): Promise<void> {
  if (!DEMO_PROTECTED.has(action)) return;
  const r = await c.query<{ locked: boolean }>(
    `SELECT is_demo AND onboarded_at IS NOT NULL AS locked FROM core.tenant WHERE tenant_id = current_setting('app.tenant_id')::uuid`);
  if (r.rows[0]?.locked === true) throw new ApiError("forbidden", "demo_protected");
}
