// 0024 gates (W3.2 review fixes, migrator lane m-1) on the canonical world + the M-C1a fixture + the hand-valued rows below.
// Every refusal is paired with an accept; expected values are hand-kept beside their fixture rows, never read from the SQL:
//   (S1) core.stock_count: a second count at the same outlet and instant → 23505; the same instant at another outlet, and
//        the next second at the same outlet, are accepted. The unique index reads back with its columns in order.
//   (S2) core.supplier: a real supplier with an A2A card URL → 23514 (insert and update); a simulated one with a URL, and a
//        real one without, are accepted.
//   (Q1) intel.chunk admits a run-held chunk (no document, no message) and still refuses a chunk with no source at all;
//        intel.supplier_quote: spans inside the run's own chunk are accepted (code-point offsets), and MB012 refuses a span
//        past the text, an empty or reversed span, a non-integer offset, a set field with no span, a key that is not a numeric
//        quote field (its text never in the error), another run's chunk; spans without a chunk → 23514; no source at all is
//        accepted (the pre-0024 path).
//   (R1) intel.run: an 'ingest' run is accepted, an unknown trigger → 23514.
//   (F5) finance.settlement_vs_orders v3 against v2 on the same rows: an unmatched line has no v3 row and adds 0 to its
//        settlement's Σ row (v2 counted it); a settlement with only unmatched lines keeps a zeros Σ row; matched lines agree
//        (PAY-1, PAY-2); with the pack's two line thresholds removed v3 takes core's defaults (≥ 1 minor unit, 0 bp) and
//        counts a 50-unit short, where v2 counted nothing.
// Red-proofs: db/tests/redproof-0024.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { addOutletData, type McFixture } from "./mc1a-fixture.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

const u = uuidv7;
let db: TestDb;
let w: World;
let fx: McFixture;
const pay = { M: u(), U: u(), lineM: u(), lineMu: u(), lineU: u(), orderM: u() };

/** Named params → $n, as core-api's bindNamedParams (copied from tests/mc1e.test.ts). */
function bind(sql: string): { sql: string; names: string[] } {
  const names: string[] = [];
  let out = "";
  let i = 0;
  const to = (end: string, from: number) => {
    const j = sql.indexOf(end, from);
    return j < 0 ? sql.length : j + end.length;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    let next = i + 1;
    if (ch === "'") next = to("'", i + 1);
    else if (ch === '"') next = to('"', i + 1);
    else if (ch === "-" && sql[i + 1] === "-") next = to("\n", i + 2);
    else if (ch === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) next = to(/^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0], i + 2);
    else if (ch === ":" && sql[i + 1] === ":") next = i + 2;
    else if (ch === ":") {
      const m = /^:([a-z_][a-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        if (!names.includes(m[1]!)) names.push(m[1]!);
        out += `$${names.indexOf(m[1]!) + 1}`;
        i += m[0].length;
        continue;
      }
    }
    out += sql.slice(i, next);
    i = next;
  }
  return { sql: out, names };
}

