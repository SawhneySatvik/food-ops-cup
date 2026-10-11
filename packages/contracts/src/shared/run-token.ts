// Run-token claims (03-architecture §1.7, 04-agent-framework §1). Ed25519-signed JWT minted only by
// core-api; intel holds only the public key and builds its run context from these claims alone — the
// tenant is never a model argument.
import { z } from "zod";
import { OutletScope, Uuid7 } from "./primitives.ts";

export const RunTrigger = z.enum(["event", "watch_sweep", "ask", "brief", "ingest", "auto_step"]);

export const RunTokenClaims = z.strictObject({
  iss: z.literal("munim-core"),
  aud: z.literal("munim-intel"),
  run_id: Uuid7,
  tenant_id: Uuid7,
  outlet_scope: OutletScope,
  trigger: RunTrigger,
  /** "watcher:<pack>" | "brief" | a member id (04-agent-framework §1). */
  actor: z.string().regex(/^(watcher:[a-z_]+|brief|[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/),
  /** Seconds since the epoch. */
  iat: z.int().positive(),
  /** 2 h after iat for event, sweep and brief runs, 15 min for ask runs, 30 min for ingest runs (core `ttlSeconds`). */
  exp: z.int().positive(),
});
export type RunTokenClaims = z.infer<typeof RunTokenClaims>;

/** Compact JWS (header.payload.signature) carrying the claims above. */
export const CompactJwt = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
