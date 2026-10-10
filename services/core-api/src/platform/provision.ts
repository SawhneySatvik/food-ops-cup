// POST /platform/v1/tenants:provision - `tenancy.provision.v1` run as the operator's own command (R27). The
// tenant does not exist yet, so the transaction's tenant context is the payload's tenant_id (chosen by the
// operator's client, uuid7). The write itself is the tenancy module's `provisionTenant` seam (T-020, W2 brief);
// until it lands the call refuses `unavailable`. Tests install a local fake with setProvisionTenant.
import type { Context } from "hono";
import { CommandEnvelope } from "@munim/contracts";
import { TenancyProvisionV1 } from "@munim/contracts/tenancy";
import { executeCommand } from "../commit/index.ts";
import { withContext } from "../lib/db.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";
import type { Queryable } from "../runtoken/index.ts";

export type ProvisionSpec = ReturnType<typeof TenancyProvisionV1.parse>;
export type ProvisionTenant = (tx: Queryable, spec: ProvisionSpec) => Promise<{ tenant_id: string; outlet_ids: string[]; owner_member_id: string }>;

let override: ProvisionTenant | null = null;
/** Test seam only: the real function comes from modules/tenancy/index.ts. */
export function setProvisionTenant(fn: ProvisionTenant | null): void {
  override = fn;
}

async function seam(): Promise<ProvisionTenant> {
  if (override) return override;
  const path = "../modules/tenancy/index.ts"; // variable specifier: the module may not exist yet
  try {
    const m = (await import(path)) as { provisionTenant?: ProvisionTenant };
    if (typeof m.provisionTenant === "function") return m.provisionTenant;
  } catch {
    /* not landed */
  }
  throw new ApiError("unavailable");
}

export async function provision(c: Context<AppEnv>, operatorId: string, raw: unknown): Promise<{ body: string; replayed: boolean }> {
  const env = CommandEnvelope.safeParse(raw);
  if (!env.success || env.data.type !== "tenancy.provision.v1") throw new ApiError("bad_request");
  const payload = TenancyProvisionV1.safeParse(env.data.payload);
  if (!payload.success) throw new ApiError("bad_request");
  const fn = await seam();
  const { deps } = c.var;
  const out = await executeCommand(
    {
      tx: (f) => withContext(deps.pools.core, { tenant_id: payload.data.tenant_id, outlet_ids: "*", role: "operator", operator_id: operatorId }, f),
      tenantId: payload.data.tenant_id,
      actor: { kind: "operator", id: operatorId, role: "operator" },
      ...(deps.publish ? { publish: deps.publish } : {}),
    },
    env.data,
    {
      type: "tenancy.provision.v1",
      async run(db) {
        const pack = await db.query(`SELECT 1 FROM platform.country_pack WHERE code = $1 AND status = 'active' LIMIT 1`, [payload.data.country_code]);
        if (pack.rowCount === 0) throw new ApiError("out_of_pack_scope");
        const r = await fn(db, payload.data);
        return { entityId: r.tenant_id, audit: [{ entity: "core.tenant", entityId: r.tenant_id, after: { country_code: payload.data.country_code, is_demo: payload.data.is_demo } }] };
      },
    },
  );
  return { body: out.body, replayed: out.replayed };
}
