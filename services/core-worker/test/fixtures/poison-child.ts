// Poison fixture: one worker process's life — `sweeps` outbox sweeps as munim_svc through the real composed Publisher
// (main.ts rowPublisher; delivery stubbed), then exit. Prints each poison/dead-letter log line as JSON on stdout.
// A fresh process holds no memory of earlier ones: whatever counts a poison row's failures must live in the database.
import { generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { loadRunTokenKeys } from "../../../core-api/src/runtoken/index.ts";
import { svcTxOf } from "../../../core-api/src/server.ts";
import { rowPublisher } from "../../src/main.ts";
import { sweepOutbox } from "../../src/sweeper.ts";

const [connectionString, sweeps] = process.argv.slice(2);
const pem = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const pool = new pg.Pool({ connectionString, max: 4 });
const publisher = rowPublisher(svcTxOf(pool), loadRunTokenKeys({ privateKeyPem: pem.privateKey, publicKeyPem: pem.publicKey }), { publish: async () => {} });
const log = (event: string, fields: Record<string, unknown> = {}) => {
  if (/poison_row|dead_lettered/.test(event)) process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
};
for (let i = 0; i < Number(sweeps); i++) await sweepOutbox(pool, publisher, log, { leaseSeconds: 0 });
await pool.end();
