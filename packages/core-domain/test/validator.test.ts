import type { ParsedRef } from "@munim/contracts";
import { describe, expect, it } from "vitest";
import { validateDraft, validateFinding, validateSegments, type RefResolver, type Resolution } from "../envelope/index.ts";

const S1 = "0192f000-0000-7000-8000-000000000001"; // snapshot in this tenant: 2 rows, columns total + outlet_name
const S_OTHER = "0192f000-0000-7000-8000-0000000000ee"; // snapshot of another tenant
const S_NONE = "0192f000-0000-7000-8000-0000000000ff"; // no such snapshot
const ROW = "0192f000-0000-7000-8000-000000000002";
const MSG = "0192f000-0000-7000-8000-000000000003"; // a message whose text is 42 characters long

// In-memory resolver standing in for core-api's DB-backed one (the port's only job is to answer per ref).
const resolver: RefResolver = {
  async resolve(ref: ParsedRef): Promise<Resolution> {
    if (ref.kind === "snap") {
      if (ref.snapshot_id === S_OTHER) return { status: "other_tenant" };
      if (ref.snapshot_id !== S1 || ref.row > 1 || !["total", "outlet_name"].includes(ref.column)) return { status: "missing" };
      return { status: "ok" };
    }
    if (ref.kind === "row" && ref.id === `core.supplier:${ROW}`) return { status: "ok" };
    if (ref.kind === "msg" && ref.id === MSG) return { status: "ok", text_length: 42 };
    return { status: "missing" };
  },
};

const snap = (id: string, row: number, col: string) => `⟨snap:${id}·${row}·${col}⟩`;
const OK_TEXT = `Sales at ${snap(S1, 0, "outlet_name")} were ${snap(S1, 0, "total")} per ⟨cite:row:core.supplier:${ROW}⟩.`;
const OK_REFS = [`snap:${S1}`, `row:core.supplier:${ROW}`];
const abstain = (reason_code: string, ref: string | null) => ({ ok: false, abstained: true, reason_code, ref });

describe("envelope validator (04 §4 checks 1–5)", () => {
  it("ok: every ref resolves in-tenant, grammar clean, refs declared", async () => {
    expect(await validateSegments([{ text: OK_TEXT, refs: OK_REFS }], resolver)).toEqual({ ok: true });
    const quoted = `The supplier wrote “⟨cite:msg:${MSG}·0-42⟩”.`;
    expect(await validateSegments([{ text: quoted, refs: [`msg:${MSG}`] }], resolver)).toEqual({ ok: true });
  });

  it("forged ref (malformed token) → unresolved_ref", async () => {
    const forged = "⟨snap:S1·0·total⟩";
    expect(await validateSegments([{ text: `Sales were ${forged}.`, refs: [] }], resolver)).toEqual(abstain("unresolved_ref", null)); // never echo raw model text
  });

  it("unresolved ref (no such snapshot, row or column) → unresolved_ref", async () => {
    for (const r of [snap(S_NONE, 0, "total"), snap(S1, 2, "total"), snap(S1, 0, "margin")]) {
      const id = `snap:${r.slice(6, 42)}`;
      expect(await validateSegments([{ text: `Sales were ${r}.`, refs: [id] }], resolver)).toEqual(abstain("unresolved_ref", r));
    }
  });

  it("cross-tenant ref → cross_tenant_ref", async () => {
    const r = snap(S_OTHER, 0, "total");
    expect(await validateSegments([{ text: `Sales were ${r}.`, refs: [`snap:${S_OTHER}`] }], resolver)).toEqual(abstain("cross_tenant_ref", r));
  });

  it("quote mismatch: span past the source, empty span, span on a non-text source → quote_mismatch", async () => {
    for (const r of [`⟨cite:msg:${MSG}·0-43⟩`, `⟨cite:msg:${MSG}·5-5⟩`, `⟨cite:row:core.supplier:${ROW}·0-4⟩`]) {
      const id = r.startsWith("⟨cite:msg") ? `msg:${MSG}` : `row:core.supplier:${ROW}`;
      expect(await validateSegments([{ text: `They wrote ${r}.`, refs: [id] }], resolver)).toEqual(abstain("quote_mismatch", r));
    }
  });

  it("missing ref: a segment with no ref → missing_ref", async () => {
    expect(await validateSegments([{ text: OK_TEXT, refs: OK_REFS }, { text: "Sales look healthy this week.", refs: [] }], resolver)).toEqual(
      abstain("missing_ref", null),
    );
  });

  it("a ref used in text but not declared in refs[] → unresolved_ref", async () => {
    expect(await validateSegments([{ text: OK_TEXT, refs: [`snap:${S1}`] }], resolver)).toEqual(abstain("unresolved_ref", `⟨cite:row:core.supplier:${ROW}⟩`));
  });

  it("number grammar violation → number_grammar", async () => {
    expect(await validateSegments([{ text: `Sales rose 12 times at ${snap(S1, 0, "outlet_name")}.`, refs: [`snap:${S1}`] }], resolver)).toEqual(
      abstain("number_grammar", null),
    );
  });

  it("finding: impact_ref must be a resolving snapshot cell", async () => {
    const segments = [{ text: OK_TEXT, refs: OK_REFS }];
    expect(await validateFinding({ segments, impact_ref: snap(S1, 1, "total") }, resolver)).toEqual({ ok: true });
    expect(await validateFinding({ segments, impact_ref: null }, resolver)).toEqual(abstain("missing_ref", null));
    expect(await validateFinding({ segments, impact_ref: snap(S1, 9, "total") }, resolver)).toEqual(abstain("unresolved_ref", snap(S1, 9, "total")));
  });

  it("draft: every numeric payload field is a ref, refs and based_on cells resolve", async () => {
    const based_on = [snap(S1, 0, "total")];
    const payload = { outlet_id: ROW, lines: [{ ingredient_id: ROW, qty_milli: snap(S1, 1, "total") }] };
    expect(await validateDraft({ payload, based_on }, resolver)).toEqual({ ok: true });
    expect(await validateDraft({ payload: { lines: [{ qty_milli: 5 }] }, based_on }, resolver)).toEqual(abstain("missing_ref", null));
    expect(await validateDraft({ payload: { qty_milli: snap(S_OTHER, 0, "total") }, based_on }, resolver)).toEqual(abstain("cross_tenant_ref", snap(S_OTHER, 0, "total")));
    expect(await validateDraft({ payload, based_on: [snap(S_NONE, 0, "total")] }, resolver)).toEqual(abstain("unresolved_ref", snap(S_NONE, 0, "total")));
    // A ref buried in a longer string is not a ref: refused, never resolved or echoed.
    expect(await validateDraft({ payload: { note: `see ${snap(S_OTHER, 0, "total")}` }, based_on }, resolver)).toEqual(abstain("unresolved_ref", null));
    expect(await validateDraft({ payload: { barcode: "8901234567890" }, based_on }, resolver)).toEqual({ ok: true });
  });
});
