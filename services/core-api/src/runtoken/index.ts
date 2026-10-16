// Run tokens (03-architecture §1.7, project rule 15): core-api mints an Ed25519-signed JWT (EdDSA) and
// records the run in intel.run in the same transaction; intel holds only the public key. Verification is
// signature + claims schema + not expired + the intel.run row exists for the token's tenant with
// ended_at null. Tenant and outlet scope come from the verified token alone. Every refusal looks the same to
// the caller (gotcha 16); the token is never logged.
import { type KeyObject, sign as edSign, verify as edVerify } from "node:crypto";
import type pg from "pg";
import { RunTokenClaims } from "@munim/contracts";
import { uuidv7 } from "../commit/canonical.ts";

export type Queryable = Pick<pg.ClientBase, "query">;
export type OutletScope = ["*"] | string[];
export type RunTrigger = RunTokenClaims["trigger"];
/** One transaction on the munim_svc pool under SET LOCAL app.tenant_id / app.outlet_ids for `scope`
 *  (T-004's withContext). munim_svc is the only role with INSERT on intel.run. */
export type SvcTx = <T>(scope: { tenantId: string; outletScope: OutletScope }, fn: (c: Queryable) => Promise<T>) => Promise<T>;

export interface RunTokenKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}
export interface RunTokenDeps extends RunTokenKeys {
  svc: SvcTx;
  /** Unix ms; injectable so expiry is tested without sleeping. */
  now?: () => number;
}
export interface MintInput {
  tenantId: string;
  outletScope: OutletScope;
  trigger: RunTrigger;
  /** "watcher:<pack>" | "brief" | a member id (04-agent-framework §1). */
  actor: string;
  /** auto_step only (0020 run_grant_iff_auto_step): the standing grant the run acts under. Not a token claim. */
  grantId?: string;
}
export type VerifyResult =
  | { ok: true; claims: RunTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "bad_claims" | "expired" | "unknown_run" | "ended" };

/** `ask` is the interactive run (15 min). `ingest` is a member's document upload read by the extractor, whose model calls
 *  run longer than an answer but not for hours (30 min: no ADR states a value; the founder may change it). Event,
 *  watch_sweep, brief and auto_step runs get 2 h (covers redelivery). Explicit per trigger, so a new trigger is a
 *  compile error rather than a silent 2 h. */
export function ttlSeconds(trigger: RunTrigger): number {
  switch (trigger) {
    case "ask": return 15 * 60;
    case "ingest": return 30 * 60;
    case "event": case "watch_sweep": case "brief": case "auto_step": return 2 * 60 * 60;
  }
}

const HEADER = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");

export function signJwt(claims: RunTokenClaims, privateKey: KeyObject): string {
  const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${edSign(null, Buffer.from(body), privateKey).toString("base64url")}`;
}

/** Strict base64url: decoding must round-trip, so no alternative encodings of the same bytes pass. */
function b64u(segment: string): Buffer | null {
  const b = Buffer.from(segment, "base64url");
  return b.toString("base64url") === segment ? b : null;
}

function decodeVerified(token: string, publicKey: KeyObject): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = b64u(h);
  const payload = b64u(p);
  const sig = b64u(s);
  if (!header || !payload || !sig) return { ok: false, reason: "malformed" };
  let alg: unknown;
  let claims: unknown;
  try {
    alg = (JSON.parse(header.toString("utf8")) as { alg?: unknown }).alg;
    claims = JSON.parse(payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (alg !== "EdDSA") return { ok: false, reason: "malformed" };
  if (!edVerify(null, Buffer.from(`${h}.${p}`), publicKey, sig)) return { ok: false, reason: "bad_signature" };
  const parsed = RunTokenClaims.safeParse(claims);
  return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, reason: "bad_claims" };
}

/** Inserts the intel.run row on `c` (a munim_svc transaction scoped to input.tenantId) and signs the token. */
export async function mintRunTokenIn(c: Queryable, deps: RunTokenKeys & { now?: () => number }, input: MintInput) {
  const iat = Math.floor((deps.now ?? Date.now)() / 1000);
  const claims = RunTokenClaims.parse({
    iss: "munim-core",
    aud: "munim-intel",
    run_id: uuidv7(iat * 1000),
    tenant_id: input.tenantId,
    outlet_scope: input.outletScope,
    trigger: input.trigger,
    actor: input.actor,
    iat,
    exp: iat + ttlSeconds(input.trigger),
  });
  await c.query(
    `INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, issued_at, expires_at, grant_id)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8)`,
    [claims.tenant_id, claims.run_id, claims.trigger, claims.actor, claims.outlet_scope, claims.iat, claims.exp, input.grantId ?? null],
  );
  return { token: signJwt(claims, deps.privateKey), claims };
}

export async function mintRunToken(deps: RunTokenDeps, input: MintInput) {
  return deps.svc({ tenantId: input.tenantId, outletScope: input.outletScope }, (c) => mintRunTokenIn(c, deps, input));
}

/** `endedGraceS`: a run core ended less than this many seconds ago (by the database clock that stamped `ended_at`) still
 *  verifies — for the routes that take a run's late spend and traces only (internal/auth.ts); unset = ended is refused. */
export async function verifyRunToken(deps: RunTokenDeps, token: string, o: { endedGraceS?: number } = {}): Promise<VerifyResult> {
  const decoded = decodeVerified(token, deps.publicKey);
  if (!decoded.ok) return decoded;
  const { claims } = decoded;
  const nowS = (deps.now ?? Date.now)() / 1000;
  if (claims.exp <= nowS) return { ok: false, reason: "expired" };
  // RLS context is the token's own tenant, so a row of any other tenant is invisible here.
  const row = await deps.svc({ tenantId: claims.tenant_id, outletScope: claims.outlet_scope }, async (c) => {
    const r = await c.query<{ trigger: string; actor: string; outlet_scope: string[]; expires_s: number; ended: boolean; ended_s: number | null }>(
      `SELECT trigger, actor, outlet_scope, extract(epoch FROM expires_at)::float8 AS expires_s, ended_at IS NOT NULL AS ended,
              extract(epoch FROM now() - ended_at)::float8 AS ended_s
         FROM intel.run WHERE tenant_id = $1 AND id = $2`,
      [claims.tenant_id, claims.run_id],
    );
    return r.rows[0];
  });
  if (!row || row.trigger !== claims.trigger || row.actor !== claims.actor
      || row.outlet_scope.join(",") !== claims.outlet_scope.join(",") || row.expires_s !== claims.exp) {
    return { ok: false, reason: "unknown_run" };
  }
  if (row.ended && !(o.endedGraceS !== undefined && row.ended_s !== null && row.ended_s <= o.endedGraceS)) return { ok: false, reason: "ended" };
  return { ok: true, claims };
}

/** Ends a run; later verifications of its token are refused. Returns false if it was already ended. */
export async function endRun(deps: Pick<RunTokenDeps, "svc">, tenantId: string, runId: string): Promise<boolean> {
  const r = await deps.svc({ tenantId, outletScope: ["*"] }, (c) =>
    c.query(`UPDATE intel.run SET ended_at = now() WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`, [tenantId, runId]));
  return r.rowCount === 1;
}

export { loadRunTokenKeys } from "./keys.ts";
