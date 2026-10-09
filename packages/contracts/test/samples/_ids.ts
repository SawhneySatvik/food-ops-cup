// Canonical sample building blocks: lowercase UUIDv7 ids, offset timestamps, refs.
import { citeRef, snapRef } from "../../src/shared/refs.ts";

export const u = (n: number) => `0199e0a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
/** Whole seconds, IST offset. */
export const T = "2026-10-09T10:15:00+05:30";
/** Fractional seconds and an explicit +00:00 offset, as Postgres renders timestamptz in JSON. */
export const T_PG = "2026-10-09T04:45:00.123456+00:00";
/** UTC with Z. */
export const T_Z = "2026-10-09T04:45:00Z";
export const JWT = "eyJhbGciOiJFZERTQSJ9.eyJydW5faWQiOiJ4In0.c2lnbmF0dXJl";
export const S1 = u(900);
export const TENANT = u(1);
export const OUTLET = u(2);
export const MEMBER = u(8);
export { citeRef, snapRef };
