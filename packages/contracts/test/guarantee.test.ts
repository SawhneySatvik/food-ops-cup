// One Guarantee, clause 1 + 2 at the contract layer (R15, R26): a draft proposed by intel cannot carry a
// model-typed number, and intel cannot pose as a person. Checked on the GENERATED JSON Schema (what
// Pydantic and every other consumer sees) and on zod (what core-api enforces).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DraftsApproveV1 } from "../src/approvals/index.ts";
import { DraftsRequest } from "../src/internal/index.ts";
import { loadRegistry } from "../src/registry.ts";
import { toEditable, toProposal } from "../src/shared/draft.ts";
import { draftableTypes } from "../src/shared/draftables.ts";
import { PKG, loadSamples, manifestNames } from "./helpers.ts";

type Node = Record<string, unknown>;
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_ONE = ["items", "additionalProperties", "propertyNames", "not", "if", "then", "else", "contains", "unevaluatedProperties", "unevaluatedItems"];
const SCHEMA_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SHAPE_KEYS = ["type", "$ref", "anyOf", "oneOf", "allOf", "const", "enum", "not"];

/** Every place a number could enter: a numeric type, a numeric const/enum, an accept-anything schema
 *  (`{}` / `true`), or a person-edit (`typed_by`) form. Walks schema positions only. */
export function numericLeaves(node: unknown, path = "$"): string[] {
  if (node === true) return [`${path} (accepts anything)`];
  if (node === false || node === null || typeof node !== "object") return [];
  const o = node as Node;
  const hits: string[] = [];
  const t = o.type;
  const types = Array.isArray(t) ? t : [t];
  if (types.includes("integer") || types.includes("number")) hits.push(`${path} (type ${types.join("|")})`);
  if (typeof o.const === "number" || (Array.isArray(o.enum) && o.enum.some((v) => typeof v === "number"))) hits.push(`${path} (numeric const/enum)`);
  if (!SHAPE_KEYS.some((k) => k in o)) hits.push(`${path} (accepts anything)`);
  if (o.properties && typeof o.properties === "object" && "typed_by" in (o.properties as Node)) hits.push(`${path} (person-edit form)`);
  for (const k of SCHEMA_MAPS) if (o[k] && typeof o[k] === "object") for (const [n, s] of Object.entries(o[k] as Node)) hits.push(...numericLeaves(s, `${path}.${k}.${n}`));
  for (const k of SCHEMA_ONE) if (k in o) hits.push(...numericLeaves(o[k], `${path}.${k}`));
  for (const k of SCHEMA_LIST) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach((s, i) => hits.push(...numericLeaves(s, `${path}.${k}[${i}]`)));
  return hits;
}

await loadRegistry(); // registers every module's draftables

const js = (name: string) => JSON.parse(readFileSync(join(PKG, "generated", "json-schema", `${name}.schema.json`), "utf8")) as Node;
const SAMPLES = await loadSamples();
const req = SAMPLES["internal.drafts.request"] as any;
const PROPOSAL_NAMES = manifestNames().filter((n) => n.startsWith("proposal."));