type Row = Record<string, string | null>;
/** Runs version `v` as core-api's runTemplate does (cells as text). */
async function run(x: TestDb, id: string, v: number, p: Record<string, unknown>, ctx: AppContext = ownerCtx(w)): Promise<Row[]> {
  const t = (await x.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0];
  if (!t) throw new Error(`no ${id} v${v}`);
  const { sql, names } = bind(t.sql);
  return x.withContext("munim_core", ctx, async (c) => {
    const r = await c.query<{ r: Row }>(`SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t LIMIT 500`,
      names.map((n) => p[n]));
    return r.rows.map((y) => y.r);
  });
}
const SEP = { channel_id: null, from: "2026-09-01", to: "2026-09-30", outlet_id: null };

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  fx = await addOutletData(db, w);
  const T = w.tenant;
  const cur = w.currency;
  const run0 = (await db.admin<{ id: string }>(`SELECT id FROM core.import_run WHERE tenant_id = $1 AND status = 'committed' ORDER BY created_at LIMIT 1`, [T])).rows[0]!.id;
  // Two Swiggy payouts at A (20–26 Sep; contract 22%; the IN pack: Swiggy collects the order's tax; line rule short ≥
  // max(100, ⌈expected × 50 ÷ 10,000⌉)):
  //   PAY-M  line M  matched to ORDER-M (total 21,000 with 1,000 tax): gross 21,000, commission 4,620 (22%), tax withheld
  //                  1,050 (50 over the order's tax), net 15,330; expected 21,000 − 4,620 − 1,000 (the order's own tax) =
  //                  15,380 → short 50 < 100: does not count (counts at core's defaults)
  //          line Mu unmatched: gross 50,000, commission 14,000, net 36,000; v2 expected from the gross 50,000 − 11,000 −
  //                  0 = 39,000 → short 3,000 ≥ 195: v2 counts it; v3 has no row for it
  //   PAY-U  line U  unmatched only (as Mu): v2 Σ 3,000; v3 Σ row all zeros, no line rows.
  await approveDraft(db, w, "imports.run.commit.v1", async (q) => {
    await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                        pricing_snapshot, external_ref, created_at)
             VALUES ($1, $2, $3, $4, 'takeaway', 'completed', '2026-09-21', 20000, 1000, 21000, $5, '{"synthetic": true}', 'AGG-M', '2026-09-21T07:30:00Z')`,
      [T, pay.orderM, fx.A, fx.agg, cur]);
    type Line = [id: string, order: string | null, gross: number, commission: number, net: number, taxWithheld: number];
    const payouts: Array<[string, string, Line[]]> = [
      [pay.M, "PAY-M", [[pay.lineM, pay.orderM, 21000, 4620, 15330, 1050], [pay.lineMu, null, 50000, 14000, 36000, 0]]],
      [pay.U, "PAY-U", [[pay.lineU, null, 50000, 14000, 36000, 0]]],
    ];
    for (const [s, ref, lines] of payouts) {
      await q(`INSERT INTO core.settlement (tenant_id, id, channel_id, outlet_id, period_from, period_to, paid_on, external_ref, net_minor, currency, import_run_id)
               VALUES ($1, $2, $3, $4, '2026-09-20', '2026-09-26', '2026-09-28', $5, $6, $7, $8)`,
        [T, s, fx.agg, fx.A, ref, lines.reduce((a, l) => a + l[4], 0), cur, run0]);
      for (const [i, [id, order, g, k, net, tw]] of lines.entries()) {
        await q(`INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, matched_order_id, gross_minor, commission_minor,
                                                    tax_withheld_minor, net_minor, currency, external_order_ref)
                 VALUES ($1, $2, $3, $4, 'order', $5, $6, $7, $8, $9, $10, $11)`, [T, id, s, i + 1, order, g, k, tw, net, cur, `${ref}-${i + 1}`]);
      }
    }
  });
}, 300_000);
afterAll(async () => db?.stop());

const own = (command_type: string): AppContext => ownerCtx(w, { command_type });
const svc = (): AppContext => ({ tenant_id: w.tenant, outlet_ids: "*" });

// ---------------------------------------------------------------------------------------------------------------
describe("S1 — one stock count per outlet per instant", () => {
  test("the unique index reads back: core.stock_count (tenant_id, outlet_id, counted_at), unique, no predicate", async () => {
    const r = (await db.admin<{ cols: string; uniq: boolean; pred: string | null }>(`
      SELECT (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) cols, i.indisunique uniq, pg_get_expr(i.indpred, i.indrelid) pred
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'stock_count_outlet_counted_at_key'`)).rows;
    expect(r).toEqual([{ cols: "tenant_id,outlet_id,counted_at", uniq: true, pred: null }]);
  });

  test("refused: a second count at outlet A at the same instant → 23505; accepted: the same instant at B, the next second at A", async () => {
    const ins = (o: string, at: string) => attempt(db, "munim_core", own("inventory.count.submit.v1"),
      `INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by, counted_at, status) VALUES ($1, $2, $3, $4, $5, 'submitted')`, [w.tenant, u(), o, w.owner, at]);
    const first = await ins(fx.A, "2026-09-15T10:00:00Z");
    const dup = await ins(fx.A, "2026-09-15T10:00:00Z");
    const otherOutlet = await ins(fx.B, "2026-09-15T10:00:00Z");
    const nextSecond = await ins(fx.A, "2026-09-15T10:00:01Z");
    console.log(`S1: first → ${first?.code ?? "accepted"}; same outlet + instant → ${dup?.code} (${dup?.message}); other outlet → ${otherOutlet?.code ?? "accepted"}; next second → ${nextSecond?.code ?? "accepted"}`);
    expect(first).toBeNull();
    expect(dup?.code).toBe("23505");
    expect(dup?.message).toMatch(/stock_count_outlet_counted_at_key/);
    expect(otherOutlet).toBeNull();
    expect(nextSecond).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("S2 — only a simulated supplier has an A2A endpoint", () => {
  test("refused: a real supplier with a card URL (insert → 23514, update → 23514); accepted: a simulated one with a URL, a real one without", async () => {
    const ins = (kind: string, url: string | null) => attempt(db, "munim_core", own("purchasing.supplier.upsert.v1"),
      `INSERT INTO core.supplier (tenant_id, id, name, kind, a2a_card_url) VALUES ($1, $2, 'Fixture supplier', $3, $4)`, [w.tenant, u(), kind, url]);
    const realUrl = await ins("real", "https://suppliers.example.test/card");
    const simUrl = await ins("simulated", "https://suppliers-sim.example.test/card");
    const real = u();
    const realNoUrl = await attempt(db, "munim_core", own("purchasing.supplier.upsert.v1"),
      `INSERT INTO core.supplier (tenant_id, id, name, kind) VALUES ($1, $2, 'Fixture real supplier', 'real')`, [w.tenant, real]);
    const realSetUrl = await attempt(db, "munim_core", own("purchasing.supplier.upsert.v1"),
      `UPDATE core.supplier SET a2a_card_url = 'https://suppliers.example.test/card' WHERE id = $1`, [real]);
    console.log(`S2: real + URL → ${realUrl?.code}; simulated + URL → ${simUrl?.code ?? "accepted"}; real, no URL → ${realNoUrl?.code ?? "accepted"}; real gains a URL → ${realSetUrl?.code}`);
    expect(realUrl?.code).toBe("23514");
    expect(realUrl?.message).toMatch(/supplier_a2a_simulated_only/);
    expect(simUrl).toBeNull();
    expect(realNoUrl).toBeNull();
    expect(realSetUrl?.code).toBe("23514");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Q1 — a quote's fields point into the supplier's reply", () => {
  // A simulated supplier's reply (synthetic). The leading emoji is one code point but two UTF-16 units: offsets are code points.
  const REPLY = "🧀 Simulated Dairy: we can supply 10 kg of paneer at 390.00 per kg, minimum order 5 kg, payment in 15 days.";
  const cp = Array.from(REPLY);
  const at = (token: string, after = 0): [number, number] => {
    const s = Array.from(REPLY.slice(0, REPLY.indexOf(token, after))).length;
    return [s, s + Array.from(token).length];
  };
  const SPANS = {
    qty_milli: at("10"), unit_price_minor: at("390.00"), min_order_qty_milli: at("5", REPLY.indexOf("minimum")), payment_days: at("15"),
  };
  let chunk = "";
  let otherChunk = "";
  let otherRun = "";

  const quote = (fields: { source_chunk_id?: string | null; spans?: unknown; min_order?: number; days?: number; runId?: string }) =>
    attempt(db, "munim_svc", svc(),
      `INSERT INTO intel.supplier_quote (tenant_id, id, run_id, supplier_id, ingredient_id, round, qty_milli, unit, unit_price_minor, currency,
                                         min_order_qty_milli, payment_days, source_chunk_id, spans)
       VALUES ($1, $2, $3, $4, $5, 1, 10000, 'kg', 39000, $6, $7, $8, $9, $10)`,
      [w.tenant, u(), fields.runId ?? w.run, w.supplier, w.ingredient, w.currency, fields.min_order ?? 5000, fields.days ?? 15,
       fields.source_chunk_id === undefined ? chunk : fields.source_chunk_id,
       // As JSON text: node-pg would send a JS array as a Postgres array literal.
       fields.spans === null ? null : JSON.stringify(fields.spans === undefined ? SPANS : fields.spans)]);

  test("intel.chunk: a run-held chunk (no document, no message) is accepted; a chunk with no source at all → 23514", async () => {
    chunk = u();
    otherChunk = u();
    otherRun = u();
    const runHeld = await attempt(db, "munim_svc", svc(), `INSERT INTO intel.chunk (tenant_id, id, seq, text, run_id) VALUES ($1, $2, 0, $3, $4)`,
      [w.tenant, chunk, REPLY, w.run]);
    const noSource = await attempt(db, "munim_svc", svc(), `INSERT INTO intel.chunk (tenant_id, id, seq, text) VALUES ($1, $2, 0, 'orphan text')`, [w.tenant, u()]);
    await db.withContext("munim_svc", svc(), async (c) => {
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', '{*}', now() + interval '1 hour')`,
        [w.tenant, otherRun]);
      await c.query(`INSERT INTO intel.chunk (tenant_id, id, seq, text, run_id) VALUES ($1, $2, 0, $3, $4)`, [w.tenant, otherChunk, REPLY, otherRun]);
    });
    console.log(`Q1 chunk: run-held → ${runHeld?.code ?? "accepted"}; no source → ${noSource?.code}`);
    expect(runHeld).toBeNull();
    expect(noSource?.code).toBe("23514");
    expect(noSource?.message).toMatch(/chunk_source_check/);
  });

  test("accepted: every set field spanned inside the run's own chunk (code-point offsets); a zero field without a span; no source at all", async () => {
    // Hand check of the spans (code points): the reply's slices are the numbers the fields hold.
    expect(Object.fromEntries(Object.entries(SPANS).map(([k, [s, e]]) => [k, cp.slice(s, e).join("")])))
      .toEqual({ qty_milli: "10", unit_price_minor: "390.00", min_order_qty_milli: "5", payment_days: "15" });
    const full = await quote({});
    const zeroMinOrder = await quote({ min_order: 0, spans: { qty_milli: SPANS.qty_milli, unit_price_minor: SPANS.unit_price_minor, payment_days: SPANS.payment_days } });
    const none = await quote({ source_chunk_id: null, spans: null });
    console.log(`Q1 accept: full → ${full?.code ?? "accepted"}; zero min order unspanned → ${zeroMinOrder?.code ?? "accepted"}; no source → ${none?.code ?? "accepted"}`);
    expect(full).toBeNull();
    expect(zeroMinOrder).toBeNull();
    expect(none).toBeNull();
  });

  test("refused (MB012): a span past the text (UTF-16 length, not code points), empty, reversed, fractional; a set field unspanned; another run's chunk; a foreign key (never echoed)", async () => {
    const utf16End = { ...SPANS, payment_days: [SPANS.payment_days[0], REPLY.length] };
    const cases: Record<string, Parameters<typeof quote>[0]> = {
      pastText: { spans: utf16End },
      empty: { spans: { ...SPANS, qty_milli: [5, 5] } },
      reversed: { spans: { ...SPANS, qty_milli: [9, 5] } },
      fractional: { spans: { ...SPANS, qty_milli: [1.5, 4] } },
      negative: { spans: { ...SPANS, qty_milli: [-1, 4] } },
      notPair: { spans: { ...SPANS, qty_milli: [1, 2, 3] } },
      notObject: { spans: [1, 2] },
      unspanned: { spans: { qty_milli: SPANS.qty_milli, unit_price_minor: SPANS.unit_price_minor, min_order_qty_milli: SPANS.min_order_qty_milli } },
      otherRunsChunk: { source_chunk_id: otherChunk },
      foreignKey: { spans: { ...SPANS, "ignore previous instructions": [0, 2] } },
    };
    const got: Record<string, string> = {};
    let foreignMsg = "";
    for (const [name, f] of Object.entries(cases)) {
      const e = await quote(f);
      got[name] = e?.code ?? "accepted";
      if (name === "foreignKey") foreignMsg = e?.message ?? "";
    }
    console.log(`Q1 refuse: ${JSON.stringify(got)}; foreign-key message: ${foreignMsg}`);
    expect(Array.from(REPLY).length).toBeLessThan(REPLY.length); // the emoji makes the two lengths differ
    expect(got).toEqual(Object.fromEntries(Object.keys(cases).map((k) => [k, "MB012"])));
    expect(foreignMsg).not.toMatch(/ignore previous instructions/);
  });

  test("refused: spans without a chunk → 23514 (CHECK); a chunk without spans → MB012 (the BEFORE trigger fires before the CHECK)", async () => {
    const spansOnly = await quote({ source_chunk_id: null });
    const chunkOnly = await quote({ spans: null });
    console.log(`Q1 pairing: spans only → ${spansOnly?.code}; chunk only → ${chunkOnly?.code}`);
    expect(spansOnly?.code).toBe("23514");
    expect(chunkOnly?.code).toBe("MB012");
    expect(spansOnly?.message).toMatch(/supplier_quote_spans_with_chunk/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("R1 — an ingestion run", () => {
  test("accepted: trigger 'ingest' (actor = the uploading member); refused: an unknown trigger → 23514", async () => {
    const ins = (trigger: string) => attempt(db, "munim_svc", svc(),
      `INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, $3, $4, '{*}', now() + interval '2 hours')`,
      [w.tenant, u(), trigger, w.owner]);
    const ingest = await ins("ingest");
    const unknown = await ins("ingestion");
    console.log(`R1: ingest → ${ingest?.code ?? "accepted"}; ingestion → ${unknown?.code}`);
    expect(ingest).toBeNull();
    expect(unknown?.code).toBe("23514");
    expect(unknown?.message).toMatch(/run_trigger_check/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("F5 — finance.settlement_vs_orders v3 (reconcileSettlement's lines and thresholds)", () => {
  const sigma = (rows: Row[], s: string) => rows.find((r) => r.settlement_line_id === null && r.settlement_id === s);
  const lineIds = (rows: Row[], s: string) => rows.filter((r) => r.settlement_line_id !== null && r.settlement_id === s).map((r) => r.settlement_line_id).sort();
  const ref = async (x: TestDb, r: string) => (await x.admin<{ id: string }>(`SELECT id FROM core.settlement WHERE tenant_id = $1 AND external_ref = $2`, [w.tenant, r])).rows[0]!.id;

  test("an unmatched line adds 0 and has no row; a settlement of only unmatched lines keeps a zeros Σ row; matched lines agree with v2", async () => {
    const v2 = await run(db, "finance.settlement_vs_orders", 2, SEP);
    const v3 = await run(db, "finance.settlement_vs_orders", 3, SEP);
    const p1 = await ref(db, "PAY-1");
    const p2 = await ref(db, "PAY-2");
    const got = {
      v2: { M: sigma(v2, pay.M)?.short_minor, U: sigma(v2, pay.U)?.short_minor, P1: sigma(v2, p1)?.short_minor, P2: sigma(v2, p2)?.short_minor },
      v3: { M: sigma(v3, pay.M)?.short_minor, U: sigma(v3, pay.U)?.short_minor, P1: sigma(v3, p1)?.short_minor, P2: sigma(v3, p2)?.short_minor },
      v3lines: { M: lineIds(v3, pay.M), U: lineIds(v3, pay.U) },
      v3U: sigma(v3, pay.U) && ["order_total_minor", "commission_minor", "net_minor", "expected_commission_minor", "refund_minor", "expected_net_minor", "short_minor"]
        .map((c) => sigma(v3, pay.U)![c]),
      v3M: v3.find((r) => r.settlement_line_id === pay.lineM),
      sigmaFirst: v3.findIndex((r) => r.settlement_line_id !== null) === v3.filter((r) => r.settlement_line_id === null).length,
      sameSigmaSet: JSON.stringify(v2.filter((r) => r.settlement_line_id === null).map((r) => r.settlement_id))
        === JSON.stringify(v3.filter((r) => r.settlement_line_id === null).map((r) => r.settlement_id)),
    };
    console.log(`F5: ${JSON.stringify(got)}`);
    // Hand values (beforeAll and mc1a-fixture): PAY-1 / PAY-2 order 31,500 (1,500 tax), commission 8,820 → expected
    // 31,500 − 6,930 − 1,500 = 23,070, net 22,680 → short 390 ≥ max(100, 116): counts in both.
    expect(got.v2).toEqual({ M: "3000", U: "3000", P1: "390", P2: "390" });
    expect(got.v3).toEqual({ M: "0", U: "0", P1: "390", P2: "390" });
    expect(got.v3lines).toEqual({ M: [pay.lineM], U: [] });
    expect(got.v3U).toEqual(["0", "0", "0", "0", "0", "0", "0"]);
    expect(got.v3M).toMatchObject({ order_total_minor: "21000", expected_commission_minor: "4620", expected_net_minor: "15380", net_minor: "15330", short_minor: "50" });
    expect(got.sigmaFirst).toBe(true);
    expect(got.sameSigmaSet).toBe(true);
  });

  test("no line thresholds in the pack: v3 takes core's defaults (≥ 1, 0 bp) and counts the 50 short; v2 counted nothing", async () => {
    const x = await db.clone();
    try {
      const n = await x.admin(`UPDATE platform.country_pack SET doc = doc #- '{detectors,finance.short_payout,thresholds,line_short_minor_gte}'
                                                          #- '{detectors,finance.short_payout,thresholds,line_short_bp_gte}'
                                 WHERE code = 'IN' AND doc #> '{detectors,finance.short_payout,thresholds,line_short_minor_gte}' IS NOT NULL`);
      expect(n.rowCount).toBeGreaterThanOrEqual(1);
      const v2 = await run(x, "finance.settlement_vs_orders", 2, SEP);
      const v3 = await run(x, "finance.settlement_vs_orders", 3, SEP);
      const p1 = await ref(x, "PAY-1");
      const got = { v2: [sigma(v2, pay.M)?.short_minor, sigma(v2, p1)?.short_minor], v3: [sigma(v3, pay.M)?.short_minor, sigma(v3, p1)?.short_minor] };
      console.log(`F5 defaults: ${JSON.stringify(got)}`);
      expect(got).toEqual({ v2: ["0", "0"], v3: ["50", "390"] });
    } finally {
      await x.stop();
    }
  });

  test("v3 is the latest, with v2's columns, params and role", async () => {
    const r = (await db.admin<{ latest: number; same: boolean }>(`
      SELECT (SELECT max(version) FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders') latest,
             (t3.columns = t2.columns AND t3.params_schema = t2.params_schema AND t3.min_role = t2.min_role) same
        FROM evidence.snapshot_template t3 JOIN evidence.snapshot_template t2 ON t2.id = t3.id AND t2.version = 2
       WHERE t3.id = 'finance.settlement_vs_orders' AND t3.version = 3`)).rows;
    expect(r).toEqual([{ latest: 3, same: true }]);
  });
});
