// Unit gates for the model-facing transform and the provider lint (ADR-014 §5.2): each rule with its accept and its
// refusal, on small zod schemas built here (the contract forms: Ref, Uuid7, IsoDate, unions, optional, arrays).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lintToolSchema } from "../src/ontology/lint.ts";
import { DEFAULT_MAX_ITEMS, DESCRIBE, type Json, proposeToolName, readToolName, toModelSchema } from "../src/ontology/transform.ts";
import { IsoDate, UUID7_PATTERN, Uuid7 } from "../src/shared/primitives.ts";
import { Ref, RefId } from "../src/shared/refs.ts";

const json = (s: z.ZodType) => {
  const { $schema: _s, ...rest } = z.toJSONSchema(s, { target: "draft-2020-12", io: "input" }) as Json;
  return rest;
};

describe("toModelSchema", () => {
  const contract = json(
    z.strictObject({
      po_id: Uuid7,
      supplier_id: Uuid7,
      run_ref: Uuid7.nullable(),
      price: Ref,
      floor: Ref.nullable(),
      on: IsoDate,
      kind: z.union([z.enum(["counter", "pickup"]), z.string().regex(/^aggregator:[a-z]+$/)]),
      note: z.string().max(80).optional(),
      lines: z.array(z.strictObject({ qty: Ref, item_id: Uuid7, evidence: RefId })).min(1),
    }),
  );
  const out = toModelSchema(contract, { minted: ["/po_id"], fixed: ["/run_ref"] });
  const p = out.schema.properties as Record<string, Json>;

  it("Ref → handle, uuid → entity handle, minted / fixed removed, T | null → nullable, string union → one string", () => {
    expect(Object.keys(p)).toEqual(["supplier_id", "price", "floor", "on", "kind", "note", "lines"]);
    expect(p.price).toEqual({ type: "string", description: DESCRIBE.ref });
    expect(p.floor).toEqual({ type: ["string", "null"], description: DESCRIBE.ref });
    expect(p.supplier_id).toEqual({ type: "string", description: DESCRIBE.entity });
    expect(p.on).toEqual({ type: "string", description: "A calendar date, YYYY-MM-DD." });
    expect(p.kind!.type).toBe("string");
    expect(p.note).toEqual({ type: ["string", "null"], description: "Text, at most 80 characters." });
    expect(out.optional).toEqual(["/note"]);
    expect(out.leaves.map((l) => `${l.path}:${l.kind}`)).toEqual([
      "/po_id:minted", "/supplier_id:entity", "/run_ref:fixed", "/price:ref", "/floor:ref", "/lines/*/qty:ref", "/lines/*/item_id:entity",
      "/lines/*/evidence:ref_id",
    ]);
    expect((p.lines as Json).maxItems).toBe(DEFAULT_MAX_ITEMS);
    expect(JSON.stringify(out.schema)).not.toMatch(/pattern|anyOf|format/);
    expect(lintToolSchema(out.schema)).toEqual([]);
  });

  it("fails closed: a numeric leaf, a oneOf, an object union, an override naming no uuid leaf, a uuid-bearing pattern", () => {
    expect(() => toModelSchema(json(z.strictObject({ n: z.int() })))).toThrow(/numeric leaf in a proposal/);
    expect(toModelSchema(json(z.strictObject({ n: z.int() })), {}, { numbers: true }).schema.properties).toEqual({ n: { type: "integer" } });
    expect(() => toModelSchema({ type: "object", properties: { x: { oneOf: [{ type: "string" }] } } })).toThrow(/oneOf/);
    const objUnion = z.strictObject({ x: z.union([z.strictObject({ a: Ref }), z.strictObject({ b: Ref })]) });
    expect(() => toModelSchema(json(objUnion))).toThrow(/anyOf that is neither/);
    expect(() => toModelSchema(contract, { minted: ["/nope"] })).toThrow(/override names no uuid leaf/);
    const typedId = z.strictObject({ x: z.string().regex(new RegExp(`^order:${UUID7_PATTERN}$`)) });
    expect(() => toModelSchema(json(typedId))).toThrow(/a pattern embedding a uuid/);
  });

  it("tool names come from contract names", () => {
    expect(readToolName("catalogue.dish_margin")).toBe("read_catalogue_dish_margin");
    expect(proposeToolName("purchasing.po.create.v1")).toBe("propose_purchasing_po_create");
  });
});

describe("lintToolSchema", () => {
  const ok = { type: "object", properties: { a: { type: "string", enum: ["x"] }, b: { type: "array", items: { type: "string" }, maxItems: 5 } }, required: ["a", "b"], additionalProperties: false };
  it("accepts the subset and names each violation", () => {
    expect(lintToolSchema(ok)).toEqual([]);
    const deep = { type: "object", properties: { a: { type: "array", maxItems: 1, items: { type: "object", properties: { b: { type: "array", maxItems: 1, items: { type: "object", properties: {}, required: [], additionalProperties: false } } }, required: ["b"], additionalProperties: false } } }, required: ["a"], additionalProperties: false };
    const cases: Array<[Json, string]> = [
      [{ ...ok, required: ["a"] }, "/: required is not every property"],
      [{ ...ok, additionalProperties: true }, "/: additionalProperties is not false"],
      [{ ...ok, properties: { ...ok.properties, b: { type: "array", items: { type: "string" } } } }, "/b: array without maxItems"],
      [{ ...ok, properties: { ...ok.properties, a: { type: "string", pattern: "^x$" } } }, "/a: keyword pattern"],
      [{ ...ok, properties: { ...ok.properties, a: { type: "integer", enum: [1] } } }, "/a: enum that is not a string enum"],
      [{ ...ok, properties: { ...ok.properties, a: { anyOf: [{ type: "string" }, { type: "null" }] } } }, "/a: keyword anyOf"],
      [{ ...ok, properties: { ...ok.properties, a: { type: "string", $ref: "#/x" } } }, "/a: keyword $ref"],
      [{ ...ok, patternProperties: {} }, "/: keyword patternProperties"],
      [deep, "/a/*/b/*: depth > 4"],
      [{ ...ok, properties: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, { type: "string" }])), required: Array.from({ length: 31 }, (_, i) => `p${i}`) }, "/: 31 properties > 30"],
    ];
    for (const [schema, want] of cases) expect(lintToolSchema(schema), want).toContain(want);
  });
});
