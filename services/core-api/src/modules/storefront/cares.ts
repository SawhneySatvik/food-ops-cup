// The storefront's Munim Cares section (T-095b; ADR-015 §2.1): the key's own tenant's live donation listings, from the
// same network function with p_tenant = the key's verified tenant. A bad key or a key on a non-storefront channel is
// 404 (gotcha 16, as the menu routes). Rate-limited per client address, then per (client address, key hash); never cached.
//   GET /v1/storefront/cares
import { Hono } from "hono";
import { contextOf, requireCustomer } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { networkListings, storefrontCaresLimit } from "../cares-network/index.ts";
import { channelKind } from "./read.ts";

export const router = new Hono<AppEnv>().get("/v1/storefront/cares", storefrontCaresLimit, requireCustomer, async (c) => {
  const p = c.var.principal;
  if (p.kind !== "customer") throw new ApiError("not_found");
  const items = await withContext(c.var.deps.pools.core, contextOf(p), async (q) => {
    await channelKind(q, p.channel_id);
    return networkListings(q, { tenant: p.tenant_id });
  });
  return c.json({ items }, 200, { "Cache-Control": "no-store" });
});
