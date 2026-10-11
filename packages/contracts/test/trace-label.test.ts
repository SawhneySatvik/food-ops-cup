// Defence in depth (rule 8; ADR-014 §6.4 rule 5): core's trace contract refuses a payload value that is prose, on the same
// pattern as intel's `check_payload` (services/intel/munim_intel/trace/buffer.py LABEL): one token, no whitespace, <= 200.
import { describe, expect, it } from "vitest";
import { TraceEventInput } from "../src/shared/trace.ts";

const event = (value: string | string[]) => ({
  id: "01920000-0000-7000-8000-000000000001", seq: 1, parent_id: null, actor: "brief", at: "2026-10-11T00:00:00Z", kind: "tool_call", payload: { tool: value },
});

describe("trace payload labels", () => {
  it.each(["read_below_reorder", "gemini-3.5-flash-lite", "snap:01920000-0000-7000-8000-000000000001", "a".repeat(200), ["one", "two_2"], "1", "12", "123", "3x4500", "2026-10-11", "01920000-0000-7000-8000-000000000001"])(
    "a label passes: %s", (v) => expect(TraceEventInput.safeParse(event(v)).success).toBe(true));
  it.each(["What needs me today?", "net sales were down", "", " leading", "trailing ", "a".repeat(201), "line\nbreak", ["ok", "not ok"], "450000", "4500.50", "1234", ["ok", "450000"]])(
    "prose, empty or over-long refused: %j", (v) => expect(TraceEventInput.safeParse(event(v)).success).toBe(false));
});
