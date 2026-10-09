// Module registry (BOARD: owned by T-004, so module lanes never edit it). Every name below is mounted from
// `<dir>/index.ts`, which exports `router: Hono<AppEnv>` carrying its full paths (`/v1/…`, `/platform/v1/…`,
// `/internal/intel/v1/…`) and reads its dependencies from `c.var.deps`. A directory that has not landed yet
// mounts nothing; one that exists without a `router` export stops the boot (fail closed).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hono } from "hono";
import type { AppEnv } from "../lib/types.ts";

/** W1/W2 modules (03-arch §7), then the non-module routers that mount through here (T-006 stream, internal API). */
export const MODULES = [
  "tenancy",
  "catalogue",
  "orders",
  "kitchen",
  "inventory",
  "purchasing",
  "approvals",
  "finance",
  "people",
  "customers",
  "compliance",
  "goals",
  "imports",
  "storefront",
  "accounts",
  "evidence",
  "findings",
  "inbox",
  "runs",
  "traces",
] as const;
export const ROUTERS = [...MODULES.map((m) => `modules/${m}`), "stream", "internal", "platform"] as const;

export async function loadRouters(): Promise<Array<{ name: string; router: Hono<AppEnv> }>> {
  const src = join(import.meta.dirname, "..");
  const out: Array<{ name: string; router: Hono<AppEnv> }> = [];
  for (const name of ROUTERS) {
    const file = join(src, name, "index.ts");
    if (!existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as { router?: Hono<AppEnv> };
    if (!mod.router) throw new Error(`${name}/index.ts must export router: Hono<AppEnv>`);
    out.push({ name, router: mod.router });
  }
  return out;
}
