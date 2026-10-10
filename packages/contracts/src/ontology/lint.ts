// Provider lint (ADR-014 §5.2): the portable subset every model-facing tool schema must stay inside. It runs on the
// transformed schemas only — the contract schemas keep their patterns and unions (zod and Pydantic stay the
// authorities). A keyword allow-list rather than a deny-list: a keyword nobody thought of fails here.
import type { Json } from "./transform.ts";

const KEYWORDS = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minItems", "maxItems"]);
const TYPES = new Set(["string", "boolean", "integer", "number", "object", "array"]);
export const MAX_DEPTH = 4;
export const MAX_PROPERTIES = 30;

/** Violations as "<json pointer>: <rule>"; [] when the schema is inside the subset. */
export function lintToolSchema(schema: Json): string[] {
  const out: string[] = [];
  const at = (path: string, rule: string) => out.push(`${path || "/"}: ${rule}`);
  const visit = (node: unknown, path: string, depth: number) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return at(path, "not a schema object");
    const n = node as Json;
    for (const k of Object.keys(n)) if (!KEYWORDS.has(k)) at(path, `keyword ${k}`);
    const t = n.type;
    const nullableType = Array.isArray(t) && t.length === 2 && t[1] === "null" && TYPES.has(t[0] as string);
    const base = nullableType ? (t as string[])[0] : t;
    if (!(typeof base === "string" && TYPES.has(base))) return at(path, `type ${JSON.stringify(t)}`);
    if (n.enum !== undefined) {
      const ok = base === "string" && Array.isArray(n.enum) && n.enum.length > 0 && n.enum.every((v) => typeof v === "string" || (v === null && nullableType));
      if (!ok) at(path, "enum that is not a string enum");
    }
    if (base === "object") {
      if (depth + 1 > MAX_DEPTH) at(path, `depth > ${MAX_DEPTH}`);
      const props = n.properties;
      if (typeof props !== "object" || props === null || Array.isArray(props)) return at(path, "object without properties");
      const keys = Object.keys(props);
      if (keys.length > MAX_PROPERTIES) at(path, `${keys.length} properties > ${MAX_PROPERTIES}`);
      const req = Array.isArray(n.required) ? (n.required as string[]) : [];
      if (req.length !== keys.length || !keys.every((k) => req.includes(k))) at(path, "required is not every property");
      if (n.additionalProperties !== false) at(path, "additionalProperties is not false");
      for (const k of keys) visit((props as Json)[k], `${path}/${k}`, depth + 1);
    } else if (base === "array") {
      if (depth + 1 > MAX_DEPTH) at(path, `depth > ${MAX_DEPTH}`);
      if (typeof n.maxItems !== "number" || n.maxItems < 1) at(path, "array without maxItems");
      visit(n.items, `${path}/*`, depth + 1);
    } else if (n.properties !== undefined || n.items !== undefined) at(path, "properties/items on a scalar");
  };
  visit(schema, "", 0);
  if (schema.type !== "object") at("", "root is not an object");
  return out;
}
