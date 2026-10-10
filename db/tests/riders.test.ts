// Gates for the 10 Oct riders and pack scope: the two cross-tenant lookups (storefront key → tenant/channel;
// IdP subject → memberships) return only their documented columns and only matching rows; core.outbox.seq is
// gapless per tenant under concurrency; guest_access_hash is a 32-byte hash; the outlet UPI VPA check works
// (0003 bug); payroll and licence kinds follow the country pack; a campaign exists only through an approved
// draft. Refusals paired with accepted cases; red-proofs on clones.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setContext, type TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { approveDraft, buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db, { country: "AU" });
});
afterAll(async () => db?.stop());

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("cross-tenant lookups (definer functions owned by munim_crosstenant, EXECUTE munim_core)", () => {
  test("tenant_for_storefront_key: a live key → (tenant_id, channel_id) only; revoked or unknown → 0 rows; svc/intel → 42501", async () => {
    const key = `sk_${randomUUID()}`;
    const id = randomUUID();
    await db.withContext("munim_core", ownerCtx(A), (c) =>
      c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [A.tenant, id, A.channel, sha(key)]));
    const c = await db.connect("munim_core");
    try {
      const r = await c.query("SELECT * FROM core.tenant_for_storefront_key($1)", [sha(key)]);
      console.log("storefront key lookup:", r.rows, r.fields.map((f) => f.name));
      expect(r.fields.map((f) => f.name)).toEqual(["tenant_id", "channel_id"]);
      expect(r.rows).toEqual([{ tenant_id: A.tenant, channel_id: A.channel }]);
      expect((await c.query("SELECT * FROM core.tenant_for_storefront_key($1)", [sha("wrong")])).rowCount).toBe(0);
    } finally {
      await c.end();
    }
    await db.withContext("munim_core", ownerCtx(A), (t) => t.query("UPDATE core.storefront_key SET revoked_at = now() WHERE tenant_id = $1 AND id = $2", [A.tenant, id]));
    const after = await db.withContext("munim_core", {}, (t) => t.query("SELECT * FROM core.tenant_for_storefront_key($1)", [sha(key)]));
    expect(after.rowCount).toBe(0);
    for (const role of ["munim_svc", "munim_intel_ro"] as const) {
      expect((await attempt(db, role, {}, "SELECT * FROM core.tenant_for_storefront_key($1)", [sha(key)]))?.code).toBe("42501");
    }
  });

  test("memberships_for_sub: the subject's active memberships in two tenants (tenant_id, tenant_name, role); unknown → 0", async () => {
    const sub = `sub-${randomUUID()}`;
    for (const w of [A, B]) {
      await db.withContext("munim_core", ownerCtx(w, { command_type: "tenancy.member.invite.v1" }), async (c) => {
        const m = randomUUID();
        await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Shared', 'shared@example.test')`, [w.tenant, m, sub]);
        await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, $3)`, [w.tenant, m, w === A ? "manager" : "advisor"]);
      });
    }
    const c = await db.connect("munim_core");
    try {
      const r = await c.query("SELECT * FROM core.memberships_for_sub($1)", [sub]);
      console.log("memberships_for_sub:", r.rows.length, "rows,", r.fields.map((f) => f.name).join(","));
      expect(r.fields.map((f) => f.name)).toEqual(["tenant_id", "tenant_name", "role"]);
      expect(new Set(r.rows.map((x) => `${x.tenant_id}:${x.role}`))).toEqual(new Set([`${A.tenant}:manager`, `${B.tenant}:advisor`]));
      expect((await c.query("SELECT * FROM core.memberships_for_sub($1)", [`sub-${randomUUID()}`])).rowCount).toBe(0);
    } finally {
      await c.end();
    }
    expect((await attempt(db, "munim_svc", {}, "SELECT * FROM core.memberships_for_sub('x')"))?.code).toBe("42501");
  });
});

describe("core.outbox.seq (T-006)", () => {
  async function burst(x: TestDb, n: number): Promise<{ ok: number; codes: string[] }> {
    const pool = x.pool("munim_core", n + 5);
    let ok = 0;
    const codes: string[] = [];
    try {
      await Promise.all([...Array(n).keys()].map(async () => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await setContext(c, { tenant_id: A.tenant, outlet_ids: "*" });
          await c.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload, seq)
                         VALUES ($1, gen_random_uuid(), 'x', 'x', 'munim.test.thing.happened.v1', '{}', 999999)`, [A.tenant]);
          await c.query("COMMIT");
          ok++;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          codes.push((e as { code: string }).code);
        } finally {
          c.release();
        }
      }));
    } finally {
      await pool.end();
    }
    return { ok, codes };
  }
  const seqs = async (x: TestDb) => (await x.admin("SELECT seq::int FROM core.outbox WHERE tenant_id = $1 ORDER BY seq", [A.tenant])).rows.map((r) => r.seq as number);

  test("30 concurrent outbox inserts → all accepted, per-tenant seq exactly 1..N (caller-supplied seq overwritten)", async () => {
    const r = await burst(db, 30);
    const s = await seqs(db);
    console.log(`outbox seq: ${r.ok} committed, seq ${s[0]}..${s.at(-1)} over ${s.length} rows`);
    expect(r.ok).toBe(30);
    expect(s).toEqual(Array.from({ length: s.length }, (_, i) => i + 1));
  });

  test("RED-PROOF: seq from max+1 without the tenant lock → concurrent inserts collide", async () => {
    const x = await db.clone();
    try {
      await x.admin(`CREATE OR REPLACE FUNCTION core.outbox_seq() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
        BEGIN SELECT coalesce(max(o.seq), 0) + 1 INTO NEW.seq FROM core.outbox o WHERE o.tenant_id = NEW.tenant_id; PERFORM pg_sleep(0.1); RETURN NEW; END $f$`);
      const r = await burst(x, 30);
      console.log(`RED-PROOF outbox seq: ${r.ok} committed, ${r.codes.length} failed (${[...new Set(r.codes)].join(",")})`);
      expect(r.ok).toBeLessThan(30);
    } finally {
      await x.stop();
    }
  });
});

