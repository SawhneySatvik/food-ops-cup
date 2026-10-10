// HTTP route descriptors a module publishes; the generator turns them into OpenAPI 3.1 operations.
// `request` / `response` name schemas in the registry (any module). `command` makes the request body the
// typed command envelope `{command_id, idempotency_key, type, payload: <command schema>}`.
export type Surface = "public" | "internal";
/** member: IdP token + X-Munim-Tenant · operator: IdP token · intel: run token + service credential ·
 *  storefront: X-Munim-Storefront-Key (+ an optional customer token) · identity: an IdP token alone, for a
 *  person with no tenant yet (onboarding, "my tenants"). */
export type Auth = "member" | "operator" | "intel" | "storefront" | "identity";
export type QueryParam = { name: string; required: boolean; schema: Record<string, unknown> };
export type Route = {
  surface: Surface;
  method: "get" | "post";
  path: string;
  operationId: string;
  summary: string;
  auth: Auth;
  request?: string;
  command?: string;
  response: string;
  status: 200 | 201;
  pathParams?: Array<{ name: string; uuid: boolean }>;
  query?: QueryParam[];
  /** Extra non-2xx statuses this route documents beyond the shared 401/403/404/422. */
  conflict?: boolean;
  /** Schema name of this route's 409/422 body when it extends the shared `error` body. */
  errors?: string;
};

/** What every `src/<module>/index.ts` exports for the generator. */
export type ModuleContracts = {
  /** contract name → zod schema. Names are global; each becomes one JSON Schema file. */
  SCHEMAS: Readonly<Record<string, import("zod").ZodType>>;
  ROUTES: readonly Route[];
};
