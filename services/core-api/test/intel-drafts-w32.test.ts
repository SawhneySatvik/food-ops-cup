// W3.2 review fix cycle 1 gates on POST /internal/intel/v1/drafts, through the real app (run token + service secret →
// munim_svc under the token's RLS). Embedded Postgres, no model. Synthetic data only. Each refusal is paired with an accept.
//   (R-A 4) invoice_no is an identifier only in its own shape (^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$, no spaces): 'INV-1042'
//           and 'INV/2026-27/0042' → proposed; 'INV 1042', 'two hundred', a 41-character value → abstained number_grammar, 0 rows.
//   (R-B S1-B, S1-D) customers.campaign.create.v1 and catalogue.coupon.set.v1 are no specialist's draftable (orchestrator
//           ruling 11 Oct: an approved campaign must never reach customers outside the finding, and coupon.set waits for pack
//           §6's executable tightening) → 422 from intel:customers and intel:catalogue, 0 rows; a registered draftable → proposed.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { DraftsResponse } from "@munim/contracts/internal";
import { type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const keys = testKeys();
const SECRET = "w32-drafts-test-service-secret-not-real-0123456789";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let all = "";

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const intel = async (token: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
  })) as Res;
const drafts = async () => Number((await db.admin(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [A.tenant])).rows[0]!.n);

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  all = (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: A.tenant, outletScope: ["*"], trigger: "event", actor: "watcher:customers" })).token;
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

// Ingestion's supplier-invoice workflow draft (as intel-batches gate 8): every number is a span of the stored page.
const PAGE = "Steady Dairy (simulated supplier)\nTax invoice INV-1042\nPaneer 12 kg 340.00 204.00\n";
const span = (doc: string, text: string) => { const i = PAGE.indexOf(text); return `⟨cite:doc:${doc}·${i}-${i + text.length}⟩`; };
async function invoiceDraft(invoice_no: string) {
  const doc = uuidv7();
  await db.admin(`INSERT INTO core.document (tenant_id, id, kind, media_type, byte_size, sha256, storage_ref) VALUES ($1, $2, 'supplier_invoice', 'image/png', 10, $3, $4)`,
    [A.tenant, doc, createHash("sha256").update(doc).digest("hex"), `fixture:${doc}`]);
  expect((await intel(all, "chunks:batch", { chunks: [{ id: uuidv7(), document_id: doc, message_id: null, seq: 0, char_start: 0, text: PAGE }] })).status).toBe(201);
  return {
    draft_id: uuidv7(), pack: "inventory_purchasing", command_type: "purchasing.invoice.record.v1",
    payload: { supplier_invoice_id: uuidv7(), supplier_id: A.supplier, invoice_no, invoice_date: "2026-10-09", po_id: null, currency: A.currency,
      lines: [{ line_id: uuidv7(), po_line_id: null, ingredient_id: A.ingredient, description: null,
        qty_milli: span(doc, "12"), unit: "kg", unit_price_minor: span(doc, "340.00"), tax_minor: span(doc, "204.00") }] },
    outlet_ids: [], finding_id: null, evidence: [`doc:${doc}`], based_on: [],
  };
}

describe("invoice_no: an identifier only in its own shape (R-A 4)", () => {
  it("'INV 1042', a number in words and a 41-character value → abstained number_grammar, 0 rows; 'INV-1042' and 'INV/2026-27/0042' → proposed", async () => {
    const before = await drafts();
    for (const bad of ["INV 1042", "two hundred", `A${"1".repeat(40)}`]) {
      const r = await intel(all, "drafts", await invoiceDraft(bad));
      expect([bad, r.status, DraftsResponse.parse(await r.json())]).toMatchObject([bad, 201, { status: "abstained", reason_code: "number_grammar" }]);
    }
    expect(await drafts()).toBe(before);
    for (const good of ["INV-1042", "INV/2026-27/0042"]) {
      const r = await intel(all, "drafts", await invoiceDraft(good));
      expect([good, r.status, DraftsResponse.parse(await r.json()).status]).toEqual([good, 201, "proposed"]);
    }
    expect(await drafts()).toBe(before + 2);
  });
});

describe("campaign and coupon drafts from intel are refused: no specialist proposes them (R-B S1-B, S1-D)", () => {
  it("customers.campaign.create.v1 and catalogue.coupon.set.v1 from intel → 422, 0 rows; a registered draftable → proposed", async () => {
    const coupon = (await db.admin(`SELECT id FROM core.coupon WHERE tenant_id = $1 AND code = 'WELCOME10'`, [A.tenant])).rows[0]!.id as string;
    const m = await intel(all, "snapshots", { template_id: "customers.coupon_current", params: { coupon_id: coupon } });
    expect(m.status).toBe(201);
    const s = Snapshot.parse(await m.json());
    const ref = (col: string) => snapRef(s.snapshot_id, 0, col);
    const before = await drafts();
    const campaign = {
      draft_id: uuidv7(), pack: "customers", command_type: "customers.campaign.create.v1",
      payload: { campaign_id: uuidv7(), name: "Come back soon", channel: "sms", outlet_ids: [], segment_snapshot_id: s.snapshot_id,
        audience_count: ref("global_cap"), message_key: "campaign.winback", placeholders: [], coupon_id: coupon, send_at: "2026-10-12T05:30:00Z",
        window_from: null, window_to: null },
      outlet_ids: [], finding_id: null, evidence: [`snap:${s.snapshot_id}`], based_on: [ref("value_bp")],
    };
    const r = await intel(all, "drafts", campaign);
    expect([r.status, (await r.json()).error]).toMatchObject([422, { code: "invalid_payload" }]);
    const couponSet = {
      draft_id: uuidv7(), pack: "customers", command_type: "catalogue.coupon.set.v1",
      payload: { coupon_id: coupon, code: "WELCOME10", kind: "percent", value_bp: ref("value_bp"), value_minor: null, currency: A.currency,
        min_spend_minor: ref("min_spend_minor"), global_cap: null, per_customer_cap: null, requires_customer: true, outlet_ids: [],
        valid_from: "2026-10-01T00:00:00Z", valid_to: null, active: true },
      outlet_ids: [], finding_id: null, evidence: [`snap:${s.snapshot_id}`], based_on: [ref("value_bp")],
    };
    for (const pack of ["customers", "catalogue"]) {
      const c = await intel(all, "drafts", { ...couponSet, draft_id: uuidv7(), pack });
      expect([pack, c.status, (await c.json()).error]).toMatchObject([pack, 422, { code: "invalid_payload" }]);
    }
    expect(await drafts()).toBe(before);
    const ok = await intel(all, "drafts", await invoiceDraft("INV-2001"));
    expect([ok.status, DraftsResponse.parse(await ok.json()).status]).toEqual([201, "proposed"]);
    expect(await drafts()).toBe(before + 1);
  });
});