describe("rider constraints", () => {
  const place = (hash: Buffer) => attempt(db, "munim_core", ownerCtx(A, { command_type: "orders.place.v1" }),
    `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, guest_access_hash)
     VALUES ($1, gen_random_uuid(), $2, $3, 'pickup', 100, 100, 'INR', '{}', $4)`, [A.tenant, A.outlets[0], A.channel, hash]);

  test("guest_access_hash: 31 bytes → 23514; a sha256 (32 bytes) → accepted", async () => {
    expect((await place(Buffer.alloc(31)))?.code).toBe("23514");
    expect(await place(createHash("sha256").update(randomUUID()).digest())).toBeNull();
  });

  const vpa = (x: TestDb, v: string) => attempt(x, "munim_core", ownerCtx(A, { command_type: "tenancy.outlet.update.v1" }),
    "UPDATE core.outlet SET upi_vpa = $2 WHERE tenant_id = $1 AND id = $3", [A.tenant, v, A.outlets[1]]);

  test("outlet UPI VPA: 'no-at-sign' → 23514; 'shop.two@okbank' → accepted (0003's {2,256} raised 2201B on every value)", async () => {
    expect((await vpa(db, "no-at-sign"))?.code).toBe("23514");
    expect(await vpa(db, "shop.two@okbank")).toBeNull();
  });

  test("RED-PROOF: the 0003 check text re-installed → a valid VPA raises 2201B", async () => {
    const x = await db.clone();
    try {
      await x.admin(`ALTER TABLE core.outlet DROP CONSTRAINT outlet_upi_vpa_check;
        ALTER TABLE core.outlet ADD CONSTRAINT outlet_upi_vpa_check CHECK (upi_vpa ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$') NOT VALID`);
      const e = await vpa(x, "shop.two@okbank");
      console.log("RED-PROOF VPA check:", e?.code);
      expect(e?.code).toBe("2201B");
    } finally {
      await x.stop();
    }
  });
});

