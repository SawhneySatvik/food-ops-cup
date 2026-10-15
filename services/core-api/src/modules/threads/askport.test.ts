// T-082b — core's HTTP AskPort to intel `/ask`, against a real local HTTP server standing in for intel (the system
// boundary), and through `POST /v1/ask` on embedded Postgres:
//   (a) the body goes as JSON with the run token as the bearer and the service secret; intel's JSON comes back;
//   (b) a hung intel times out: the port rejects with the error's name only, and /v1/ask answers 503 with no thread,
//       no turn and no answer written; paired with an intel that answers → 200;
//   (c) a non-2xx rejects with the status only (never the body).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@munim/config";
import { Snapshot } from "@munim/contracts";
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../../auth/local-idp.ts";
import { openDb } from "../../../test/db.ts";
import { buildTenant, type Tenant } from "../../../test/world.ts";
import { createApp, TENANT_HEADER, type Deps } from "../../app.ts";
import { testKeys } from "../../commit/testkit.ts";
import { configureInternal } from "../../internal/index.ts";
import { configureThreads, createHttpAskPort } from "./index.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "t082b-test-service-secret-not-real-0123456789abcdef";
const INTEL_SECRET = "t082b-intel-secret-not-real";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let deps: Deps;
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;
let handler: Handler = () => undefined;
let server: Server;
let intelUrl: string;
const seen: Array<{ path: string | undefined; auth: string | undefined; secret: string | undefined; body: string }> = [];

const count = async (sql: string) => Number((await db.admin<{ n: string }>(sql, [A.tenant])).rows[0]!.n);
const written = async () => [
  await count(`SELECT count(*) n FROM core.ai_thread WHERE tenant_id = $1`),
  await count(`SELECT count(*) n FROM core.ai_thread_turn WHERE tenant_id = $1`),
  await count(`SELECT count(*) n FROM intel.answer WHERE tenant_id = $1`),
];
const ask = (question: string) =>
  app.request("/v1/ask", {
    method: "POST",
    headers: { Authorization: `Bearer ${idp.sign({ sub: A.ownerSub })}`, [TENANT_HEADER]: A.tenant, "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
const internal = (token: string, path: string, body: unknown) =>
  app.request(`/internal/intel/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** An intel that answers: stores a cited answer through core's internal API under the token it was handed. */
const answering: Handler = async (req, raw, res) => {
  const body = JSON.parse(raw);
  const token = (req.headers.authorization ?? "").slice("Bearer ".length);
  const s = Snapshot.parse(await (await internal(token, "snapshots", { template_id: "inventory.below_reorder", params: {} })).json());
  const a = await internal(token, "answers", {
    question: body.question,
    envelope: { answer_id: body.answer_id, abstained: false, segments: [{ text: `Low: ⟨snap:${s.snapshot_id}·0·ingredient_name⟩.`, refs: [`snap:${s.snapshot_id}`] }] },
  });
  if (a.status !== 201) throw new Error(`answers ${a.status}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer_id: body.answer_id, tainted: false }));
};

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url, auth: req.headers.authorization, secret: req.headers["x-munim-service-secret"] as string | undefined, body });
      void Promise.resolve(handler(req, body, res)).catch(() => res.writeHead(500).end());
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  intelUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((ok) => server?.close(ok));
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("(a) the port's request", () => {
  it("POSTs the body to /ask with the bearer run token and the service secret; returns intel's JSON", async () => {
    handler = (_, body, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ echoed: JSON.parse(body) }));
    seen.length = 0;
    const port = createHttpAskPort({ url: intelUrl, serviceSecret: INTEL_SECRET });
    const body = { answer_id: "01920000-0000-7000-8000-000000000001", question: "q", addressed_to: null, thread: null, deep: false };
    expect(await port("run.token.sig", body)).toEqual({ echoed: body });
    expect(seen).toEqual([{ path: "/ask", auth: "Bearer run.token.sig", secret: INTEL_SECRET, body: JSON.stringify(body) }]);
  });
});

describe("(b) a hung intel", () => {
  it("the port rejects at its timeout with the error's name only", async () => {
    handler = () => undefined; // never answers
    const port = createHttpAskPort({ url: intelUrl, serviceSecret: INTEL_SECRET, timeoutMs: 300 });
    const started = Date.now();
    await expect(port("run.token.sig", { answer_id: "x", question: "q", addressed_to: null, thread: null, deep: false })).rejects.toThrow(/^intel \/ask: TimeoutError$/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("POST /v1/ask → 503 and nothing written (no thread, no turn, no answer)", async () => {
    handler = () => undefined;
    configureThreads(deps, { keys, intel: createHttpAskPort({ url: intelUrl, serviceSecret: INTEL_SECRET, timeoutMs: 300 }) });
    const before = await written();
    const r = await ask("@Finance anything?");
    expect(r.status).toBe(503);
    expect(await written()).toEqual(before);
  });

  it("paired: an intel that answers over HTTP → 200 and one turn", async () => {
    handler = answering;
    configureThreads(deps, { keys, intel: createHttpAskPort({ url: intelUrl, serviceSecret: INTEL_SECRET, timeoutMs: 10_000 }) });
    const [threads, turns, answers] = await written();
    const r = await ask("@Finance what is low?");
    expect(r.status).toBe(200);
    expect(await written()).toEqual([threads! + 1, turns! + 1, answers! + 1]);
  });
});

describe("(c) intel refusing", () => {
  it("a non-2xx rejects with the status only, never the body", async () => {
    handler = (_, __, res) => void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ secret_body: "model text" }));
    const port = createHttpAskPort({ url: intelUrl, serviceSecret: INTEL_SECRET });
    const err = await port("t", { answer_id: "x", question: "q", addressed_to: null, thread: null, deep: false }).catch((e: Error) => e);
    expect((err as Error).message).toBe("intel /ask: HTTP 500");
  });
});
