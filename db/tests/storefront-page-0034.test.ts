// 0034 gates (T-128: the storefront page books; R67 the demo "recorded as sent" campaign command). Expected values are typed by
// hand here from the brief and 0034's header (owner/all-outlet manager save, owner publish, shoppers read published versions only,
// insert-only books); none is read from the migration.
//   P   a version is written only under storefront.page.save.v1 by the owner or a manager over every outlet: a single-outlet
//       manager → MB001, staff → MB001, the owner under another command → MB008; a publish only under storefront.page.publish.v1
//       by the owner (a manager → MB001); neither table takes an UPDATE or DELETE from the app role (42501), and intel reads
//       nothing (42501);
//   R   a shopper (app.role customer) sees both publish rows and the two published versions of three, a guest sees none, and
//       another tenant's member sees nothing of these;
//   A3  customers.campaign.record_sent.v1: owner and judge, tenant scope, core.campaign — the owner moves a queued campaign to
//       sent under it (accepted), a manager is MB001, and sent → queued is refused (MB004).
// Red-proofs: db/tests/redproof-0034.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb, pgError } from "./db.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let w: World;
let other: World;
const SAVE = "storefront.page.save.v1";
const PUBLISH = "storefront.page.publish.v1";
const SENT = "customers.campaign.record_sent.v1";
const pages = [uuidv7(), uuidv7(), uuidv7()];

const as = (role: string, outlets: "*" | string[], type: string): AppContext =>
  ({ ...ownerCtx(w, { command_type: type }), role, outlet_ids: outlets, member_id: role === "owner" ? w.owner : w.staff });
const saveAs = (ctx: AppContext, id: string, version: number) => pgError(() => db.withContext("munim_core", ctx, (c) =>
  c.query(`INSERT INTO core.storefront_page_version (tenant_id, id, version, doc, created_by, origin) VALUES ($1, $2, $3, '{"theme": {}}', $4, '{}')`,
    [w.tenant, id, version, ctx.member_id])));
const publishAs = (ctx: AppContext, page: string) => pgError(() => db.withContext("munim_core", ctx, (c) =>
  c.query(`INSERT INTO core.storefront_page_publish (tenant_id, id, page_id, published_by, origin) VALUES ($1, $2, $3, $4, '{}')`,
    [w.tenant, uuidv7(), page, ctx.member_id])));
const code = (e: { code: string } | null) => e?.code ?? "accepted";

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  other = await buildWorld(db);
});
afterAll(async () => db?.stop());

// The world (src/world.ts addStorefrontPage) already holds version 1, published, in each business: these add 2, 3 and 4.
describe("P who writes the storefront page", () => {
  test("save: owner and all-outlet manager accepted; single-outlet manager and staff MB001; owner under another command MB008", async () => {
    const got = [
      await saveAs(as("owner", "*", SAVE), pages[0]!, 2),
      await saveAs(as("manager", "*", SAVE), pages[1]!, 3),
      await saveAs(as("manager", [w.outlets[0]], SAVE), uuidv7(), 4),
      await saveAs(as("staff", "*", SAVE), uuidv7(), 4),
      await saveAs(as("owner", "*", PUBLISH), uuidv7(), 4),
      await saveAs(as("owner", "*", SAVE), pages[2]!, 4),
    ].map(code);
    console.log(`P save: ${got.join(", ")}`);
    expect(got).toEqual(["accepted", "accepted", "MB001", "MB001", "MB008", "accepted"]);
  });
  test("a version number is taken once per business (23505)", async () => {
    const e = await saveAs(as("owner", "*", SAVE), uuidv7(), 2);
    console.log(`P number: ${code(e)}`);
    expect(code(e)).toBe("23505");
  });
  test("publish: owner accepted (twice: a restore is a new row); manager MB001; owner under the save command MB008", async () => {
    const got = [
      await publishAs(as("owner", "*", PUBLISH), pages[0]!),
      await publishAs(as("owner", "*", PUBLISH), pages[1]!),
      await publishAs(as("manager", "*", PUBLISH), pages[2]!),
      await publishAs(as("owner", "*", SAVE), pages[2]!),
    ].map(code);
    console.log(`P publish: ${got.join(", ")}`);
    expect(got).toEqual(["accepted", "accepted", "MB001", "MB008"]);
  });
  test("insert-only for the app role: UPDATE and DELETE → 42501; intel reads neither table → 42501", async () => {
    const run = (role: "munim_core" | "munim_intel_ro", sql: string) => pgError(() => db.withContext(role, as("owner", "*", SAVE), (c) => c.query(sql)));
    const got = [
      await run("munim_core", `UPDATE core.storefront_page_version SET doc = '{}'`),
      await run("munim_core", `DELETE FROM core.storefront_page_publish`),
      await run("munim_intel_ro", `SELECT count(*) FROM core.storefront_page_version`),
      await run("munim_intel_ro", `SELECT count(*) FROM core.storefront_page_publish`),
    ].map(code);
    console.log(`P grants: ${got.join(", ")}`);
    expect(got).toEqual(["42501", "42501", "42501", "42501"]);
  });
});