describe("draft payloads proposed by intel are refs", () => {
  it("one proposal schema per draftable command type", () => {
    expect(PROPOSAL_NAMES.map((n) => n.slice("proposal.".length)).sort()).toEqual(draftableTypes());
    expect(PROPOSAL_NAMES.length).toBeGreaterThan(0);
  });

  it.each(PROPOSAL_NAMES)("%s: 0 numeric / open / person-edit leaves", (name) => {
    expect(numericLeaves(js(name))).toEqual([]);
  });

  it("internal.drafts.request: 0 numeric / open / person-edit leaves (payload, evidence, based_on)", () => {
    expect(numericLeaves(js("internal.drafts.request"))).toEqual([]);
  });

  it("the generated payload position is anyOf every registered proposal (not an open object)", () => {
    const payload = (js("internal.drafts.request") as any).properties.payload;
    expect(payload.anyOf.length).toBe(draftableTypes().length);
    expect(payload.additionalProperties).toBeUndefined();
  });

  it("the scanner catches each planted kind (red-proof of the scanner)", () => {
    const plant = (extra: Node) => {
      const s = js("internal.drafts.request") as any;
      Object.assign(s.properties.payload.anyOf[0].properties, extra);
      return numericLeaves(s).length;
    };
    expect(plant({ planted: { type: "integer" } })).toBe(1);
    expect(plant({ planted: { type: ["string", "number"] } })).toBe(1);
    expect(plant({ planted: {} })).toBe(1);
    expect(plant({ planted: { const: 12000 } })).toBe(1);
    expect(plant({ planted: { type: "object", properties: { value: { type: "string" }, typed_by: { type: "string" } } } })).toBe(1);
  });

  it("zod: refs accepted; a bare number refused; a person-edit refused (intel cannot type for a person)", () => {
    const line = req.payload.lines[0];
    const withQty = (qty: unknown) => ({ ...req, payload: { ...req.payload, lines: [{ ...line, qty_milli: qty }] } });
    expect(DraftsRequest.safeParse(req).success).toBe(true);
    expect(DraftsRequest.safeParse(withQty(12000)).success).toBe(false);
    expect(DraftsRequest.safeParse(withQty("12000")).success).toBe(false);
    expect(DraftsRequest.safeParse(withQty({ value: 12000, typed_by: "0199e0a0-0000-7000-8000-000000000008" })).success).toBe(false);
  });

  it("based_on is snapshot cells only — a typed expected value is refused", () => {
    expect(DraftsRequest.safeParse({ ...req, based_on: [{ ref: req.based_on[0], expected: 1500 }] }).success).toBe(false);
  });
});

describe("a person's edit carries {value, typed_by}", () => {
  const approve = SAMPLES["drafts.approve.v1"] as any;
  const line = approve.edited_payload.lines[0];
  const withQty = (qty: unknown) => ({ ...approve, edited_payload: { ...approve.edited_payload, lines: [{ ...line, qty_milli: qty }] } });
  it("approve accepts a person-edit or the proposed ref, and refuses an unlabelled bare number", () => {
    expect(DraftsApproveV1.safeParse(approve).success).toBe(true);
    expect(DraftsApproveV1.safeParse(withQty(line.qty_milli.value)).success).toBe(false);
    expect(DraftsApproveV1.safeParse(withQty({ value: 10000 })).success).toBe(false);
    expect(DraftsApproveV1.safeParse(withQty(approve.edited_payload.lines[0].unit_price_minor)).success).toBe(true);
  });
  it("a person-edit keeps the field's own constraints (qty must stay positive)", () => {
    expect(DraftsApproveV1.safeParse(withQty({ ...line.qty_milli, value: 0 })).success).toBe(false);
  });
});

describe("the derivation fails closed", () => {
  it.each([
    ["readonly number", z.strictObject({ q: z.int().readonly() })],
    ["number with catch", z.strictObject({ q: z.int().catch(0) })],
    ["number with default", z.strictObject({ q: z.int().default(1) })],
    ["numeric literal", z.strictObject({ q: z.literal(5) })],
    ["open object", z.looseObject({ q: z.string() })],
    ["record", z.strictObject({ q: z.record(z.string(), z.int()) })],
    ["pipe/transform", z.strictObject({ q: z.string().transform((s) => s.length) })],
  ])("throws on %s", (_l, s) => {
    expect(() => toProposal(s)).toThrow(/draft payload/);
    expect(() => toEditable(s)).toThrow(/draft payload/);
  });
});

