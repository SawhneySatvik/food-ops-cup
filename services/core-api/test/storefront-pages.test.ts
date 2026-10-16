// T-128 storefront page (R66; contracts storefront/page.ts; 0034) through the real app. Expected values are typed by hand from the
// brief and design-system §9 (owner and all-outlet managers save; only the owner publishes; versions are numbered and never
// rewritten; a shopper sees the live version only; a theme under 4.5:1 is refused), never read from the code under test.
// The world (@munim/db buildWorld, 0034) already holds version 1, published ("Fresh every morning."), in every business.
//   S1 save: the owner's save on version 1 is version 2; another save on a stale base → 409 page_version_stale; on the newest →
//      version 3; a single-outlet manager → 403 (the guard: tenant scope); a low-contrast theme → 422 theme_contrast; the
//      outlets section hidden → 422; the same envelope again replays (X-Munim-Replayed) and adds no version.
//   S2 publish: the shopper reads the world's version 1; a manager → 403; the owner → live, the shopper reads that version's
//      document; the live one again → 409; a newer one, then the older (a restore) → the shopper follows each; a path/payload
//      mismatch → 422; every save and publish is on the audit log under the person.
//   S3 isolation: another business's owner gets 404 for this page and lists only its own version; its storefront key reads its
//      own version 1.
//   S4 demo (R64 X-2, R67 W-3): on an onboarded demo business the owner still saves a version, but publishing is refused
//      403 forbidden demo_protected, nothing written, and the shopper still reads the world's version 1.
//   S5 the write path: a publish envelope sent twice replays (X-Munim-Replayed, the same body) and adds no publish row; the
//      audit chain of every business here verifies after all of the above.
//   S6 the built-in look (a world without the page): nothing published → `page: null`, and saving a version does not change that;
//      a published document that no longer parses → `page: null` too.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { StorefrontPagePublic, StorefrontPagesResponse, StorefrontPageView } from "@munim/contracts/storefront";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, STOREFRONT_KEY_HEADER, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { openDb } from "./db.ts";
import { verifyAuditChain } from "../src/commit/index.ts";
import { svcTx } from "../src/commit/testkit.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let W: Tenant;
let X: Tenant;
let D: Tenant;
let N: Tenant;
const keys: Record<string, string> = {};

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const env = (type: string, payload: unknown) => ({ command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type, payload });
const call = async (t: Tenant, sub: string, method: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, { method, headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })) as Res;
const shopper = async (t: Tenant) => StorefrontPagePublic.parse(await ((await app.request("/v1/storefront/page", { headers: { [STOREFRONT_KEY_HEADER]: keys[t.tenant]! } })) as Res).json());
const reason = async (r: Res) => { const b = await r.json(); return `${r.status} ${b.error?.reason_code ?? b.error?.code}`; };

const doc = (tagline: string, primary = "#7b3f1d") => ({
  theme: { primary, secondary: "#9e2f4e", accent: "#f6d9c8", radius: "round", layout: "hero-banner" },
  sections: [
    { kind: "hero", visible: true, badge: "Lucknow · two bakehouses · pickup only", tagline },
    { kind: "outlets", visible: true, title: "Pick your bakehouse" },
    { kind: "ribbon", visible: true },
    { kind: "cards", visible: true, cards: [{ title: "Build a gift box", body: "Pick a box and flavours." }, { title: "Cakes with a message", body: "Classic or eggless." }] },
  ],
});
const save = (t: Tenant, sub: string, page: string, based: number | null, d: unknown = doc("Baked at dawn.")) =>
  call(t, sub, "POST", "/v1/storefront-pages", env("storefront.page.save.v1", { page_id: page, based_on_version: based, doc: d }));
const publish = (t: Tenant, sub: string, page: string, pathPage = page) =>
  call(t, sub, "POST", `/v1/storefront-pages/${pathPage}:publish`, env("storefront.page.publish.v1", { publish_id: uuidv7(), page_id: page }));

const pages = { v1: uuidv7(), v2: uuidv7() };

