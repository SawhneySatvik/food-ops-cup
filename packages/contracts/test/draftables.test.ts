// The draftable registry: approvals and internal contracts validate a draft payload by looking its
// command type up in the registry. An unregistered type is refused; a module registers its own command
// (here: a stand-in "W2 module") without touching approvals.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DraftView, DraftsApproveV1 } from "../src/approvals/index.ts";
import { DraftsRequest } from "../src/internal/index.ts";
import { loadRegistry } from "../src/registry.ts";
import { Placeholders, toProposal } from "../src/shared/draft.ts";
import { defineDraftable, draftableTypes } from "../src/shared/draftables.ts";
import { Uuid7 } from "../src/shared/primitives.ts";
import { snapRef } from "../src/shared/refs.ts";
import { loadSamples, manifestNames } from "./helpers.ts";

await loadRegistry();
const SAMPLES = await loadSamples();
const req = SAMPLES["internal.drafts.request"] as any;
const approve = SAMPLES["drafts.approve.v1"] as any;
const view = SAMPLES["v1.draft"] as any;
const U = "0199e0a0-0000-7000-8000-000000000384";
const issuesAt = (r: z.ZodSafeParseResult<unknown>) => (r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

describe("draftable registry", () => {
  it("the registry is exactly the W1 + W2 draftable set named by MANIFEST (proposal.* entries)", () => {
    const fromManifest = manifestNames().filter((n) => n.startsWith("proposal.")).map((n) => n.slice("proposal.".length)).sort();
    const registered = draftableTypes().filter((t) => !t.startsWith("zzmodule."));
    expect(registered).toEqual(fromManifest);
    // W1's three are still in it, and W2 added to them.
    expect(registered).toEqual(expect.arrayContaining(["catalogue.price.set.v1", "inventory.reorder_level.set.v1", "purchasing.po.create.v1"]));
    expect(registered.length).toBeGreaterThan(3);
    // Each W2 module that proposes registers from its own index (no approvals import names them).
    for (const t of ["goals.goal.create.v1", "people.payroll_draft.create.v1", "imports.run.commit.v1", "finance.journal.adjust.v1"]) expect(registered).toContain(t);
    // A command a person only runs themselves is not in it.
    expect(registered).not.toContain("people.staff.upsert.v1");
  });

  it.each([
    ["internal.drafts.request", () => DraftsRequest.safeParse({ ...req, command_type: "people.staff.upsert.v1" })],
    ["drafts.approve.v1 (edited)", () => DraftsApproveV1.safeParse({ ...approve, command_type: "people.staff.upsert.v1" })],
    ["drafts.approve.v1 (as proposed, null payload)", () => DraftsApproveV1.safeParse({ ...approve, command_type: "people.staff.upsert.v1", edited_payload: null })],
    ["v1.draft", () => DraftView.safeParse({ ...view, command_type: "people.staff.upsert.v1" })],
  ])("unregistered command type is refused: %s", (_l, run) => {
    expect(issuesAt(run())).toEqual(["command_type: 'people.staff.upsert.v1' is not a registered draftable command type"]);
  });

  it("registered types are accepted (paired accepts)", () => {
    expect(DraftsRequest.safeParse(req).success).toBe(true);
    expect(DraftsApproveV1.safeParse(approve).success).toBe(true);
    expect(DraftsApproveV1.safeParse({ ...approve, edited_payload: null }).success).toBe(true);
    expect(DraftView.safeParse(view).success).toBe(true);
  });

  it("a payload is checked against ITS command type (a PO payload under the price type is refused)", () => {
    expect(DraftsRequest.safeParse({ ...req, command_type: "catalogue.price.set.v1" }).success).toBe(false);
  });

  it("a module registers a new draftable without touching approvals; its numbers must be refs", () => {
    const Cmd = z.strictObject({ thing_id: Uuid7, qty_milli: z.int().positive(), placeholders: Placeholders });
    const d = defineDraftable("zzmodule.thing.set.v1", Cmd);
    expect(draftableTypes()).toContain("zzmodule.thing.set.v1");
    expect(defineDraftable("zzmodule.thing.set.v1", Cmd)).toBe(d);
    expect(() => defineDraftable("zzmodule.thing.set.v1", z.strictObject({ thing_id: Uuid7 }))).toThrow(/registered twice/);
    const payload = { thing_id: U, qty_milli: snapRef(U, 0, "qty_milli"), placeholders: [{ key: "dish", ref: snapRef(U, 0, "dish_name") }] };
    const base = { ...req, command_type: "zzmodule.thing.set.v1" };
    expect(DraftsRequest.safeParse({ ...base, payload }).success).toBe(true);
    expect(DraftsRequest.safeParse({ ...base, payload: { ...payload, qty_milli: 5 } }).success).toBe(false);
  });

  it("placeholders are arrays of {key, ref}; a record of placeholders is refused by the derivation", () => {
    expect(() => toProposal(z.strictObject({ placeholders: Placeholders }))).not.toThrow();
    expect(() => toProposal(z.strictObject({ placeholders: z.record(z.string(), z.string()) }))).toThrow(/draft payload/);
    expect(() => defineDraftable("zzmodule.bad.set.v1", z.strictObject({ placeholders: z.record(z.string(), z.int()) }))).toThrow(/draft payload/);
    expect(draftableTypes()).not.toContain("zzmodule.bad.set.v1");
  });

  it("a malformed command type cannot be registered", () => {
    expect(() => defineDraftable("not a type", z.strictObject({}))).toThrow(/not <module>/);
  });
});
