// T-005 run-token gates on embedded Postgres. Every refusal is paired with an acceptance of the same token
// (or the same claims) on the other side of the one condition that changes, so no refusal can pass vacuously.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, type TestDb } from "@munim/db";
import type { RunTokenClaims } from "@munim/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../commit/canonical.ts";
import { provisionTenant, svcTx, testKeys, type Tenant } from "../commit/testkit.ts";
import { ensureDevRunTokenKeys, loadRunTokenKeys } from "./keys.ts";
import { endRun, mintRunToken, signJwt, ttlSeconds, verifyRunToken, type RunTokenDeps } from "./index.ts";

let db: TestDb;
let A: Tenant;
let B: Tenant;
let deps: RunTokenDeps;

beforeAll(async () => {
  db = await startTestDb();
  A = await provisionTenant(db);
  B = await provisionTenant(db);
  deps = { ...testKeys(), svc: svcTx(db) };
}, 120_000);
afterAll(async () => db?.stop());

const mintA = (extra: Partial<RunTokenDeps> = {}) =>
  mintRunToken({ ...deps, ...extra }, { tenantId: A.tenant, outletScope: ["*"], trigger: "event", actor: "watcher:events" });

const tamperPayload = (token: string, patch: Partial<RunTokenClaims>) => {
  const [h, p, s] = token.split(".") as [string, string, string];
  const claims = { ...JSON.parse(Buffer.from(p, "base64url").toString()), ...patch };
  return `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
};

describe("run tokens", () => {
  test("valid → accepted; intel.run row recorded with the token's expiry; exp = 2 h (event) / 15 min (ask)", async () => {
    const { token, claims } = await mintA();
    const v = await verifyRunToken(deps, token);
    console.log(`valid token: ${JSON.stringify({ ok: v.ok, trigger: v.ok && v.claims.trigger })}`);
    expect(v).toEqual({ ok: true, claims });
    expect(claims.exp - claims.iat).toBe(7200);
    const row = (await db.admin(`SELECT trigger, actor, ended_at, extract(epoch FROM expires_at)::bigint AS exp FROM intel.run WHERE tenant_id = $1 AND id = $2`,
      [A.tenant, claims.run_id])).rows[0];
    expect(row).toEqual({ trigger: "event", actor: "watcher:events", ended_at: null, exp: String(claims.exp) });
    const ask = await mintRunToken(deps, { tenantId: A.tenant, outletScope: ["*"], trigger: "ask", actor: A.owner });
    expect(ask.claims.exp - ask.claims.iat).toBe(900);
  });

  test("ingest: an ingest run is recorded (the 0024 CHECK admits it) and gets 30 min, not the 2 h fall-through; its token verifies", async () => {
    const { token, claims } = await mintRunToken(deps, { tenantId: A.tenant, outletScope: ["*"], trigger: "ingest", actor: A.owner });
    expect(claims.exp - claims.iat).toBe(1800);
    expect((await db.admin(`SELECT trigger FROM intel.run WHERE tenant_id = $1 AND id = $2`, [A.tenant, claims.run_id])).rows[0]).toEqual({ trigger: "ingest" });
    expect(await verifyRunToken(deps, token)).toEqual({ ok: true, claims });
    const event = await mintA();
    expect(event.claims.exp - event.claims.iat).toBe(7200); // the pair: another trigger keeps its own TTL
  });

  test("brief and auto_step get 2 h, watch_sweep too; ask 15 min and ingest 30 min stay their own (every trigger asserted, hand values)", async () => {
    const hand = { ask: 900, ingest: 1800, event: 7200, watch_sweep: 7200, brief: 7200, auto_step: 7200 } as const;
    for (const [trigger, seconds] of Object.entries(hand)) expect(ttlSeconds(trigger as keyof typeof hand), trigger).toBe(seconds);
    // minted, not just computed: a brief token expires 2 h after it is issued
    const brief = await mintRunToken(deps, { tenantId: A.tenant, outletScope: ["*"], trigger: "brief", actor: "brief" });
    expect(brief.claims.exp - brief.claims.iat).toBe(7200);
    expect(await verifyRunToken(deps, brief.token)).toEqual({ ok: true, claims: brief.claims });
  });

  test("forged → refused: other key, tampered payload, alg swap, garbage; control: the same claims under the real key → accepted", async () => {
    const { token, claims } = await mintA();
    const other = generateKeyPairSync("ed25519");
    const reSigned = await verifyRunToken(deps, signJwt(claims, deps.privateKey));
    const otherKey = await verifyRunToken(deps, signJwt(claims, other.privateKey));
    const tampered = await verifyRunToken(deps, tamperPayload(token, { outlet_scope: ["*"], exp: claims.exp + 3600 }));
    const [, p, s] = token.split(".");
    const algNone = await verifyRunToken(deps, `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.${s}`);
    const garbage = await verifyRunToken(deps, "not.a.token");
    console.log(`forged: real-key ${reSigned.ok}, other-key ${JSON.stringify(otherKey)}, tampered ${JSON.stringify(tampered)}, alg-none ${JSON.stringify(algNone)}, garbage ${JSON.stringify(garbage)}`);
    expect(reSigned.ok).toBe(true);
    expect(otherKey).toEqual({ ok: false, reason: "bad_signature" });
    expect(tampered).toEqual({ ok: false, reason: "bad_signature" });
    expect(algNone).toEqual({ ok: false, reason: "malformed" });
    expect(garbage.ok).toBe(false);
  });

  test("a correctly signed token whose run core never recorded → refused (the row check is live)", async () => {
    const { claims } = await mintA();
    const v = await verifyRunToken(deps, signJwt({ ...claims, run_id: uuidv7() }, deps.privateKey));
    expect(v).toEqual({ ok: false, reason: "unknown_run" });
  });

  test("expired → refused; control: the same token inside its lifetime → accepted", async () => {
    const minted = Date.now() - 3 * 3600_000;
    const { token } = await mintA({ now: () => minted });
    const inside = await verifyRunToken({ ...deps, now: () => minted + 3600_000 }, token);
    const after = await verifyRunToken(deps, token);
    console.log(`expiry: at +1h ${inside.ok}, now (+3h) ${JSON.stringify(after)}`);
    expect(inside.ok).toBe(true);
    expect(after).toEqual({ ok: false, reason: "expired" });
  });

  test("ended run → refused; control: the same token before endRun → accepted", async () => {
    const { token, claims } = await mintA();
    const before = await verifyRunToken(deps, token);
    expect(await endRun(deps, A.tenant, claims.run_id)).toBe(true);
    const after = await verifyRunToken(deps, token);
    console.log(`ended: before ${before.ok}, after ${JSON.stringify(after)}`);
    expect(before.ok).toBe(true);
    expect(after).toEqual({ ok: false, reason: "ended" });
    expect(await endRun(deps, A.tenant, claims.run_id)).toBe(false);
  });

  test("tenant A's run cannot be verified as tenant B, even with a valid signature; control: as A → accepted", async () => {
    const { token, claims } = await mintA();
    const asA = await verifyRunToken(deps, token);
    const asB = await verifyRunToken(deps, signJwt({ ...claims, tenant_id: B.tenant }, deps.privateKey));
    const tamperedToB = await verifyRunToken(deps, tamperPayload(token, { tenant_id: B.tenant }));
    // Under B's RLS context A's run row does not exist.
    const visibleToB = await svcTx(db)({ tenantId: B.tenant, outletScope: ["*"] }, (c) =>
      c.query(`SELECT 1 FROM intel.run WHERE id = $1`, [claims.run_id]));
    console.log(`cross-tenant: as A ${asA.ok}, re-signed as B ${JSON.stringify(asB)}, tampered to B ${JSON.stringify(tamperedToB)}, A's row visible to B: ${visibleToB.rowCount}`);
    expect(asA.ok).toBe(true);
    expect(asB).toEqual({ ok: false, reason: "unknown_run" });
    expect(tamperedToB).toEqual({ ok: false, reason: "bad_signature" });
    expect(visibleToB.rowCount).toBe(0);
  });

  test("only munim_svc records runs: minting through a munim_core transaction → 42501", async () => {
    const coreSvc: RunTokenDeps["svc"] = (scope, fn) =>
      db.withContext("munim_core", { tenant_id: scope.tenantId, outlet_ids: "*", role: "owner", member_id: A.owner }, fn);
    const err = await mintRunToken({ ...deps, svc: coreSvc }, { tenantId: A.tenant, outletScope: ["*"], trigger: "ask", actor: A.owner })
      .catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe("42501");
  });
});

describe("keys", () => {
  test("dev keys are generated once (private file 0600) and load as Ed25519; a non-Ed25519 key is rejected", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "munim-keys-")), "keys");
    const first = ensureDevRunTokenKeys(dir);
    const second = ensureDevRunTokenKeys(dir);
    expect([first.created, second.created]).toEqual([true, false]);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    expect(statSync(join(dir, "run-token-ed25519.pem")).mode & 0o777).toBe(0o600);
    const keys = loadRunTokenKeys(first);
    expect(keys.privateKey.asymmetricKeyType).toBe("ed25519");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => loadRunTokenKeys({
      privateKeyPem: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: ec.publicKey.export({ type: "spki", format: "pem" }).toString(),
    })).toThrow("Ed25519");
  });
});
