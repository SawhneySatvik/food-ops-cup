// Cloud Run entry for core-api (copied to services/core-api/src/cloud-run-entry.mjs by core-api.Dockerfile, so its
// imports resolve like the service's own). Why not server.ts: its entry binds 127.0.0.1 and reads `.env` and `.run/`.
// Config comes from the process environment only (composeFromEnv: a missing secret fails the boot). core-worker's
// jobs are NOT started here: MUNIM_CRON_SECRET stays unset, so the tick route is off and the worker service runs them.
import { serve } from "@hono/node-server";
import { composeFromEnv } from "./env-root.ts";
import { closeStream } from "./stream/index.ts";

const api = await composeFromEnv(process.env);
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: api.app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`core-api: listening on ${port}`));

let stopping = false;
const stop = () => {
  if (stopping) process.exit(1);
  stopping = true;
  // Cloud Run gives 10 s after SIGTERM. Streams first: an open SSE response would hold server.close().
  setTimeout(() => process.exit(1), 9_000).unref();
  void closeStream(api.deps).then(() => server.close(() => void api.close().then(() => process.exit(0), () => process.exit(1))));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
