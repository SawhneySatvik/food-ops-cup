import { describe, expect, it } from "vitest";
import cases from "./fixtures/grammar-cases.json" with { type: "json" };
import { checkGrammar } from "../envelope/index.ts";

const classify = (text: string) => {
  const r = checkGrammar(text);
  return r.ok ? "accept" : r.rule;
};

describe("number grammar: committed table", () => {
  it("has 30 must-reject and 10 must-accept cases", () => {
    expect(cases.reject.length).toBe(30);
    expect(cases.accept.length).toBe(10);
  });

  for (const c of cases.reject) it(`${c.id} rejects as ${c.rule}`, () => expect(classify(c.text)).toBe(c.rule));
  for (const c of cases.accept) it(`${c.id} accepts`, () => expect(classify(c.text)).toBe("accept"));

  it("30/30 rejected with the committed rule, 10/10 accepted", () => {
    const rejected = cases.reject.filter((c) => classify(c.text) === c.rule).length;
    const accepted = cases.accept.filter((c) => classify(c.text) === "accept").length;
    expect({ rejected, accepted }).toEqual({ rejected: 30, accepted: 10 });
  });
});

// Plural magnitude words: rejected only because @munim/contracts/grammar lists them (added to contracts
// 9 Oct 23:46); the matcher has no s? rule.
describe("number grammar: plural magnitude words (contracts data)", () => {
  it("has 7 plural cases", () => expect(cases.reject_pending_contracts.cases.length).toBe(7));
  for (const c of cases.reject_pending_contracts.cases) it(`${c.id} rejects as ${c.rule}`, () => expect(classify(c.text)).toBe(c.rule));
});
