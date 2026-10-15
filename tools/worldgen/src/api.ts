// The one way worldgen talks to Munim: the public SDK client over HTTP, nothing else. Every write is a command
// envelope sent as a named persona; the request log is what the determinism gate compares. The log holds
// requests only (method, path, canonical body) — never responses, headers or tokens, which carry server time —
// and server-minted ids (channels, devices, documents, runs, drafts) are logged under their alias.
import { createHash } from "node:crypto";
import { createMunimClient, type MunimClient } from "../../../packages/sdk/src/index.ts";
import { idemOf, idOf } from "./ids.ts";

export type J = Record<string, unknown>;

/** Who a persona is to the IdP. The email is verified, so onboarding and invite → bind pass. Cobnut's four people are the site's demo
 *  accounts, `<key>@cobnut-demo.invalid` (interface.md; the `.invalid` TLD never receives mail); its operator is an ordinary persona. */
export const personaIdentity = (world: string, persona: string) => ({
  sub: `worldgen-${world}-${persona}`,
  email: world === "cobnut" && persona !== "operator" ? `${persona}@cobnut-demo.invalid` : `${persona}@${world.replaceAll("_", "-")}.synthetic.test`,
  email_verified: true,
});

export interface ApiOptions {
  baseUrl: string;
  seed: string;
  world: string;
  /** A bearer token for a persona (IdP-issued). */
  token: (persona: string) => string | Promise<string>;
  fetch?: typeof fetch;
  /** An operator is signed in (token for persona "operator", a `platform.operator` row for it): the demo business then gets its monthly AI budget,
   *  approved by that operator (R47 D2). Plan mode always plans it, so the request log is the same shape. */
  operator?: boolean;
  /** Plan mode: the transport is a fake, so status checks are skipped (the request log is what is under test). */
  lenient?: boolean;
}

