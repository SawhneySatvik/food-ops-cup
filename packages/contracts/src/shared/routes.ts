// HTTP route descriptors a module publishes; the generator turns them into OpenAPI 3.1 operations.
// `request` / `response` name schemas in the registry (any module). `command` makes the request body the
// typed command envelope `{command_id, idempotency_key, type, payload: <command schema>}`.
export type Surface = "public" | "internal";
/** member: IdP token + X-Munim-Tenant · operator: IdP token · intel: run token + service credential ·
 *  storefront: X-Munim-Storefront-Key (+ an optional customer token) · identity: an IdP token alone, for a
 *  person with no tenant yet (onboarding, "my tenants") · public: no credential at all (ADR-015 §2.1: the Munim
 *  Cares network pages; OpenAPI `security: []`, read-only, rate-limited by core-api). */
export type Auth = "member" | "operator" | "intel" | "storefront" | "identity" | "public";
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
  /** storefront routes only: also reachable with a guest access token (`X-Munim-Guest-Token`, the one order whose
   *  token it is) instead of a customer token. The generator documents the `guestToken` alternative. */
  guest?: boolean;
  /** Extra non-2xx statuses this route documents beyond the shared 401/403/404/422. */
  conflict?: boolean;
  /** Schema name of this route's 409/422 body when it extends the shared `error` body. */
  errors?: string;
  /** T-099 (G-07): the 200 body is a `text/event-stream` (server-sent events) whose each `data:` line is the JSON of
   *  `response`; read it with the SDK's fetch-based reader (`openStream`), never EventSource (gotcha 23). */
  stream?: true;
  /** Further credentials the route also accepts besides `auth` (each documented as an alternative security entry). */
  alsoAuth?: Auth[];
};

/** What every `src/<module>/index.ts` exports for the generator. */
export type ModuleContracts = {
  /** contract name → zod schema. Names are global; each becomes one JSON Schema file. */
  SCHEMAS: Readonly<Record<string, import("zod").ZodType>>;
  ROUTES: readonly Route[];
};
