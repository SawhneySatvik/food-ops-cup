// The model-facing schema transform (ADR-014 §5.2, review minor 4). A contract schema (zod → JSON Schema) is the
// authority; what a model sees is derived from it deterministically, so the two cannot drift:
//   • a Ref leaf becomes a handle string (no pattern) — the tool layer expands it to a canonical ⟨snap:…⟩ / ⟨cite:…⟩;
//     a bare RefId leaf (`snap:<id>`, `row:…`) becomes an S<n> / D<n> handle;
//   • a uuid leaf naming an existing entity becomes a cell handle that expands to the cell's literal value;
//     a snapshot / finding id becomes an S<n> / F<n> handle;
//   • a new-entity id is removed: the tool layer mints it (§5.5); a tool-filled field is removed too;
//   • `T | null` becomes `type: [T, "null"]`; a union of strings collapses to one described string; anything else throws;
//   • any other string whose pattern embeds a uuid throws: the model never types an id;
//   • arrays get `maxItems` (the contract's own limit, else 50); optional properties become required + nullable.
// No per-provider emitters: ADK converts these schemas (review minor 4). Anything the transform does not know fails
// closed at generation time.
import { UUID7_PATTERN } from "../shared/primitives.ts";
import { REF_ID_SOURCE, REF_SOURCE } from "../shared/refs.ts";

export type Json = Record<string, unknown>;
/** How the tool layer fills a contract leaf from the model's arguments. */
export type LeafKind = "ref" | "ref_id" | "entity" | "snapshot" | "finding" | "minted" | "fixed";
export type Leaf = { path: string; kind: LeafKind; nullable: boolean };
export type Transformed = { schema: Json; leaves: Leaf[]; optional: string[] };

/** JSON pointers (array elements as `*`) whose uuid leaves are not existing-entity ids. */
export interface LeafOverrides {
  minted?: readonly string[];
  snapshot?: readonly string[];
  finding?: readonly string[];
  fixed?: readonly string[];
}

const REF_PATTERN = `^${REF_SOURCE}$`;
const REF_ID_PATTERN = `^${REF_ID_SOURCE}$`;
const UUID_PATTERN = `^${UUID7_PATTERN}$`;
export const DEFAULT_MAX_ITEMS = 50;

export const DESCRIBE: Record<"ref" | "ref_id" | "entity" | "snapshot" | "finding", string> = {
  ref: "Handle of the snapshot cell holding this value, e.g. S1.r0.<column> (or a document handle D<n>). Never type the value.",
  ref_id: "Handle of the snapshot (S<n>) or document (D<n>) this rests on, e.g. S1.",
  entity: "Handle of the snapshot cell holding this id, e.g. S1.r0.<column>. Never type an id.",
  snapshot: "Handle of a snapshot minted in this run, e.g. S1.",
  finding: "Handle of a finding in this run, e.g. F1.",
};

const fail = (path: string, why: string): never => {
  throw new Error(`ontology transform: ${why} at ${path || "/"} (fail closed)`);
};

function nullable(schema: Json): Json {
  const t = schema.type;
  if (Array.isArray(t)) return schema;
  const out: Json = { ...schema, type: [t, "null"] };
  if (Array.isArray(schema.enum)) out.enum = [...(schema.enum as unknown[]), null];
  return out;
}

function stringForm(node: Json): string {
  if (Array.isArray(node.enum)) return `one of ${(node.enum as string[]).join(", ")}`;
  if (typeof node.const === "string") return node.const;
  if (typeof node.pattern === "string") return `text matching ${node.pattern}`;
  return "text";
}

type Ctx = { ov: LeafOverrides; leaves: Leaf[]; optional: string[]; numbers: boolean };

function uuidLeaf(path: string, ctx: Ctx, isNull: boolean): Json | null {
  const { ov } = ctx;
  const kind: LeafKind = ov.minted?.includes(path)
    ? "minted"
    : ov.fixed?.includes(path)
      ? "fixed"
      : ov.snapshot?.includes(path)
        ? "snapshot"
        : ov.finding?.includes(path)
          ? "finding"
          : "entity";
  ctx.leaves.push({ path, kind, nullable: isNull });
  if (kind === "minted" || kind === "fixed") return null;
  return { type: "string", description: DESCRIBE[kind] };
}