describe("R who reads it", () => {
  // Rows of w's business only: another business's context still sees its own world rows.
  const count = (ctx: AppContext, table: string) => db.withContext("munim_core", ctx, async (c) =>
    Number((await c.query(`SELECT count(*) AS n FROM core.${table} WHERE tenant_id = $1`, [w.tenant])).rows[0].n));
  test("a shopper sees the three publish rows and the three published versions of four; a guest sees none", async () => {
    const shopper: AppContext = { tenant_id: w.tenant, outlet_ids: [], role: "customer", customer_id: w.customer };
    const guest: AppContext = { tenant_id: w.tenant, outlet_ids: [], role: "guest", guest_access_hash: "00" };
    const got = [await count(shopper, "storefront_page_publish"), await count(shopper, "storefront_page_version"),
      await count(guest, "storefront_page_publish"), await count(guest, "storefront_page_version")];
    console.log(`R shopper/guest: ${got.join(", ")}`);
    expect(got).toEqual([3, 3, 0, 0]);
  });
  test("the owner sees all four versions; another business's owner sees none of them", async () => {
    const got = [await count(as("owner", "*", SAVE), "storefront_page_version"), await count(ownerCtx(other), "storefront_page_version"),
      await count(ownerCtx(other), "storefront_page_publish")];
    console.log(`R tenants: ${got.join(", ")}`);
    expect(got).toEqual([4, 0, 0]);
  });
});

describe("A3 recording a campaign as sent", () => {
  test("the row: owner and judge, tenant scope, core.campaign; own commands allowed, no caps or outlet column", async () => {
    const r = await db.admin(`SELECT allowed_roles, scope, target_tables, customer_target_tables, draft_only, role_caps, outlet_column, max_amount_minor
                                FROM core.command_authority WHERE command_type = $1`, [SENT]);
    console.log(`A3 row: ${JSON.stringify(r.rows)}`);
    expect(r.rows).toEqual([{ allowed_roles: ["owner", "judge"], scope: "tenant", target_tables: ["core.campaign"], customer_target_tables: [],
      draft_only: false, role_caps: {}, outlet_column: null, max_amount_minor: null }]);
  });
  test("queued → sent by the owner under it is accepted; a manager MB001; sent → queued MB004", async () => {
    const campaign = uuidv7();
    await approveDraft(db, w, "customers.campaign.create.v1", (q) => q(
      `INSERT INTO core.campaign (tenant_id, id, name, channel, outlet_ids, segment_snapshot_id, audience_count, message_key, send_at, origin)
       VALUES ($1, $2, 'Win back', 'sms', '{}', $3, 6, 'campaign.win_back', now(), '{}')`, [w.tenant, campaign, w.snapshot]).then(() => undefined));
    const status = (ctx: AppContext, to: string) => pgError(() => db.withContext("munim_core", ctx, (c) =>
      c.query(`UPDATE core.campaign SET status = $2 WHERE id = $1`, [campaign, to])));
    const got = [await status(as("manager", "*", SENT), "sent"), await status(as("owner", "*", SENT), "sent"), await status(as("owner", "*", SENT), "queued")].map(code);
    console.log(`A3 moves: ${got.join(", ")}`);
    expect(got).toEqual(["MB001", "accepted", "MB004"]);
  });
});
