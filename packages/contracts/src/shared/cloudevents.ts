// CloudEvents 1.0 envelope (03-architecture §1.6): outbox → publisher → intel `/events`.
// type = "munim.<module>.<entity>.<past-tense-verb>.v<N>", source = "/tenants/<tenant_id>/<module>",
// subject = entity id; extensions `tenantid` and `munimrun` (run token). Extension names are lowercase
// alphanumerics per the CloudEvents attribute-naming rule.
// Event data carries ids and categorical fields only — never amounts or quantities: intel reads numbers
// solely through snapshots, so an event can never be a numeric source.
import { z } from "zod";
import { IsoDateTime, Uuid7 } from "./primitives.ts";
import { CompactJwt } from "./run-token.ts";

export const EVENT_TYPE_PATTERN = /^munim\.[a-z][a-z_]*\.[a-z][a-z_]*\.[a-z][a-z_]*\.v[1-9][0-9]*$/;
const SOURCE_PATTERN = /^\/tenants\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[a-z][a-z_]*$/;

const attributes = {
  specversion: z.literal("1.0"),
  id: Uuid7,
  time: IsoDateTime,
  datacontenttype: z.literal("application/json"),
  /** Extension: tenant id. */
  tenantid: Uuid7,
  /** Extension: run token minted at publish (03-architecture §1.7). */
  munimrun: CompactJwt,
};

/** Any Munim CloudEvent (data unconstrained here; each event type pins its own data schema). */
export const CloudEvent = z.strictObject({
  ...attributes,
  source: z.string().regex(SOURCE_PATTERN),
  type: z.string().regex(EVENT_TYPE_PATTERN),
  subject: Uuid7,
  data: z.record(z.string(), z.unknown()),
});
export type CloudEvent = z.infer<typeof CloudEvent>;

/** A typed CloudEvent for one event type. `module` pins the source path segment. */
export function cloudEvent<T extends string, D extends z.ZodType>(type: T, module: string, data: D) {
  if (!EVENT_TYPE_PATTERN.test(type) || type.split(".")[1] !== module)
    throw new Error(`cloudEvent: '${type}' is not munim.${module}.<entity>.<verb>.v<N>`);
  return z.strictObject({
    ...attributes,
    source: z.string().regex(new RegExp(`^/tenants/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/${module}$`)),
    type: z.literal(type),
    subject: Uuid7,
    data,
  });
}
