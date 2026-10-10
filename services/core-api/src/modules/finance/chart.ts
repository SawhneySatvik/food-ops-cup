// seedChart (seam for T-020 onboarding / provisioning): the tenant's chart of accounts from its country pack
// plus Munim's structural accounts (core-domain chartFor). Runs inside the caller's transaction under a
// command whose target_tables list core.account (tenancy.provision.v1, demo.session.start.v1). Idempotent by
// code: an account the tenant already has is left as it is.
import type { CountryPack } from "@munim/contracts/packs";
import { chartFor } from "@munim/core-domain/finance";
import { uuidv7 } from "../../commit/index.ts";
import type { Tx } from "./post.ts";

/** Returns code → account id for the whole chart (existing and new). */
export async function seedChart(tx: Tx, pack: Pick<CountryPack, "chart_of_accounts">): Promise<Record<string, string>> {
  for (const a of chartFor(pack)) {
    await tx.query(
      `INSERT INTO core.account (tenant_id, id, code, name, type) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)
       ON CONFLICT (tenant_id, code) DO NOTHING`, [uuidv7(), a.code, a.name, a.type]);
  }
  const r = await tx.query<{ id: string; code: string }>(`SELECT id, code FROM core.account ORDER BY code`);
  return Object.fromEntries(r.rows.map((x) => [x.code, x.id]));
}
