import { describe, expect, it } from "vitest";
import fixture from "./fixtures/command-authority.json" with { type: "json" };
import { evaluateAuthority, outletScopeOf, type AuthorityRow } from "../authority/index.ts";

const rows = fixture.rows as AuthorityRow[];
const A = "0192f000-0000-7000-8000-0000000000b1";
const B = "0192f000-0000-7000-8000-0000000000b2";
const CUST = "0192f000-0000-7000-8000-0000000000c9";
const deny = (why: string) => ({ allow: false, reason_code: "authority_denied", why });
const allow = { allow: true };

describe("command authority", () => {
  it("allows a listed role inside its outlet scope", () => {
    expect(evaluateAuthority({ command_type: "catalogue.price.set.v1", role: "manager", outlet_scope: [A], target_outlet_id: A }, rows)).toEqual(allow);
    expect(evaluateAuthority({ command_type: "catalogue.price.set.v1", role: "manager", outlet_scope: ["*"], target_outlet_id: B }, rows)).toEqual(allow);
    expect(evaluateAuthority({ command_type: "catalogue.item.upsert.v1", role: "manager", outlet_scope: ["*"] }, rows)).toEqual(allow);
    expect(evaluateAuthority({ command_type: "tenancy.provision.v1", role: "operator", outlet_scope: ["*"] }, rows)).toEqual(allow);
  });

  it("denies an unknown command, a role not listed, and an outlet outside scope", () => {
    expect(evaluateAuthority({ command_type: "orders.teleport.v1", role: "owner", outlet_scope: ["*"], target_outlet_id: A }, rows)).toEqual(deny("unknown_command"));
    expect(evaluateAuthority({ command_type: "catalogue.price.set.v1", role: "staff", outlet_scope: [A], target_outlet_id: A }, rows)).toEqual(deny("role"));
    expect(evaluateAuthority({ command_type: "tenancy.provision.v1", role: "owner", outlet_scope: ["*"] }, rows)).toEqual(deny("role"));
    expect(evaluateAuthority({ command_type: "catalogue.price.set.v1", role: "manager", outlet_scope: [A], target_outlet_id: B }, rows)).toEqual(deny("outlet_scope"));
    expect(evaluateAuthority({ command_type: "catalogue.price.set.v1", role: "manager", outlet_scope: [A] }, rows)).toEqual(deny("outlet_scope"));
  });

  it("tenant scope needs an all-outlet context (as the 0003 guard); unknown scopes fail closed", () => {
    expect(evaluateAuthority({ command_type: "catalogue.item.upsert.v1", role: "manager", outlet_scope: [A] }, rows)).toEqual(deny("outlet_scope"));
    expect(evaluateAuthority({ command_type: "catalogue.item.upsert.v1", role: "owner", outlet_scope: [A, B] }, rows)).toEqual(deny("outlet_scope"));
    expect(evaluateAuthority({ command_type: "demo.mystery.v1", role: "owner", outlet_scope: ["*"], target_outlet_id: A }, rows)).toEqual(deny("unknown_scope"));
  });

  it("own: only the customer's own record", () => {
    const req = { command_type: "customers.profile.update.v1", role: "customer", outlet_scope: [], actor_id: CUST };
    expect(evaluateAuthority({ ...req, target_customer_id: CUST }, rows)).toEqual(allow);
    expect(evaluateAuthority({ ...req, target_customer_id: "0192f000-0000-7000-8000-0000000000c8" }, rows)).toEqual(deny("own"));
    expect(evaluateAuthority(req, rows)).toEqual(deny("own"));
    expect(evaluateAuthority({ ...req, role: "owner", outlet_scope: ["*"], target_customer_id: CUST }, rows)).toEqual(deny("role"));
  });

  it("own_order: only the order's own customer", () => {
    const req = { command_type: "storefront.guest.create.v1", role: "customer", outlet_scope: [A], actor_id: CUST };
    expect(evaluateAuthority({ ...req, order_customer_id: CUST }, rows)).toEqual(allow);
    expect(evaluateAuthority({ ...req, order_customer_id: "0192f000-0000-7000-8000-0000000000c8" }, rows)).toEqual(deny("own_order"));
    expect(evaluateAuthority({ ...req, order_customer_id: null }, rows)).toEqual(deny("own_order"));
  });

  it("max_amount_minor caps the amount (null = no cap); a capped command without an amount is denied", () => {
    const req = { command_type: "orders.refund.v1", role: "manager", outlet_scope: [A], target_outlet_id: A };
    expect(evaluateAuthority({ ...req, amount_minor: 500000 }, rows)).toEqual(allow);
    expect(evaluateAuthority({ ...req, amount_minor: 500001 }, rows)).toEqual(deny("amount"));
    expect(evaluateAuthority(req, rows)).toEqual(deny("amount"));
    expect(evaluateAuthority({ command_type: "orders.place.v1", role: "staff", outlet_scope: [A], target_outlet_id: A, amount_minor: 99_000_000 }, rows)).toEqual(allow);
  });

  it("membership outlet_ids [] means every outlet only for owner, advisor and judge", () => {
    expect(outletScopeOf({ role: "owner", outlet_ids: [] })).toEqual(["*"]);
    expect(outletScopeOf({ role: "judge", outlet_ids: [] })).toEqual(["*"]);
    expect(outletScopeOf({ role: "advisor", outlet_ids: [] })).toEqual(["*"]);
    expect(outletScopeOf({ role: "manager", outlet_ids: [] })).toEqual([]);
    expect(outletScopeOf({ role: "manager", outlet_ids: [A] })).toEqual([A]);
    const scope = outletScopeOf({ role: "manager", outlet_ids: [] });
    expect(evaluateAuthority({ command_type: "catalogue.price.set.v1", role: "manager", outlet_scope: scope, target_outlet_id: A }, rows)).toEqual(deny("outlet_scope"));
  });
});
