// Gate: every error body the app can emit parses as the contract's ErrorResponse, and every Munim SQLSTATE
// in db/README.md (read independently) maps to its own non-null error code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorResponse } from "@munim/contracts";
import { describe, expect, it } from "vitest";
import { APPROVAL_ERROR_CODES, DraftDecisionError } from "@munim/contracts/approvals";
import { Hono } from "hono";
import { ApiError, createApp, errorBody, fromSqlState } from "../src/app.ts";
import { CommandTypeMismatch, IdempotencyConflict } from "../src/commit/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { ERROR_CODES } from "../src/lib/errors.ts";
import type pg from "pg";

describe("error envelope", () => {
  it("errorBody(code) parses as the contract's ErrorResponse for every code", () => {
    expect(ERROR_CODES.length).toBeGreaterThanOrEqual(7);
    for (const code of ERROR_CODES) expect(ErrorResponse.safeParse(errorBody(code)).success, code).toBe(true);
    expect(ErrorResponse.safeParse(errorBody("book_write_refused", "authority_denied")).success).toBe(true);
  });

  it("every MB SQLSTATE in db/README.md maps to a distinct error code", () => {
    const readme = readFileSync(join(import.meta.dirname, "../../../db/README.md"), "utf8");
    const states = [...readme.matchAll(/^\| `(MB\d{3})` \| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(states.length).toBe(15);
    const codes = states.map((code) => fromSqlState({ code }));
    for (const [i, e] of codes.entries()) expect([states[i], e instanceof ApiError]).toEqual([states[i], true]);
    expect(new Set(codes.map((e) => e!.code)).size).toBe(states.length);
    expect(fromSqlState({ code: "42P01" })).toBeNull();
  });
});

describe("approval and commit errors (W1 fix #9)", () => {
  it("every approvals error code is in the table and its body (with changes/refs) parses as drafts.decision-error", () => {
    expect(APPROVAL_ERROR_CODES.length).toBe(7);
    for (const code of APPROVAL_ERROR_CODES) {
      expect(ERROR_CODES).toContain(code);
      const body = new ApiError(code, code === "stale_draft" ? "stale_draft" : null).body();
      expect(DraftDecisionError.safeParse(body).success, code).toBe(true);
    }
    const refs = new ApiError("cannot_verify", "unresolved_ref", { refs: ["⟨snap:x·0·qty⟩"] }).body();
    expect(refs.refs).toEqual(["⟨snap:x·0·qty⟩"]);
    expect(DraftDecisionError.safeParse(refs).success).toBe(true);
  });

  it("onError maps IdempotencyConflict → 409 and CommandTypeMismatch → 422 with the fixed bodies", async () => {
    const config = { nodeEnv: "production", redact: (s: string) => s };
    const none = {} as pg.Pool;
    const app = await createApp({ pools: { core: none, svc: none }, idp: createLocalIdp(), storefronts: async () => null, config, log: () => {} });
    app.route("/", new Hono().get("/x/idem", () => { throw new IdempotencyConflict(); }).get("/x/type", () => { throw new CommandTypeMismatch(); }));
    const idem = await app.request("/x/idem");
    expect([idem.status, await idem.json()]).toEqual([409, errorBody("idempotency_conflict")]);
    const type = await app.request("/x/type");
    expect([type.status, await type.json()]).toEqual([422, errorBody("command_type_mismatch")]);
  });
});