function walk(node: Json, path: string, ctx: Ctx, isNull = false): Json | null {
  // `type: [T, "null"]` (migration-authored params) is the same as anyOf [T, null].
  if (Array.isArray(node.type)) {
    const types = (node.type as string[]).filter((t) => t !== "null");
    if (types.length !== 1) fail(path, `type union ${JSON.stringify(node.type)}`);
    const { type: _t, ...rest } = node;
    const inner = walk({ ...rest, type: types[0] }, path, ctx, node.type.length > 1 || isNull);
    return inner && node.type.length > 1 ? nullable(inner) : inner;
  }
  if (Array.isArray(node.anyOf)) {
    const members = node.anyOf as Json[];
    const nonNull = members.filter((m) => m.type !== "null");
    const hasNull = nonNull.length < members.length || isNull;
    if (nonNull.length === 1) {
      const inner = walk(nonNull[0]!, path, ctx, hasNull);
      return inner && hasNull ? nullable(inner) : inner;
    }
    // A union of plain strings (e.g. channel_kind: an enum or `aggregator:<name>`) → one described string. A Ref or
    // uuid inside such a union would lose its handle meaning, so it fails closed.
    if (nonNull.every((m) => m.type === "string" && !(typeof m.pattern === "string" && m.pattern.includes(UUID7_PATTERN)) && m.format !== "uuid")) {
      const s: Json = { type: "string", description: `One of these forms: ${nonNull.map(stringForm).join("; ")}.` };
      return hasNull ? nullable(s) : s;
    }
    return fail(path, "anyOf that is neither T | null nor a union of strings");
  }
  if (node.oneOf || node.allOf || node.$ref || node.not) fail(path, "oneOf/allOf/$ref/not");
  switch (node.type) {
    case "string": {
      if (node.pattern === REF_PATTERN) {
        ctx.leaves.push({ path, kind: "ref", nullable: isNull });
        return { type: "string", description: DESCRIBE.ref };
      }
      if (node.pattern === REF_ID_PATTERN) {
        ctx.leaves.push({ path, kind: "ref_id", nullable: isNull });
        return { type: "string", description: DESCRIBE.ref_id };
      }
      if (node.pattern === UUID_PATTERN || node.format === "uuid") return uuidLeaf(path, ctx, isNull);
      if (typeof node.pattern === "string" && node.pattern.includes(UUID7_PATTERN)) fail(path, "a pattern embedding a uuid that is not a Ref, RefId or id");
      if (Array.isArray(node.enum)) {
        if ((node.enum as unknown[]).some((v) => typeof v !== "string")) fail(path, "non-string enum");
        return { type: "string", enum: node.enum };
      }
      if (typeof node.const === "string") return { type: "string", enum: [node.const] };
      if (node.format === "date") return { type: "string", description: "A calendar date, YYYY-MM-DD." };
      if (node.format === "date-time") return { type: "string", description: "An ISO-8601 date-time with an offset, e.g. YYYY-MM-DDThh:mm:ss+05:30." };
      const limits = [
        typeof node.minLength === "number" ? `at least ${node.minLength} characters` : "",
        typeof node.maxLength === "number" ? `at most ${node.maxLength} characters` : "",
      ].filter(Boolean);
      if (typeof node.pattern === "string") return { type: "string", description: `Text matching ${node.pattern}${limits.length ? `, ${limits.join(", ")}` : ""}.` };
      return limits.length ? { type: "string", description: `Text, ${limits.join(", ")}.` } : { type: "string" };
    }
    case "boolean":
      return { type: "boolean" };
    case "integer":
    case "number": {
      // A proposal never has a numeric leaf (draft.ts makes every one a Ref); template params may (shape only).
      if (!ctx.numbers) fail(path, "numeric leaf in a proposal");
      return { type: node.type };
    }
    case "object": {
      const props = (node.properties ?? {}) as Record<string, Json>;
      if (node.additionalProperties !== undefined && node.additionalProperties !== false) fail(path, "open object");
      const required = new Set((node.required ?? []) as string[]);
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(props)) {
        const p = `${path}/${k}`;
        const opt = !required.has(k);
        const child = walk(v, p, ctx, opt);
        if (child === null) continue;
        if (opt) ctx.optional.push(p);
        out[k] = opt ? nullable(child) : child;
      }
      return { type: "object", properties: out, required: Object.keys(out), additionalProperties: false };
    }
    case "array": {
      if (typeof node.items !== "object" || node.items === null || Array.isArray(node.items)) fail(path, "array without one items schema");
      const items = walk(node.items as Json, `${path}/*`, ctx);
      if (items === null) return fail(path, "array of removed leaves");
      return {
        type: "array",
        items,
        ...(typeof node.minItems === "number" ? { minItems: node.minItems } : {}),
        maxItems: typeof node.maxItems === "number" ? node.maxItems : DEFAULT_MAX_ITEMS,
      };
    }
    default:
      return fail(path, `unsupported node ${JSON.stringify(Object.keys(node))}`);
  }
}

/** Transform a contract JSON Schema (an object) into the model-facing schema plus the leaf map the tool layer uses. */
export function toModelSchema(contract: Json, ov: LeafOverrides = {}, opts: { numbers?: boolean } = {}): Transformed {
  const ctx: Ctx = { ov, leaves: [], optional: [], numbers: opts.numbers ?? false };
  const schema = walk(contract, "", ctx);
  if (schema === null || schema.type !== "object") return fail("", "root is not an object");
  for (const list of [ov.minted, ov.fixed, ov.snapshot, ov.finding]) {
    for (const p of list ?? []) if (!ctx.leaves.some((l) => l.path === p)) fail(p, "override names no uuid leaf");
  }
  return { schema, leaves: ctx.leaves, optional: ctx.optional };
}

/** Tool names come from contract names, never from generated class names (R3-m10). */
export const readToolName = (templateId: string) => `read_${templateId.replaceAll(".", "_")}`;
export const proposeToolName = (commandType: string) => `propose_${commandType.replace(/\.v[1-9][0-9]*$/, "").replaceAll(".", "_")}`;
