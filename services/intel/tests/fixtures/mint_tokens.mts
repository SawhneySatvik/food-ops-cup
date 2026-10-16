// Test fixture (T-041): run tokens signed by core-api's own signer (`signJwt`) over claims parsed by the zod
// contract, with an ephemeral Ed25519 key pair — so intel's Python verifier is proven against core's real token
// format, not against itself. No database, no `.run`, no `.env`. Prints one JSON object on stdout.
//   node services/intel/tests/fixtures/mint_tokens.mts
import { generateKeyPairSync } from "node:crypto";
import { RunTokenClaims } from "../../../../packages/contracts/src/shared/run-token.ts";
import { uuidv7 } from "../../../core-api/src/commit/canonical.ts";
import { signJwt } from "../../../core-api/src/runtoken/index.ts";

const core = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const tenantA = uuidv7();
const tenantB = uuidv7();
const outlet = uuidv7();
const nowS = Math.floor(Date.now() / 1000);
// The tokens are minted once per pytest session. With core's own lifetimes (ask 15 min, ingest 30 min) a slow suite outlived
// them and failed on "expired" (C3). The suite's fixture lives a day; core's lifetimes are pinned in core-api's runtoken.test.ts.
const FIXTURE_TTL_S = 24 * 3600;

function claims(tenant: string, trigger: RunTokenClaims["trigger"], outletScope: string[], iat = nowS, exp = iat + FIXTURE_TTL_S) {
  return RunTokenClaims.parse({
    iss: "munim-core",
    aud: "munim-intel",
    run_id: uuidv7(iat * 1000),
    tenant_id: tenant,
    outlet_scope: outletScope,
    trigger,
    actor: trigger === "ask" || trigger === "ingest" || trigger === "auto_step" ? uuidv7() : trigger === "brief" ? "brief" : "watcher:smoke",
    iat,
    exp,
  });
}

const valid = claims(tenantA, "event", ["*"]);
const ask = claims(tenantA, "ask", [outlet]);
const brief = claims(tenantA, "brief", ["*"]);
const ingest = claims(tenantA, "ingest", [outlet]);
// Auto mode's worker narrates each investigation step under an auto_step run (T-089b).
const autoStep = claims(tenantA, "auto_step", [outlet]);
const expired = claims(tenantA, "event", ["*"], nowS - 3 * 3600, nowS - 3600);
const validToken = signJwt(valid, core.privateKey);
const [h, , s] = validToken.split(".") as [string, string, string];
const toB = Buffer.from(JSON.stringify({ ...valid, tenant_id: tenantB })).toString("base64url");
const algNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

console.log(JSON.stringify({
  public_key_pem: core.publicKey.export({ type: "spki", format: "pem" }).toString(),
  other_public_key_pem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
  tenant_a: tenantA,
  tenant_b: tenantB,
  outlet,
  claims: { valid, ask, brief, ingest, auto_step: autoStep },
  tokens: {
    valid: validToken,
    ask: signJwt(ask, core.privateKey),
    brief: signJwt(brief, core.privateKey),
    ingest: signJwt(ingest, core.privateKey),
    auto_step: signJwt(autoStep, core.privateKey),
    expired: signJwt(expired, core.privateKey),
    other_key: signJwt(valid, other.privateKey),
    tampered_to_b: `${h}.${toB}.${s}`,
    alg_none: `${algNone}.${validToken.split(".")[1]}.${s}`,
    tenant_b: signJwt(claims(tenantB, "event", ["*"]), core.privateKey),
  },
}));