describe("numeric fields intel may still send (reviewed list — a new one turns this red)", () => {
  // Each is a count / bound / score that is not a book number and not shown as a figure:
  //   findings.request confidence_bp — model self-assessment, shown as a band;
  //   snapshots.request params — template parameters (limits, flags), validated by the template;
  //   graph-query.request args — a graph template's `depth` (1..3 hops), checked by core like intel's check_args (W3.2);
  //   traces-batch seq — ordering counter.
  // T-040b batches (each lands in an allow-listed intel numeric source or is not a figure at all):
  //   chunks seq/char_start, claims span_start/span_end, wiki version — positions and ordinals, never figures;
  //   embeddings — vector components in millionths, never shown;
  //   forecasts — T-052's deterministic figures: point qty/lo/hi are on INTEL_NUMERIC_ALLOW (db/tests/manifest.ts) and
  //     shown only as forecast template cells, each point tied to its inputs snapshot; the run's wape/bias/horizon/
  //     holdout are NOT on it, so no template may show them without a new review;
  //   quotes — figures the no-tools EXTRACTOR MODEL typed from a SIMULATED supplier's reply (R22): price, qty,
  //     min order, payment days and round are on the allow-list and shown to people as quote cells; terms integers
  //     are not on it; spans (R-C F3) are character positions in the stored reply chunk, never figures;
  //   spend — amount_minor (on the allow-list, shown as budget template cells) is SELF-REPORTED by intel, so core
  //     cannot hold the cap against under-reporting; token counts are not on the allow-list.
  const EXPECTED = [
    "internal.findings.request: $.properties.confidence_bp (type integer)",
    "internal.snapshots.request: $.properties.params.additionalProperties.anyOf[1] (type integer)",
    "internal.traces-batch.request: $.properties.events.items.oneOf[0].properties.seq (type integer)",
    "internal.traces-batch.request: $.properties.events.items.oneOf[1].properties.seq (type integer)",
    "internal.chunks-batch.request: $.properties.chunks.items.properties.char_start (type integer)",
    "internal.chunks-batch.request: $.properties.chunks.items.properties.seq (type integer)",
    "internal.claims-batch.request: $.properties.claims.items.properties.span_end (type integer)",
    "internal.claims-batch.request: $.properties.claims.items.properties.span_start (type integer)",
    "internal.embeddings-batch.request: $.properties.embeddings.items.properties.embedding_micro.items (type integer)",
    "internal.forecasts-batch.request: $.properties.forecast_run.properties.baseline_wape_bp.anyOf[0] (type integer)",
    "internal.forecasts-batch.request: $.properties.forecast_run.properties.bias_bp.anyOf[0] (type integer)",
    "internal.forecasts-batch.request: $.properties.forecast_run.properties.holdout_days (type integer)",
    "internal.forecasts-batch.request: $.properties.forecast_run.properties.horizon_days (type integer)",
    "internal.forecasts-batch.request: $.properties.forecast_run.properties.wape_bp.anyOf[0] (type integer)",
    "internal.forecasts-batch.request: $.properties.points.items.properties.hi_qty_milli (type integer)",
    "internal.forecasts-batch.request: $.properties.points.items.properties.lo_qty_milli (type integer)",
    "internal.forecasts-batch.request: $.properties.points.items.properties.qty_milli (type integer)",
    "internal.graph-query.request: $.properties.args.additionalProperties.anyOf[1] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.min_order_qty_milli (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.payment_days (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.qty_milli (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.round (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.min_order_qty_milli.anyOf[0].prefixItems[0] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.min_order_qty_milli.anyOf[0].prefixItems[1] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.payment_days.anyOf[0].prefixItems[0] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.payment_days.anyOf[0].prefixItems[1] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.qty_milli.prefixItems[0] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.qty_milli.prefixItems[1] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.unit_price_minor.prefixItems[0] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.spans.properties.unit_price_minor.prefixItems[1] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.terms.additionalProperties.anyOf[1] (type integer)",
    "internal.quotes-batch.request: $.properties.quotes.items.properties.unit_price_minor (type integer)",
    "internal.spend.request: $.properties.entries.items.properties.amount_minor (type integer)",
    "internal.spend.request: $.properties.entries.items.properties.input_tokens (type integer)",
    "internal.spend.request: $.properties.entries.items.properties.output_tokens (type integer)",
    "internal.wiki-batch.request: $.properties.pages.items.properties.version (type integer)",
  ];
  it("every intel-sent body's numeric leaves are exactly the reviewed list", () => {
    const got = manifestNames()
      .filter((n) => n.startsWith("internal.") && n.endsWith(".request"))
      .flatMap((n) => numericLeaves(js(n)).map((h) => `${n}: ${h}`));
    console.log(`intel-sent numeric leaves:\n  ${got.join("\n  ")}`);
    expect(got.sort()).toEqual([...EXPECTED].sort());
  });
});