export class CommandRefused extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;
  constructor(status: number, code: string, what: string, reason: string | null = null) {
    super(`${what}: HTTP ${status} ${code}${reason ? ` (${reason})` : ""}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as J).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
  : v;

export class Api {
  readonly lines: string[] = [];
  tenantId: string | null = null;
  readonly #aliases = new Map<string, string>();
  readonly #clients = new Map<string, MunimClient>();
  readonly #o: ApiOptions;
  readonly #fetch: typeof fetch;

  constructor(o: ApiOptions) {
    this.#o = o;
    const base = o.fetch ?? fetch;
    this.#fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.method !== "GET") this.#record(req.method, req.url, await req.clone().text());
      return base(req);
    };
  }

  id(key: string): string {
    return idOf(this.#o.seed, this.#o.world, key);
  }

  /** Names a server-minted id so the request log does not depend on it. */
  alias(id: string, name: string): string {
    this.#aliases.set(id, name);
    return id;
  }

  #record(method: string, url: string, body: string) {
    const u = new URL(url);
    let b = "";
    if (body) {
      const j = JSON.parse(body) as J;
      const p = j.payload as J | undefined;
      if (p && typeof p.content_base64 === "string") {
        p.content_base64 = `sha256:${createHash("sha256").update(Buffer.from(p.content_base64, "base64")).digest("hex")}`;
      }
      b = JSON.stringify(canon(j));
    }
    // Longest ids first is unnecessary (ids are fixed length); a plain replace per alias is enough.
    let line = `${method} ${u.pathname}${u.search} ${b}`;
    for (const [id, name] of this.#aliases) line = line.replaceAll(id, `{${name}}`);
    this.lines.push(line);
  }

  #client(persona: string, tenant: boolean): MunimClient {
    const k = `${persona}|${tenant}`;
    let c = this.#clients.get(k);
    if (!c) {
      c = createMunimClient({
        baseUrl: this.#o.baseUrl,
        token: () => this.#o.token(persona),
        ...(tenant ? { tenantId: () => this.tenantId ?? "" } : {}),
        fetch: this.#fetch,
      });
      this.#clients.set(k, c);
    }
    return c;
  }

  /** A command as `persona`: the envelope, the call, and the status check. `expect` lists accepted statuses. */
  async cmd(persona: string, path: string, type: string, key: string, payload: J, o: { params?: Record<string, string>; expect?: number[]; noTenant?: boolean; refusedWith?: string } = {}) {
    const c = this.#client(persona, !o.noTenant) as unknown as { POST(p: string, i: unknown): Promise<{ data?: J; error?: J; response: Response }> };
    const r = await c.POST(path, {
      body: { command_id: this.id(`cmd:${key}`), idempotency_key: idemOf(this.#o.seed, this.#o.world, key), type, payload },
      ...(o.params ? { params: { path: o.params } } : {}),
    });
    const status = r.response.status;
    const err = ((r.error ?? {}) as J).error as J | undefined;
    if (this.#o.lenient) return { status, body: (r.data ?? r.error ?? {}) as J };
    // An attempt the books must refuse: the status AND the stable reason code have to match, or the plant is void.
    if (o.refusedWith !== undefined) {
      if (status < 400 || err?.reason_code !== o.refusedWith) throw new CommandRefused(status, String(err?.code ?? "?"), `${type} ${key} should be refused as ${o.refusedWith}`, String(err?.reason_code ?? ""));
      return { status, body: (r.error ?? {}) as J };
    }
    if (!(o.expect ?? [200, 201]).includes(status)) throw new CommandRefused(status, String(err?.code ?? "?"), `${type} ${key}`, err?.reason_code ? String(err.reason_code) : null);
    return { status, body: (r.data ?? r.error ?? {}) as J };
  }

  /** A non-command POST (upload, run create, propose): same logging, plain body. `noTenant`: no tenant header (operator routes). */
  async post(persona: string, path: string, body: J, o: { params?: Record<string, string>; expect?: number[]; noTenant?: boolean } = {}) {
    const c = this.#client(persona, !o.noTenant) as unknown as { POST(p: string, i: unknown): Promise<{ data?: J; error?: J; response: Response }> };
    const r = await c.POST(path, { body, ...(o.params ? { params: { path: o.params } } : {}) });
    if (!this.#o.lenient && !(o.expect ?? [200, 201]).includes(r.response.status)) throw new CommandRefused(r.response.status, "?", `POST ${path}`);
    return (r.data ?? {}) as J;
  }

  /** A storefront call as an anonymous shopper holding the public storefront key (no member token, no tenant header). */
  async storefront(storefrontKey: string, path: string, body: J, o: { expect?: number[] } = {}) {
    const k = `storefront|${storefrontKey}`;
    let c = this.#clients.get(k);
    if (!c) {
      c = createMunimClient({ baseUrl: this.#o.baseUrl, storefrontKey, fetch: this.#fetch });
      this.#clients.set(k, c);
    }
    const r = await (c as unknown as { POST(p: string, i: unknown): Promise<{ data?: J; error?: J; response: Response }> }).POST(path, { body });
    if (!this.#o.lenient && !(o.expect ?? [200, 201]).includes(r.response.status)) throw new CommandRefused(r.response.status, "?", `POST ${path}`, String(((r.error as J | undefined)?.error as J | undefined)?.reason_code ?? ""));
    return (r.data ?? {}) as J;
  }

  /** Whether the run has an operator to approve platform config (always in plan mode). */
  get hasOperator(): boolean {
    return this.#o.lenient === true || this.#o.operator === true;
  }

  /** True in plan mode (a fake transport): reads return placeholders, so a caller must not wait on what they say. */
  get lenient(): boolean {
    return this.#o.lenient === true;
  }

  /** A storefront read with the public key (not logged). */
  async storefrontGet(storefrontKey: string, path: string, o: { params: Record<string, string> }) {
    const k = `storefront|${storefrontKey}`;
    let c = this.#clients.get(k);
    if (!c) {
      c = createMunimClient({ baseUrl: this.#o.baseUrl, storefrontKey, fetch: this.#fetch });
      this.#clients.set(k, c);
    }
    const r = await (c as unknown as { GET(p: string, i: unknown): Promise<{ data?: J; error?: J; response: Response }> }).GET(path, { params: { path: o.params } });
    if (!this.#o.lenient && r.response.status !== 200) throw new CommandRefused(r.response.status, "?", `GET ${path}`);
    return (r.data ?? {}) as J;
  }

  /** A read (not logged: reads never change the world). */
  async get(persona: string, path: string, o: { params?: Record<string, string>; query?: Record<string, string> } = {}) {
    const c = this.#client(persona, true) as unknown as { GET(p: string, i: unknown): Promise<{ data?: J; error?: J; response: Response }> };
    const r = await c.GET(path, { params: { ...(o.params ? { path: o.params } : {}), ...(o.query ? { query: o.query } : {}) } });
    if (!this.#o.lenient && r.response.status !== 200) throw new CommandRefused(r.response.status, "?", `GET ${path}`);
    return (r.data ?? {}) as J;
  }

  logText(): string {
    return `${this.lines.join("\n")}\n`;
  }
}
