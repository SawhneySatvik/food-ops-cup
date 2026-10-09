// Gate: the Ref parser accepts / rejects the committed table of 12 strings (fixtures/ref-cases.json).
// The zod schema, parseRef and the exported capture regexes must all agree with the table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CITE_KINDS, CITE_REF_CAPTURE, CiteRef, Ref, RefId, SNAP_REF_CAPTURE, SnapCellRef, anyRefTokens, citeRef, parseRef, refTokens, snapRef } from "../src/shared/refs.ts";

type Case = { label: string; input: string; accept: boolean; parsed?: unknown };
const { cases } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "ref-cases.json"), "utf8")) as { cases: Case[] };

describe("Ref parser — committed table", () => {
  it("has exactly 12 cases, both outcomes, every cite kind and a span", () => {
    expect(cases.length).toBe(12);
    expect(cases.filter((c) => c.accept).length).toBeGreaterThanOrEqual(1);
    expect(cases.filter((c) => !c.accept).length).toBeGreaterThanOrEqual(1);
    const kinds = new Set(cases.filter((c) => c.accept).map((c) => (c.parsed as { kind: string }).kind));
    expect([...CITE_KINDS, "snap"].filter((k) => !kinds.has(k))).toEqual([]);
    expect(cases.some((c) => c.accept && Array.isArray((c.parsed as { span?: unknown }).span))).toBe(true);
  });

  it.each(cases)("$label → accept=$accept", (c) => {
    expect(Ref.safeParse(c.input).success).toBe(c.accept);
    expect(parseRef(c.input)).toEqual(c.accept ? c.parsed : null);
    expect(SNAP_REF_CAPTURE.test(c.input) || CITE_REF_CAPTURE.test(c.input)).toBe(c.accept);
  });

  it("table outcome count: accepts and rejects as committed", () => {
    const got = cases.map((c) => Ref.safeParse(c.input).success);
    console.log(`ref table: ${got.filter(Boolean).length} accepted, ${got.filter((g) => !g).length} rejected of ${cases.length}`);
    expect(got).toEqual(cases.map((c) => c.accept));
  });
});

describe("Ref helpers", () => {
  const S = "0199e0a0-0000-7000-8000-000000000384";
  it("builders produce strings the parsers accept", () => {
    expect(SnapCellRef.safeParse(snapRef(S, 3, "qty")).success).toBe(true);
    expect(CiteRef.safeParse(citeRef("doc", S, [1, 2])).success).toBe(true);
    expect(RefId.safeParse(`row:core.reorder_level:${S}`).success).toBe(true);
    expect(RefId.safeParse("12000").success).toBe(false);
  });
  it("token scanners are stateless across calls and find refs inside prose", () => {
    const t = `on hand ${snapRef(S, 0, "x")} per ${citeRef("msg", S)}`;
    expect([anyRefTokens().test(t), anyRefTokens().test(t)]).toEqual([true, true]);
    expect(t.match(refTokens())?.length).toBe(2);
  });
});
