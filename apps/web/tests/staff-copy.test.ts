// file: tests/staff-copy.test.ts
// [unit] Staff copy for refusals the mock cannot produce: each is a stubbed answer run through Cobnut's parseError,
// then the staff copy. A refusal with a reason gets that reason's line, never a generic one or the server's message.
import { describe, expect, it } from "vitest";
import { parseError } from "@/lib/munim/client";
import { staffErrorText, staffWriteErrorText } from "@/lib/munim/staff-copy";

const answer = (status: number, code: string, reason: string | null) =>
  parseError(new Response(null, { status }), { error: { code, message: "A server message is never shown.", reason_code: reason } });

describe("staff copy by code and reason (stubbed answers)", () => {
  it("422 invalid_payload + listing_expired", () => {
    const e = answer(422, "invalid_payload", "listing_expired");
    expect(e.kind).toBe("refusal");
    expect(staffWriteErrorText(e, "cares")).toBe("The pickup time has passed. Choose a later time.");
  });
  it("422 invalid_payload + recipient_ineligible", () =>
    expect(staffWriteErrorText(answer(422, "invalid_payload", "recipient_ineligible"), "cares")).toBe("That simulated recipient can't take this food. Choose another."));
  it("422 invalid_payload + reason_required", () =>
    expect(staffWriteErrorText(answer(422, "invalid_payload", "reason_required"), "counter")).toBe("Choose a reason first."));
  it("422 invalid_payload without a reason is the generic line", () =>
    expect(staffErrorText(answer(422, "invalid_payload", null), "cares")).toBe("That didn't work. Please check and try again."));
  it("409 stale_draft", () =>
    expect(staffWriteErrorText(answer(409, "stale_draft", "stale_draft"), "inbox")).toBe("The numbers behind this changed since it was proposed. It can no longer be approved or rejected; a new proposal will replace it."));
});
