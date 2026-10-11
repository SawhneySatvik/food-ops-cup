// Shared parts of the W4 read routes (T-092). Reads of rows under the member's own RLS context: no aggregate and no
// count is computed here (R26 — those are snapshot cells), pages are `{ items, next_cursor }` with a uuid keyset
// (`id DESC`, uuidv7 = creation order), and a malformed filter or cursor is 400 before any SQL runs.
import type { Context, Hono } from "hono";
import { contextOf } from "../auth/resolve.ts";
import { ApiError, errorBody } from "./errors.ts";
import { withContext } from "./db.ts";
import type { AppEnv } from "./types.ts";
import type { Queryable } from "../runtoken/index.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type Member = Extract<AppEnv["Variables"]["principal"], { kind: "member" }>;

export function memberOf(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

export const readAs = <T>(c: Context<AppEnv>, fn: (db: Queryable) => Promise<T>): Promise<T> =>
  withContext(c.var.deps.pools.core, contextOf(memberOf(c)), fn);

/** Optional uuid query value (400 when present and malformed). */
export function optUuid(c: Context<AppEnv>, name: string): string | null {
  const v = c.req.query(name);
  if (v === undefined) return null;
  if (!UUID_RE.test(v)) throw new ApiError("bad_request");
  return v;
}

/** Optional real calendar date (YYYY-MM-DD). */
export function optDate(c: Context<AppEnv>, name: string): string | null {
  const v = c.req.query(name);
  if (v === undefined) return null;
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new ApiError("bad_request");
  return v;
}

export function optEnum<T extends string>(c: Context<AppEnv>, name: string, allowed: readonly T[]): T | null {
  const v = c.req.query(name);
  if (v === undefined) return null;
  if (!(allowed as readonly string[]).includes(v)) throw new ApiError("bad_request");
  return v as T;
}

export function limitOf(c: Context<AppEnv>, def = 50, max = 200): number {
  const v = c.req.query("limit");
  const n = v === undefined ? def : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ApiError("bad_request");
  return n;
}

/** Keyset cursor = the last item's id (a uuid), or 400. */
export const cursorOf = (c: Context<AppEnv>): string | null => optUuid(c, "cursor");

/** `rows` fetched with LIMIT limit+1: the page and the cursor of its last row (null on the last page). */
export function page<T>(rows: Array<Record<string, any>>, limit: number, map: (r: Record<string, any>) => T): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  return { items: items.map(map), next_cursor: rows.length > limit ? (items[items.length - 1]!.id as string) : null };
}

/** An outlet outside the member's scope reads as not found, before any row is touched (gotcha 16). */
export function inScope(m: Member, outlet: string): void {
  if (m.outlet_ids !== "*" && !m.outlet_ids.includes(outlet)) throw new ApiError("not_found");
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
export const int = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The read paths of a module answer 405 (with Allow) to the verbs they do not serve. Hono answers an unmatched
 *  method with 404, and a registered PUT/PATCH/DELETE handler would be a mounted route the OpenAPI document does not
 *  list (R43), so this is `.all` (which that gate ignores), registered after the module's real handlers. The body is
 *  the shared error body (`bad_request`; the contracts error enum has no method code). */
export function methodGuard<A extends Hono<AppEnv>>(app: A, paths: ReadonlyArray<readonly [path: string, allow: string]>): A {
  for (const [path, allow] of paths) app.all(path, (c) => c.json(errorBody("bad_request"), 405, { Allow: allow }));
  return app;
}
