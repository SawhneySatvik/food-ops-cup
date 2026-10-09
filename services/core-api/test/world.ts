// core-api fixtures on m-1's canonical world (`buildWorld` from @munim/db, W1 fix #10): every book write goes
// through the guard under the command whose target_tables list the table (MB008-correct). On top of it this
// adds only what the auth gates need: idp subjects on the owner and an outlet-1 manager, a storefront key
// with a known raw value, a customer login, and a guest order with a known access token. Synthetic data only.
import { createHash, randomBytes } from "node:crypto";
import { type AppContext, buildWorld, ownerCtx, type TestDb, uuidv7, type World } from "@munim/db";

export interface Tenant extends World {
  manager: string;
  /** idp-local subjects of the owner and of the manager scoped to outlet 1. */
  ownerSub: string;
  managerSub: string;
  /** Raw storefront key (only its sha256 hex is stored), bound to `channel`. */
  storefrontKey: string;
}

const cmd = (w: World, command_type: string): AppContext => ownerCtx(w, { command_type });

export async function buildTenant(db: TestDb, label: string): Promise<Tenant> {
  const w = await buildWorld(db);
  const t: Tenant = {
    ...w,
    manager: uuidv7(),
    ownerSub: `owner-${label}-${uuidv7()}`,
    managerSub: `manager-${label}-${uuidv7()}`,
    storefrontKey: `sfk_${label}_${randomBytes(24).toString("hex")}`,
  };
  await db.withContext("munim_core", cmd(w, "tenancy.member.invite.v1"), async (c) => {
    await c.query("UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2", [w.tenant, w.owner, t.ownerSub]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Manager', 'manager@example.test')`,
      [w.tenant, t.manager, t.managerSub]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`,
      [w.tenant, t.manager, [w.outlets[0]]]);
  });
  // core.storefront_key is operational (no guard); tenant RLS only.
  await db.withContext("munim_core", ownerCtx(w), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`,
      [w.tenant, uuidv7(), w.channel, createHash("sha256").update(t.storefrontKey).digest("hex")]));
  return t;
}

/** A customer profile at this merchant linked to `sub` (R41), created as a member's own command. */
export async function addCustomer(db: TestDb, t: Tenant, sub: string): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_core", cmd(t, "customers.customer.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.customer (tenant_id, id, name, idp_sub, is_guest) VALUES ($1, $2, 'Synthetic Customer', $3, false)`,
      [t.tenant, id, sub]));
  return id;
}

/** An order in outlet 1 carrying a guest access hash; returns the order id and the raw token. */
export async function addGuestOrder(db: TestDb, t: Tenant, customerId: string): Promise<{ order: string; token: string }> {
  const order = uuidv7();
  const token = randomBytes(32).toString("base64url");
  await db.withContext("munim_core", cmd(t, "orders.place.v1"), (c) =>
    c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency,
                                       pricing_snapshot, customer_id, guest_access_hash)
             VALUES ($1, $2, $3, $4, 'pickup', 'placed', 32000, 1600, 33600, $5, '{}', $6, $7)`,
      [t.tenant, order, t.outlets[0], t.channel, t.currency, customerId, createHash("sha256").update(token).digest()]));
  return { order, token };
}
