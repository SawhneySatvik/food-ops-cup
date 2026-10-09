// Draftable-command registry (R16, R26). A module that lets intel propose one of its commands registers
// it here from its own `src/<module>/index.ts`:
//     export const PRICE_SET = defineDraftable("catalogue.price.set.v1", CataloguePriceSetV1);
//     SCHEMAS: { …, [`proposal.${PRICE_SET.type}`]: PRICE_SET.proposal }
// The approvals and internal contracts look the command type up here at parse time — an unregistered
// type is refused. Nothing in approvals/ names a module, so W2 module tickets add draftables without
// touching it. A type is registered once its module has been imported; `loadRegistry()` imports every
// module (core-api and gen call it at start-up).
import { z } from "zod";
import { toEditable, toProposal } from "./draft.ts";
import { CommandType } from "./primitives.ts";

export type Draftable = {
  readonly type: string;
  /** The command's payload schema (what executes, after approval). */
  readonly command: z.ZodType;
  /** What intel may send: numeric leaves are refs only. */
  readonly proposal: z.ZodType;
  /** What a draft holds once people touch it: refs or `{value, typed_by}`. */
  readonly editable: z.ZodType;
};

const REGISTRY = new Map<string, Draftable>();

export function defineDraftable(type: string, command: z.ZodType): Draftable {
  if (!CommandType.safeParse(type).success) throw new Error(`defineDraftable: '${type}' is not <module>.<verb>.v<N>`);
  const prev = REGISTRY.get(type);
  if (prev) {
    if (prev.command !== command) throw new Error(`defineDraftable: '${type}' registered twice with different schemas`);
    return prev;
  }
  // Derivations run now: an unsupported zod node fails at module load, never at approval time.
  const d: Draftable = Object.freeze({ type, command, proposal: toProposal(command), editable: toEditable(command) });
  REGISTRY.set(type, d);
  return d;
}

/** The registered draftable for a command type, or undefined (→ the caller refuses). */
export const draftable = (type: string): Draftable | undefined => REGISTRY.get(type);
/** Registered command types, sorted. */
export const draftableTypes = (): string[] => [...REGISTRY.keys()].sort();

export const DRAFT_PAYLOAD_META = "x-munim-draft-payload";
export type DraftPayloadKind = "proposal" | "editable";

/** A draft payload position. In zod it is an object checked by `checkDraftPayload`; in the generated JSON
 *  Schema / Pydantic, gen replaces it with `anyOf` of every registered draftable's proposal (or editable)
 *  schema — so no generated consumer accepts a bare number there either. */
export const draftPayload = (kind: DraftPayloadKind) => z.record(z.string(), z.unknown()).meta({ [DRAFT_PAYLOAD_META]: kind });

/** Refinement: look `command_type` up in the registry and validate the payload field against the
 *  registered proposal / editable schema. Unregistered type → refused. `null` payload (approve as
 *  proposed) only needs the type to be registered. */
export function checkDraftPayload(kind: DraftPayloadKind, field: string) {
  return (v: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const type = v.command_type as string;
    const d = draftable(type);
    if (!d) {
      ctx.addIssue({ code: "custom", path: ["command_type"], message: `'${type}' is not a registered draftable command type` });
      return;
    }
    const payload = v[field];
    if (payload === null) return;
    const r = d[kind].safeParse(payload);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: [field, ...i.path], message: i.message });
  };
}