beforeAll(async () => {
  db = await openDb();
  W = await buildTenant(db, "T128a");
  X = await buildTenant(db, "T128b");
  D = await buildTenant(db, "T128d");
  N = await buildTenant(db, "T128n");
  // A pickup-channel storefront key per business (buildTenant's key sits on the world's counter channel).
  for (const t of [W, X, D, N]) {
    const channel = uuidv7();
    keys[t.tenant] = `sfk_T128_${uuidv7().replaceAll("-", "")}${uuidv7().replaceAll("-", "")}`;
    await db.withContext("munim_core", ownerCtx(t, { command_type: "tenancy.channel.create.v1" }), (c) =>
      c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [t.tenant, channel]));
    await db.withContext("munim_core", ownerCtx(t), (c) =>
      c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`,
        [t.tenant, uuidv7(), channel, createHash("sha256").update(keys[t.tenant]!).digest("hex")]));
  }
  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) });
});
afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("S1 save", () => {
  it("version 2, a stale base 409, version 3, a single-outlet manager 403, low contrast 422, outlets hidden 422, a replay adds nothing", async () => {
    const got: string[] = [];
    const first = env("storefront.page.save.v1", { page_id: pages.v1, based_on_version: 1, doc: doc("Baked at dawn.") });
    const r1 = await call(W, W.ownerSub, "POST", "/v1/storefront-pages", first);
    got.push(`${r1.status}`);
    got.push(await reason(await save(W, W.ownerSub, uuidv7(), 1)));
    got.push(`${(await save(W, W.ownerSub, pages.v2, 2, doc("Warm from the oven."))).status}`);
    got.push(await reason(await save(W, W.managerSub, uuidv7(), 3)));
    got.push(await reason(await save(W, W.ownerSub, uuidv7(), 3, doc("Pale", "#f0b429"))));
    const hidden = doc("Hidden");
    (hidden.sections[1] as { visible: boolean }).visible = false;
    got.push(await reason(await save(W, W.ownerSub, uuidv7(), 3, hidden)));
    const again = await call(W, W.ownerSub, "POST", "/v1/storefront-pages", first);
    got.push(`${again.status} replayed=${again.headers.get("X-Munim-Replayed")}`);
    console.log(`S1: ${got.join(" | ")}`);
    expect(got).toEqual(["201", "409 page_version_stale", "201", "403 authority_denied", "422 theme_contrast", "422 invalid_payload", "201 replayed=true"]);
    const list = StorefrontPagesResponse.parse(await (await call(W, W.ownerSub, "GET", "/v1/storefront-pages")).json());
    expect(list.versions.map((v) => [v.version, v.page_id]).slice(0, 2)).toEqual([[3, pages.v2], [2, pages.v1]]);
    expect(list.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(list.live?.version).toBe(1);
    const one = StorefrontPageView.parse(await (await call(W, W.managerSub, "GET", `/v1/storefront-pages/${pages.v1}`)).json());
    expect(one).toMatchObject({ page_id: pages.v1, version: 2, created_by: W.owner, doc: doc("Baked at dawn.") });
  });
});

describe("S2 publish", () => {
  it("the world's v1 before; manager 403; owner → live; again 409; newer then older (restore) followed by the shopper; mismatch 422; audited", async () => {
    const tagline = (p: Awaited<ReturnType<typeof shopper>>["page"]) => (p?.doc.sections.find((x) => x.kind === "hero") as { tagline: string } | undefined)?.tagline;
    const before = (await shopper(W)).page;
    expect([before?.version, tagline(before)]).toEqual([1, "Fresh every morning."]);
    const got: string[] = [];
    got.push(await reason(await publish(W, W.managerSub, pages.v1)));
    got.push(`${(await publish(W, W.ownerSub, pages.v1)).status}`);
    const live1 = (await shopper(W)).page;
    got.push(`v${live1?.version} ${tagline(live1)}`);
    got.push(await reason(await publish(W, W.ownerSub, pages.v1)));
    got.push(`${(await publish(W, W.ownerSub, pages.v2)).status} v${(await shopper(W)).page?.version}`);
    got.push(`${(await publish(W, W.ownerSub, pages.v1)).status} v${(await shopper(W)).page?.version}`);
    got.push(await reason(await publish(W, W.ownerSub, pages.v2, pages.v1)));
    console.log(`S2: ${got.join(" | ")}`);
    expect(got).toEqual(["403 authority_denied", "200", "v2 Baked at dawn.", "409 illegal_transition", "200 v3", "200 v2", "422 invalid_payload"]);
    const live = StorefrontPagesResponse.parse(await (await call(W, W.ownerSub, "GET", "/v1/storefront-pages")).json()).live;
    expect(live).toMatchObject({ page_id: pages.v1, version: 2, published_by: W.owner });
    const audit = (await db.admin(`SELECT entity, count(*)::int AS n, bool_and(actor ->> 'id' = $2) AS by_owner FROM core.audit_log
                                    WHERE tenant_id = $1 AND entity LIKE 'core.storefront_page_%' GROUP BY entity ORDER BY entity`, [W.tenant, W.owner])).rows;
    expect(audit).toEqual([{ entity: "core.storefront_page_publish", n: 3, by_owner: true }, { entity: "core.storefront_page_version", n: 2, by_owner: true }]);
  });
});

describe("S3 isolation", () => {
  it("another business sees none of it, and its storefront reads its own version 1", async () => {
    expect((await call(X, X.ownerSub, "GET", `/v1/storefront-pages/${pages.v1}`)).status).toBe(404);
    const list = StorefrontPagesResponse.parse(await (await call(X, X.ownerSub, "GET", "/v1/storefront-pages")).json());
    expect([list.versions.map((v) => v.version), list.live?.version, list.versions.some((v) => v.page_id === pages.v1 || v.page_id === pages.v2)]).toEqual([[1], 1, false]);
    const theirs = (await shopper(X)).page;
    expect([theirs?.version, (theirs?.doc.sections.find((x) => x.kind === "hero") as { tagline: string } | undefined)?.tagline]).toEqual([1, "Fresh every morning."]);
    expect((await shopper(W)).page?.version).toBe(2);
  });
});

describe("S4 demo", () => {
  it("an onboarded demo business saves a version but refuses publishing it: 403 demo_protected, nothing written, the shop unchanged", async () => {
    // is_demo and onboarded_at are the operator's and the seed's; the fixture sets them as plumbing (as security-c2.test.ts).
    await db.admin(`SET session_replication_role = replica;
                    UPDATE core.tenant SET is_demo = true, onboarded_at = now() WHERE tenant_id = '${D.tenant}';
                    RESET session_replication_role`);
    const page = uuidv7();
    const saved = await save(D, D.ownerSub, page, 1, doc("Demo draft."));
    const publishes = async () => Number((await db.admin(`SELECT count(*) n FROM core.storefront_page_publish WHERE tenant_id = $1`, [D.tenant])).rows[0]!.n);
    const before = await publishes();
    const refused = await publish(D, D.ownerSub, page);
    const body = await refused.json();
    console.log(`S4: save ${saved.status}, publish ${refused.status} ${body.error?.code} ${body.error?.reason_code}`);
    expect([saved.status, refused.status, body.error?.code, body.error?.reason_code]).toEqual([201, 403, "forbidden", "demo_protected"]);
    expect([await publishes(), (await shopper(D)).page?.version]).toEqual([before, 1]);
  });
});

describe("S5 write path", () => {
  it("a publish replays without a second row; every business's audit chain verifies", async () => {
    const page = uuidv7();
    expect((await save(X, X.ownerSub, page, 1, doc("Replayed."))).status).toBe(201);
    const once = env("storefront.page.publish.v1", { publish_id: uuidv7(), page_id: page });
    const rows = async () => Number((await db.admin(`SELECT count(*) n FROM core.storefront_page_publish WHERE tenant_id = $1`, [X.tenant])).rows[0]!.n);
    const first = await call(X, X.ownerSub, "POST", `/v1/storefront-pages/${page}:publish`, once);
    const [body, n] = [await first.text(), await rows()];
    const again = await call(X, X.ownerSub, "POST", `/v1/storefront-pages/${page}:publish`, once);
    expect([first.status, again.status, again.headers.get("X-Munim-Replayed"), (await again.text()) === body, await rows()]).toEqual([200, 200, "true", true, n]);
    for (const t of [W, X, D]) {
      const v = await verifyAuditChain(svcTx(db), t.tenant);
      expect([v.ok, v.firstBadSeq, v.rows > 0]).toEqual([true, null, true]);
    }
  });
});

describe("S6 the built-in look", () => {
  it("a business with nothing published reads page null, a saved version does not change that, and a published document that no longer parses reads null", async () => {
    // buildWorld publishes version 1 in every business, so N starts without it: the fixture removes the world's two page tables' rows
    // (the owner has no DELETE grant; the superuser plumbing does, and the book guard fires on INSERT and UPDATE only).
    await db.admin(`DELETE FROM core.storefront_page_publish WHERE tenant_id = $1`, [N.tenant]);
    await db.admin(`DELETE FROM core.storefront_page_version WHERE tenant_id = $1`, [N.tenant]);
    const got: unknown[] = [(await shopper(N)).page];
    const saved = uuidv7();
    got.push((await save(N, N.ownerSub, saved, null, doc("Saved, not published."))).status, (await shopper(N)).page);
    // A document the contract no longer accepts (e.g. written by an older build) is shown as the built-in look, not as an error.
    const broken = uuidv7();
    await db.withContext("munim_core", ownerCtx(N, { command_type: "storefront.page.save.v1" }), (c) =>
      c.query(`INSERT INTO core.storefront_page_version (tenant_id, id, version, doc, created_by, origin) VALUES ($1, $2, 2, '{"theme": 1}', $3, '{}')`, [N.tenant, broken, N.owner]));
    await db.withContext("munim_core", ownerCtx(N, { command_type: "storefront.page.publish.v1" }), (c) =>
      c.query(`INSERT INTO core.storefront_page_publish (tenant_id, id, page_id, published_by, origin) VALUES ($1, $2, $3, $4, '{}')`, [N.tenant, uuidv7(), broken, N.owner]));
    got.push((await shopper(N)).page);
    expect(got).toEqual([null, 201, null, null]);
    // The same storefront call answers a real page for a business that published one (control: the null is the data, not the route).
    expect((await shopper(W)).page?.version).toBe(2);
  });
});
