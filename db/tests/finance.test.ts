// Gates (M-B 0008): balanced books (Σ postings = 0 per entry per currency at COMMIT; ≥ 2 postings; a
// context switch before COMMIT cannot hide an unbalanced entry), immutable entries (no postings added to a
// committed entry, one reversal), one entry per source per rule, closed periods (refused; the close and a
// concurrent entry serialise), channel-terms validity, and the currency assertion on postings. Each refusal
// paired with an accepted case; red-proofs on clones.
import { randomUUID } from "node:crypto";
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

/** placed → accepted → preparing → ready → completed, each as kitchen.ticket.advance.v1 (legal transitions). */
export async function completeOrder(x: TestDb, w: World, order: string) {
  for (const to of ["accepted", "preparing", "ready", "completed"]) {
    await x.withContext("munim_core", ownerCtx(w, { command_type: "kitchen.ticket.advance.v1" }), (c) =>
      c.query(`UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenant, order, to]));
  }
}

/** finance.journal.adjust.v1 is draft-only (0015 A1): runs `sql` inside an approved adjustment draft; the error or null. */
const adjusted = (x: TestDb, w: World, sql: string, params: unknown[]) =>
  approveDraft(x, w, "finance.journal.adjust.v1", async (q) => { await q(sql, params); })
    .then(() => null, (e: { code?: string; message: string }) => ({ code: e.code ?? "?", message: e.message }));

/** One journal entry with the given postings [account, amount] in one transaction; returns the error or null. */
async function entry(x: TestDb, w: World, date: string, postings: [string, number][], opts: { outlet?: string | null; currency?: string } = {}) {
  const id = randomUUID();
  const e = await adjusted(x, w, `
    WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date) VALUES ($1, $2, $3, $4) RETURNING id)
    INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
    SELECT $1, gen_random_uuid(), (SELECT id FROM je), p.account, p.amount, $6
      FROM jsonb_to_recordset($5::jsonb) AS p(account uuid, amount bigint)`,
    [w.tenant, id, opts.outlet === undefined ? w.outlets[1] : opts.outlet, date,
     JSON.stringify(postings.map(([account, amount]) => ({ account, amount }))), opts.currency ?? w.currency]);
  return { id, e };
}

describe("balanced books", () => {
  test("unbalanced (+100 / −90) refused at COMMIT with MB010; balanced (+100 / −100) accepted", async () => {
    const bad = await entry(db, A, "2026-10-12", [[A.accounts.cash, 100], [A.accounts.sales, -90]]);
    const good = await entry(db, A, "2026-10-12", [[A.accounts.cash, 100], [A.accounts.sales, -100]]);
    console.log(`balanced books: unbalanced → ${bad.e?.code} (${bad.e?.message}); balanced → ${good.e ? good.e.code : "accepted"}`);
    expect(bad.e?.code).toBe("MB010");
    expect(bad.e?.message).toMatch(/does not balance in INR/);
    expect(good.e).toBeNull();
    const n = await db.admin("SELECT count(*)::int n FROM core.posting WHERE journal_entry_id = ANY ($1)", [[bad.id, good.id]]);
    expect(n.rows[0]!.n).toBe(2); // only the balanced entry's postings exist
  });

  test("one posting, or none, is refused (an entry needs ≥ 2)", async () => {
    expect((await entry(db, A, "2026-10-12", [[A.accounts.cash, 100]])).e?.code).toBe("MB010");
    expect((await entry(db, A, "2026-10-12", [])).e?.code).toBe("MB010");
  });

  test("switching app.tenant_id before COMMIT does not hide an unbalanced entry", async () => {
    // An unbalanced entry for A, then the context moved to tenant B before COMMIT (B's view has no such entry):
    const draft = randomUUID();
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (s) =>
      s.query(`INSERT INTO core.draft (tenant_id, id, source, command_type, command_payload) VALUES ($1, $2, 'member', 'finance.journal.adjust.v1', '{}')`, [A.tenant, draft]));
    const c = await db.connect("munim_core");
    try {
      await c.query("BEGIN");
      await setContext(c, ownerCtx(A, { command_type: "drafts.approve.v1" }));
      const decision = randomUUID();
      await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE tenant_id = $1 AND id = $2`, [A.tenant, draft]);
      await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, 'approved', '{}', $4)`,
        [A.tenant, decision, draft, A.owner]);
      await c.query("SELECT set_config('app.decision_id', $1, true)", [decision]);
      await c.query(`WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, entry_date) VALUES ($1, gen_random_uuid(), '2026-10-12') RETURNING id)
        INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
        SELECT $1, gen_random_uuid(), (SELECT id FROM je), $2::uuid, 100, 'INR' UNION ALL SELECT $1, gen_random_uuid(), (SELECT id FROM je), $3::uuid, -1, 'INR'`,
        [A.tenant, A.accounts.cash, A.accounts.sales]);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [B.tenant]);
      const commit = await c.query("COMMIT").then(() => null, (x: { code: string; message: string }) => x);
      console.log(`balanced books, context switched before COMMIT → ${commit?.code} ${commit?.message}`);
      expect(commit?.code).toBe("MB010");
      expect(commit?.message).toMatch(/not visible at commit/);
    } finally {
      await c.end();
    }
  });

  test("postings cannot be added to a committed entry; a second reversal is refused", async () => {
    const first = await entry(db, A, "2026-10-13", [[A.accounts.cash, 50], [A.accounts.sales, -50]]);
    expect(first.e).toBeNull();
    const append = await adjusted(db, A,
      `INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
       VALUES ($1, gen_random_uuid(), $2, $3, 10, 'INR'), ($1, gen_random_uuid(), $2, $4, -10, 'INR')`,
      [A.tenant, first.id, A.accounts.cash, A.accounts.sales]);
    expect(append?.code).toBe("MB010");
    const reverse = () => adjusted(db, A, `
      WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, entry_date, reverses_id) VALUES ($1, gen_random_uuid(), '2026-10-14', $2) RETURNING id)
      INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
      SELECT $1, gen_random_uuid(), (SELECT id FROM je), $3::uuid, -50, 'INR' UNION ALL SELECT $1, gen_random_uuid(), (SELECT id FROM je), $4::uuid, 50, 'INR'`,
      [A.tenant, first.id, A.accounts.cash, A.accounts.sales]);
    expect(await reverse()).toBeNull();
    expect((await reverse())?.code).toBe("23505");
  });

  test("a posting in another currency than the tenant's → MB003; the tenant's → accepted (above)", async () => {
    expect((await entry(db, A, "2026-10-12", [[A.accounts.cash, 100], [A.accounts.sales, -100]], { currency: "AUD" })).e?.code).toBe("MB003");
  });

  test("finance.post_order: a placed order → MB001 (source state, #21); completed → accepted once, twice → 23505", async () => {
    const post = () => attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", posting_rule: "finance.post_order", source_ref: `core.order:${A.orders[0]}` }, `
      WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, source_type, source_id, posting_rule)
                  VALUES ($1, gen_random_uuid(), $2, '2026-10-10', 'core.order', $3, 'finance.post_order') RETURNING id)
      INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
      SELECT $1, gen_random_uuid(), (SELECT id FROM je), $4::uuid, 33600, 'INR' UNION ALL SELECT $1, gen_random_uuid(), (SELECT id FROM je), $5::uuid, -33600, 'INR'`,
      [A.tenant, A.outlets[0], A.orders[0], A.accounts.cash, A.accounts.sales]);
    const early = await post();
    console.log(`derivation source state: post_order on a placed order → ${early?.code} (${early?.message})`);
    expect(early?.code).toBe("MB001");
    expect(early?.message).toMatch(/not in the rule's source state/);
    await completeOrder(db, A, A.orders[0]);
    expect(await post()).toBeNull();
    expect((await post())?.code).toBe("23505");
  });

  test("RED-PROOF: source_state set to 'true' → the placed order posts", async () => {
    const x = await db.clone();
    try {
      await x.admin("UPDATE core.derivation_rule SET source_state = 'true' WHERE rule_id = 'finance.post_order'");
      const e = await attempt(x, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", posting_rule: "finance.post_order", source_ref: `core.order:${A.orders[1]}` }, `
        WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, source_type, source_id, posting_rule)
                    VALUES ($1, gen_random_uuid(), $2, '2026-10-10', 'core.order', $3, 'finance.post_order') RETURNING id)
        INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
        SELECT $1, gen_random_uuid(), (SELECT id FROM je), $4::uuid, 1, 'INR' UNION ALL SELECT $1, gen_random_uuid(), (SELECT id FROM je), $5::uuid, -1, 'INR'`,
        [A.tenant, A.outlets[1], A.orders[1], A.accounts.cash, A.accounts.sales]);
      console.log("RED-PROOF source state:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: drop the two deferred balance triggers → the unbalanced entry commits", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER posting_balanced ON core.posting; DROP TRIGGER entry_balanced ON core.journal_entry");
      const bad = await entry(x, A, "2026-10-12", [[A.accounts.cash, 100], [A.accounts.sales, -90]]);
      console.log("RED-PROOF balanced books:", bad.e);
      expect(bad.e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("closed period", () => {
  // World: outlet 1 closed March 2025.
  test("an entry dated in the closed month at that outlet → MB009; the same month at outlet 2 and an open month → accepted", async () => {
    const closed = await entry(db, A, "2025-03-15", [[A.accounts.cash, 10], [A.accounts.sales, -10]], { outlet: A.outlets[0] });
    const tenantWide = await entry(db, A, "2025-03-15", [[A.accounts.cash, 10], [A.accounts.sales, -10]], { outlet: null });
    const otherOutlet = await entry(db, A, "2025-03-15", [[A.accounts.cash, 10], [A.accounts.sales, -10]], { outlet: A.outlets[1] });
    const open = await entry(db, A, "2026-10-15", [[A.accounts.cash, 10], [A.accounts.sales, -10]], { outlet: A.outlets[0] });
    console.log(`closed period: closed outlet → ${closed.e?.code}, tenant-wide → ${tenantWide.e?.code}, other outlet → ${otherOutlet.e?.code ?? "accepted"}, open month → ${open.e?.code ?? "accepted"}`);
    expect(closed.e?.code).toBe("MB009");
    expect(tenantWide.e?.code).toBe("MB009");
    expect(otherOutlet.e).toBeNull();
    expect(open.e).toBeNull();
  });

  test("a close and a concurrent entry for the same month serialise: the entry waits, then is refused", async () => {
    const closer = await db.connect("munim_core");
    try {
      await closer.query("BEGIN");
      await setContext(closer, ownerCtx(A, { command_type: "finance.period.close.v1" }));
      await closer.query(`INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by)
                          VALUES ($1, gen_random_uuid(), $2, '2026-11-01', '[]', 0, 'INR', $3)`, [A.tenant, A.outlets[1], A.owner]);
      let settled = false;
      const pending = entry(db, A, "2026-11-20", [[A.accounts.cash, 10], [A.accounts.sales, -10]], { outlet: A.outlets[1] })
        .then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // blocked on the tenant-month lock
      await closer.query("COMMIT");
      const r = await pending;
      console.log(`closed period race: entry waited for the close, then → ${r.e?.code}`);
      expect(r.e?.code).toBe("MB009");
    } finally {
      await closer.end();
    }
  });

  test("RED-PROOF: drop the period_open trigger → an entry in the closed month is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER period_open ON core.journal_entry");
      const r = await entry(x, A, "2025-03-15", [[A.accounts.cash, 10], [A.accounts.sales, -10]], { outlet: A.outlets[0] });
      console.log("RED-PROOF closed period:", r.e);
      // posting_with_entry relies on the entry's created_at stamp set by the dropped trigger; the default (now()) still matches.
      expect(r.e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("channel terms and import formats", () => {
  test("channel terms: an overlapping window → 23P01; an adjacent one after closing the first → accepted", async () => {
    const terms = (from: string) => attempt(db, "munim_core", ownerCtx(A, { command_type: "finance.channel_terms.set.v1" }),
      `INSERT INTO core.channel_terms (tenant_id, id, channel_id, commission_bp, ads_opted_in, promo_share_bp, payout_cycle_days, currency, valid_from)
       VALUES ($1, gen_random_uuid(), $2, 2500, true, 0, 7, 'INR', $3)`, [A.tenant, A.channel, from]);
    expect((await terms("2026-11-01"))?.code).toBe("23P01");
    await db.withContext("munim_core", ownerCtx(A, { command_type: "finance.channel_terms.set.v1" }), (c) =>
      c.query("UPDATE core.channel_terms SET valid_to = '2026-11-01' WHERE tenant_id = $1", [A.tenant]));
    expect(await terms("2026-11-01")).toBeNull();
  });

  test("import format: no approving decision → MB006; mapping with an expression key → 23514 even when approved", async () => {
    const fmt = (decision: string | null, mapping: string) => attempt(db, "munim_core", ownerCtx(A, decision ? { decision_id: decision } : {}),
      `INSERT INTO core.import_format (tenant_id, id, kind, name, header_signature, mapping, decision_id)
       VALUES ($1, gen_random_uuid(), 'bank_statement', 'X', repeat('c', 64), $2, coalesce($3::uuid, (SELECT id FROM core.decision WHERE tenant_id = $1 LIMIT 1)))`,
      [A.tenant, mapping, decision]);
    expect((await fmt(null, '[{"source": "a", "target": "b"}]'))?.code).toBe("MB006");
    const e = await approveDraft(db, A, "imports.format.approve.v1", async (q, decision) => {
      await q(`INSERT INTO core.import_format (tenant_id, id, kind, name, header_signature, mapping, decision_id)
               VALUES ($1, gen_random_uuid(), 'bank_statement', 'X', repeat('d', 64), '[{"source": "a", "target": "b", "expr": "a * 2"}]', $2)`, [A.tenant, decision]);
    }).then(() => null, (x: { code: string }) => x);
    expect(e?.code).toBe("23514");
  });
});
