// Findings commands (T-084a, ADR-014 §8): a person dismisses a finding with a reason. `findings.dismiss.v1` is the
// person's own command (never drafted, never intel's); it changes only the finding's status, and the audit entry
// carries the reason code. Reads (`GET /v1/findings`) stay in ../intel.
import { z } from "zod";
import { RejectReasonCode } from "../approvals/index.ts";
import { Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

export const FindingsDismissV1 = z.strictObject({
  finding_id: Uuid7,
  reason_code: RejectReasonCode,
});

export const SCHEMAS = { "findings.dismiss.v1": FindingsDismissV1 };

export const ROUTES: readonly Route[] = [
  { surface: "public", method: "post", path: "/v1/findings/{id}:dismiss", operationId: "dismissFinding", summary: "findings.dismiss.v1 — dismiss an open finding with a reason code (payload finding_id must equal the path id)", auth: "member", command: "findings.dismiss.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
];
