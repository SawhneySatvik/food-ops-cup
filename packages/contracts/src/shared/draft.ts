// Draft payload rule (R26, 04-agent-framework §3 `draft.write`, §4 check 5).
//   • intel proposes:  every numeric leaf of the command payload is a `Ref` — never a typed number.
//   • a person edits:  an edited numeric leaf is `{value, typed_by}` — labelled as typed by that member
//                      (core sets/checks typed_by = the approving member; authority runs on the final payload).
// Both shapes are DERIVED from the command's payload schema so they cannot drift from it. The transforms
// fail closed: a zod node they do not know throws at module load, so a new wrapper type can never smuggle
// a bare number through unchanged.
import { z } from "zod";
import { Uuid7 } from "./primitives.ts";
import { Ref } from "./refs.ts";

/** A value a named member typed while editing a draft (R26). */
export const personEdit = <T extends z.ZodType>(value: T) => z.strictObject({ value, typed_by: Uuid7 });
/** The published integer form (every W1 numeric command field is an integer). */
export const PersonEdit = personEdit(z.int());
export type PersonEdit = z.infer<typeof PersonEdit>;

type Leaf = (numeric: z.ZodType) => z.ZodType;

function derive(schema: z.ZodType, leaf: Leaf, where: string): z.ZodType {
  const def = (schema as any)._zod.def;
  switch (def.type) {
    case "number":
    case "bigint":
      return leaf(schema);
    case "string":
    case "boolean":
    case "null":
      return schema;
    case "enum": {
      const values = Object.values(def.entries as Record<string, unknown>);
      if (values.some((v) => typeof v !== "string")) throw new Error(`draft payload: numeric enum at ${where}`);
      return schema;
    }
    case "literal": {
      if ((def.values as unknown[]).some((v) => typeof v === "number" || typeof v === "bigint"))
        throw new Error(`draft payload: numeric literal at ${where}`);
      return schema;
    }
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries((schema as z.ZodObject).shape)) shape[k] = derive(v as z.ZodType, leaf, `${where}.${k}`);
      const catchall = def.catchall as z.ZodType | undefined;
      if (catchall && (catchall as any)._zod.def.type !== "never") throw new Error(`draft payload: open object at ${where}`);
      return catchall ? z.strictObject(shape) : z.object(shape);
    }
    case "array": {
      let out = z.array(derive(def.element, leaf, `${where}[]`));
      for (const check of def.checks ?? []) {
        const d = check._zod.def;
        if (d.check === "min_length") out = out.min(d.minimum);
        else if (d.check === "max_length") out = out.max(d.maximum);
        else if (d.check === "length_equals") out = out.length(d.length);
        else throw new Error(`draft payload: unsupported array check '${d.check}' at ${where}`);
      }
      return out;
    }
    case "optional":
      return derive(def.innerType, leaf, where).optional();
    case "nullable":
      return derive(def.innerType, leaf, where).nullable();
    // ADR-015 §5: goals.task.create.v1 gains `cares_listing_id: Uuid7.nullable().default(null)`; older proposals omit it.
    // Only a null default: any other default value could be a bare number a person never typed.
    case "default":
      if (def.defaultValue !== null) throw new Error(`draft payload: non-null default at ${where} (fail closed)`);
      return derive(def.innerType, leaf, where).default(null);
    case "union":
      return z.union((def.options as z.ZodType[]).map((o, i) => derive(o, leaf, `${where}|${i}`)) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    default:
      throw new Error(`draft payload: unsupported zod type '${def.type}' at ${where} (fail closed)`);
  }
}

/** Campaign-style template placeholders: an ARRAY of `{key, ref}` — never a record, which the derivations
 *  refuse (fail closed). The renderer substitutes each ref's resolved value for `{key}` in a fixed i18n
 *  template. */
export const Placeholders = z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), ref: Ref })).max(20);

/** The shape intel may send for a command (`internal.drafts.request.payload`): numeric leaves → `Ref`. */
export function toProposal(command: z.ZodType): z.ZodType {
  return derive(command, () => Ref, "$");
}

/** The shape of a draft after people touch it (`drafts.approve.v1.edited_payload`, `v1.draft.payload`):
 *  each numeric leaf is still the proposed `Ref`, or a member's `{value, typed_by}`. */
export function toEditable(command: z.ZodType): z.ZodType {
  return derive(command, (numeric) => z.union([Ref, personEdit(numeric)]), "$");
}
