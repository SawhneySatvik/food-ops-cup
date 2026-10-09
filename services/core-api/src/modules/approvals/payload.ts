// Draft payloads (R26, contracts shared/draft.ts). A draft payload holds, at each numeric leaf, either the
// proposed Ref or a person's `{value, typed_by}`. Executing it means substituting each Ref with its snapshot
// cell (read from the database, never from the payload text) and each edit with its typed value; the
// command schema then validates the result.
import { Ref } from "@munim/contracts";
import { cellOf, type Cell, type LoadedSnapshot, snapIdOf } from "./snapshots.ts";

export type Leaf = { path: string; ref: string } | { path: string; value: unknown; typed_by: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEdit = (v: unknown): v is { value: unknown; typed_by: unknown } =>
  isObj(v) && Object.keys(v).length === 2 && "value" in v && "typed_by" in v;
const isRef = (v: unknown): v is string => typeof v === "string" && Ref.safeParse(v).success;
const seg = (k: string | number) => `/${String(k).replaceAll("~", "~0").replaceAll("/", "~1")}`;

/** Every Ref and person edit in a payload, by JSON Pointer. */
export function leaves(v: unknown, path = ""): Leaf[] {
  if (isRef(v)) return [{ path, ref: v }];
  if (isEdit(v)) return [{ path, value: v.value, typed_by: v.typed_by }];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, path + seg(i)));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => leaves(x, path + seg(k)));
  return [];
}

export const snapshotIdsOf = (payload: unknown): string[] =>
  leaves(payload).flatMap((l) => ("ref" in l ? [snapIdOf(l.ref)].filter((x): x is string => x !== null) : []));

export type EditProblem = "typed_by_not_approver" | "ref_changed";

/** A person's edit (approve edited): every typed value is labelled as the approver's, and every Ref left in
 *  place is the very ref the draft proposed at that path — an edit cannot swap in a different citation. */
export function checkEdit(edited: unknown, proposed: unknown, approver: string): EditProblem | null {
  const before = new Map(leaves(proposed).flatMap((l) => ("ref" in l ? [[l.path, l.ref] as const] : [])));
  for (const l of leaves(edited)) {
    if ("ref" in l) {
      if (before.get(l.path) !== l.ref) return "ref_changed";
    } else if (l.typed_by !== approver) return "typed_by_not_approver";
  }
  return null;
}

export type Resolved = { ok: true; payload: Record<string, unknown> } | { ok: false; unresolved: string[] };

/** Substitutes snapshot cells for Refs and typed values for edits. Integer-typed cells become numbers;
 *  anything that does not resolve for this viewer (cite refs included, W1) is reported, never guessed. */
export function resolvePayload(payload: Record<string, unknown>, snaps: Map<string, LoadedSnapshot>): Resolved {
  const unresolved: string[] = [];
  const sub = (v: unknown): unknown => {
    if (isRef(v)) {
      const c = cellOf(v, snaps);
      if (!c) unresolved.push(v);
      // A bigint cell may be stored as a decimal string; an integer column becomes a number when safe.
      if (c?.type === "integer" && typeof c.value === "string" && /^-?[0-9]+$/.test(c.value) && Number.isSafeInteger(Number(c.value))) {
        return Number(c.value);
      }
      return c?.value ?? null;
    }
    if (isEdit(v)) return v.value;
    if (Array.isArray(v)) return v.map(sub);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  const out = sub(payload) as Record<string, unknown>;
  return unresolved.length ? { ok: false, unresolved } : { ok: true, payload: out };
}

/** `resolved_refs` for DraftView: each resolvable Ref with its cell, shown beside the value (R26). */
export function resolvedRefs(payload: unknown, snaps: Map<string, LoadedSnapshot>): { resolved: Array<{ path: string; ref: string; value: Cell }>; unresolved: string[] } {
  const resolved: Array<{ path: string; ref: string; value: Cell }> = [];
  const unresolved: string[] = [];
  for (const l of leaves(payload)) {
    if (!("ref" in l)) continue;
    const c = cellOf(l.ref, snaps);
    if (c) resolved.push({ path: l.path, ref: l.ref, value: c.value });
    else unresolved.push(l.ref);
  }
  return { resolved, unresolved };
}
