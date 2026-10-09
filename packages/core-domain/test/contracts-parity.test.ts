// Every refusal code core-domain returns is a contracts ReasonCode (W1 fix #56), so core-api can compose the
// shown text from i18n by code.
import { REASON_CODES } from "@munim/contracts";
import { describe, expect, it } from "vitest";
import { RECIPE_REFUSAL_CODES } from "../inventory/index.ts";
import { PACK_REFUSAL_CODES } from "../packs/index.ts";

describe("contracts parity", () => {
  it("every refusal code core-domain returns is a contracts ReasonCode", () => {
    const ours = [...PACK_REFUSAL_CODES, ...RECIPE_REFUSAL_CODES];
    expect(ours.length).toBe(6);
    expect(ours.filter((c) => !(REASON_CODES as readonly string[]).includes(c))).toEqual([]);
  });
});