describe("country-pack scope (R21; project rule 7)", () => {
  const payroll = (x: TestDb, w: World, month: string) => attempt(x, "munim_core", ownerCtx(w, { command_type: "people.payroll_draft.create.v1" }),
    `INSERT INTO core.payroll_draft (tenant_id, id, outlet_id, period_month, currency) VALUES ($1, gen_random_uuid(), $2, $3, $4)`,
    [w.tenant, w.outlets[0], month, w.currency]);
  const licence = (w: World, kind: string) => attempt(db, "munim_core", ownerCtx(w, { command_type: "compliance.licence.upsert.v1" }),
    `INSERT INTO core.licence (tenant_id, id, kind, number, valid_from) VALUES ($1, gen_random_uuid(), $2, 'N-1', '2026-01-01')`, [w.tenant, kind]);

  test("payroll draft: AU (roster_only) → MB013; IN (drafts) → accepted", async () => {
    const au = await payroll(db, B, "2026-10-01");
    console.log(`pack scope: AU payroll → ${au?.code} (${au?.message})`);
    expect(au?.code).toBe("MB013");
    expect(await payroll(db, A, "2026-10-01")).toBeNull();
  });

  test("licence kind: 'gst' for AU → MB013; 'abn' for AU and 'gst' for IN → accepted", async () => {
    expect((await licence(B, "gst"))?.code).toBe("MB013");
    expect(await licence(B, "abn")).toBeNull();
    expect(await licence(A, "gst")).toBeNull();
  });

  test("RED-PROOF: drop the payroll pack_scope trigger → an AU payroll draft is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER pack_scope ON core.payroll_draft");
      const e = await payroll(x, B, "2026-11-01");
      console.log("RED-PROOF payroll pack scope:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("campaigns exist only through an approved draft (R15, R16)", () => {
  const campaignSql = `INSERT INTO core.campaign (tenant_id, id, name, channel, segment_snapshot_id, audience_count, message_key, send_at)
                       VALUES ($1, gen_random_uuid(), 'Direct', 'sms', $2, 0, 'campaign.direct', now())`;

  test("the owner's own command → MB001; the same insert inside an approved draft → accepted", async () => {
    const direct = await attempt(db, "munim_core", ownerCtx(A, { command_type: "customers.campaign.create.v1" }), campaignSql, [A.tenant, A.snapshot]);
    const approved = await approveDraft(db, A, "customers.campaign.create.v1", async (q) => { await q(campaignSql, [A.tenant, A.snapshot]); })
      .then(() => null, (e: { code: string }) => e);
    console.log(`campaign: direct command → ${direct?.code}; approved draft → ${approved ? approved.code : "accepted"}`);
    expect(direct?.code).toBe("MB001");
    expect(approved).toBeNull();
  });

  test("RED-PROOF: both layers off (drop campaign_from_decision AND clear draft_only, 0015) → the direct command creates a campaign (dropping the trigger alone still refuses)", async () => {
    const x = await db.clone();
    try {
      const direct = () => attempt(x, "munim_core", ownerCtx(A, { command_type: "customers.campaign.create.v1" }), campaignSql, [A.tenant, A.snapshot]);
      await x.admin("DROP TRIGGER campaign_from_decision ON core.campaign");
      expect((await direct())?.code).toBe("MB001"); // the guard's draft-only rule
      await x.admin("UPDATE core.command_authority SET draft_only = false WHERE command_type = 'customers.campaign.create.v1'");
      const e = await direct();
      console.log("RED-PROOF campaign:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("canonical world ids", () => {
  test("buildWorld ids are UUIDv7 (contracts UUID7_PATTERN); a v4 id does not match", async () => {
    // Copied by hand from packages/contracts/src/shared/primitives.ts UUID7_PATTERN (db does not import contracts).
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = [A.tenant, A.owner, A.outlets[0], A.item, A.run, A.finding];
    expect(ids.filter((id) => !re.test(id))).toEqual([]);
    expect(re.test(randomUUID())).toBe(false);
  });
});
