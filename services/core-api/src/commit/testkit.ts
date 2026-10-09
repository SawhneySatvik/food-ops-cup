// Test support for the commit and run-token gates — imported by tests only (it pulls @munim/db, a
// devDependency; production never imports it, gotcha 32). Synthetic data only.
import { generateKeyPairSync } from "node:crypto";
import type { AppContext, TestDb } from "@munim/db";
import type { SvcTx } from "../runtoken/index.ts";
import type { Actor, CommandContext, CoreTx } from "./execute.ts";
import { uuidv7 } from "./canonical.ts";

export interface Tenant {
  tenant: string;
  owner: string;
  operator: string;
}

/** Provisions a tenant + owner the way the platform does: the operator's own tenancy.provision.v1 command. */
export async function provisionTenant(db: TestDb): Promise<Tenant> {
  const t: Tenant = { tenant: uuidv7(), owner: uuidv7(), operator: uuidv7() };
  await db.withContext("munim_core", {
    tenant_id: t.tenant, outlet_ids: "*", role: "operator", operator_id: t.operator, command_type: "tenancy.provision.v1",
  }, async (c) => {
    await c.query(`INSERT INTO core.tenant (tenant_id, name, country_code, base_currency, fy_start_month)
                   VALUES ($1, 'Synthetic Tenant', 'IN', 'INR', 4)`, [t.tenant]);
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Owner', 'owner@example.test')`, [t.tenant, t.owner]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'owner')`, [t.tenant, t.owner]);
  });
  return t;
}

/** The owner's request context (what T-004's identity resolution produces), as a munim_core transaction runner. */
export function ownerTx(db: TestDb, t: Tenant, extra: AppContext = {}): CoreTx {
  const ctx: AppContext = { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, ...extra };
  return (fn) => db.withContext("munim_core", ctx, fn);
}

export function svcTx(db: TestDb): SvcTx {
  return (scope, fn) =>
    db.withContext("munim_svc", { tenant_id: scope.tenantId, outlet_ids: scope.outletScope[0] === "*" ? "*" : scope.outletScope, role: "service" }, fn);
}

export function ownerActor(t: Tenant): Actor {
  return { kind: "member", id: t.owner, role: "owner" };
}

export function ownerContext(db: TestDb, t: Tenant, extra: Partial<CommandContext> = {}): CommandContext {
  return { tx: ownerTx(db, t), tenantId: t.tenant, actor: ownerActor(t), ...extra };
}

export function testKeys() {
  return generateKeyPairSync("ed25519");
}
