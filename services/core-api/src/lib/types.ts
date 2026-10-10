// What every route sees: the injected dependencies and, after an auth middleware, the resolved principal.
import type { Config, Logger } from "@munim/config";
import type { IdP } from "../auth/port.ts";
import type { Principal, StorefrontResolver } from "../auth/resolve.ts";
import type { PublishDeps } from "../commit/index.ts";
import type { BlobStore } from "../modules/imports/blob.ts";
import type { Pools } from "./db.ts";

export interface Deps {
  pools: Pools;
  idp: IdP;
  /** Storefront key → (tenant, channel). Production: storefrontResolver(pools.core) from auth/resolve.ts. */
  storefronts: StorefrontResolver;
  /** Post-commit publishing (publisher + munim_svc tx + run-token keys) for routes that run executeCommand.
   *  Optional so a composition without intel (gates, tools) still builds; a route that needs it refuses
   *  with `unavailable` when unset. */
  publish?: PublishDeps;
  /** Uploaded documents' bytes (the Blob port). The worker's import parse job must be handed the same store.
   *  Optional so compositions without imports still build; the import routes refuse `unavailable` when unset. */
  blobs?: BlobStore;
  config: Pick<Config, "nodeEnv" | "redact">;
  log: Logger;
}

export type AppEnv = { Variables: { deps: Deps; principal: Principal } };
