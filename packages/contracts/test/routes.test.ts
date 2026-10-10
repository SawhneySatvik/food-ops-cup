// R3-m1: no two contracts routes share "METHOD path" (parameter names ignored) or an operationId. The generator
// builds `paths` last-wins, so a duplicate silently drops one operation.
import { describe, expect, it } from "vitest";
import { assertUniqueRoutes, loadRegistry } from "../src/registry.ts";
import type { Route } from "../src/shared/routes.ts";

const base: Route = { surface: "public", method: "post", path: "/platform/v1/snapshots", operationId: "a", summary: "s", auth: "operator", response: "snapshot", status: 201 };

describe("route uniqueness", () => {
  it("the real registry is unique and non-trivial", async () => {
    const reg = await loadRegistry();
    expect(reg.routes.length).toBeGreaterThan(150);
    expect(() => assertUniqueRoutes(reg.routes)).not.toThrow();
    expect(reg.routes.filter((r) => r.method === "post" && r.path === "/platform/v1/snapshots")).toHaveLength(1);
  });
  it("RED-PROOF: the same method + path under another operationId throws (the old intel duplicate)", () => {
    expect(() => assertUniqueRoutes([base, { ...base, operationId: "b" }])).toThrow(/declared by both/);
  });
  it("RED-PROOF: different parameter names on the same path collide", () => {
    const get = (path: string, operationId: string): Route => ({ ...base, method: "get", path, operationId });
    expect(() => assertUniqueRoutes([get("/v1/orders/{id}", "x"), get("/v1/orders/{order_id}", "y")])).toThrow(/declared by both/);
  });
  it("RED-PROOF: a repeated operationId throws; distinct methods on one path are fine", () => {
    expect(() => assertUniqueRoutes([base, { ...base, path: "/other" }])).toThrow(/duplicate operationId/);
    expect(() => assertUniqueRoutes([base, { ...base, method: "get", operationId: "b" }])).not.toThrow();
  });
});
