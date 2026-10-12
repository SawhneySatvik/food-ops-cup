// make ontology  →  node packages/contracts/scripts/ontology.ts   (run after `make contracts`)
// ADR-014 §2 (T-080): the ontology over Postgres, generated, never hand-kept.
//   objects   = the tables of the applied migrations (embedded Postgres; 0013 skipped there as everywhere in the gates)
//   links     = foreign keys, the projection-edge kinds (intel.edge CHECK) and the fixed lineage chain (§2.3)
//   functions = evidence.snapshot_template rows, each with its `read_<template>` model schema
//   actions   = the registered draftables, each with its `propose_<command>` model schema, authority and stages
//   specialists = the registry (T-087a), with the tools each one binds (registry ∩ what exists)
// → packages/contracts/generated/ontology.json, stamped with the sha256 of its inputs (freshness gate).
// The gates compare against db/tests/manifest.ts and MANIFEST.d, which this script never reads (review minor 8).
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { startTestDb } from "../../../db/src/harness.ts";
import { SPECIALIST_REGISTRY } from "../src/intel/specialists.ts";
import { ACTION_LEAVES, NOT_AGENT_EXPOSED, PROPOSE_EXTRA, READ_EXTRA } from "../src/ontology/actions.ts";
import { lintToolSchema } from "../src/ontology/lint.ts";
import { bodyDigest, inputsDigest, ONTOLOGY_FILE } from "../src/ontology/stamp.ts";
import { type Json, proposeToolName, readToolName, toModelSchema } from "../src/ontology/transform.ts";
import { loadRegistry } from "../src/registry.ts";
import { draftable, draftableTypes } from "../src/shared/draftables.ts";

const SCHEMAS = ["core", "evidence", "intel", "platform", "munim_meta"];
/** ADR-014 §2.3: lineage joins through these, never through the graph. */
const LINEAGE = [
  { from: "core.decision", to: "core.draft", via: "draft_id" },
  { from: "core.draft", to: "intel.finding", via: "finding_id" },
  { from: "core.draft", to: "intel.run", via: "run_id" },
  { from: "intel.finding", to: "intel.run", via: "run_id" },
  { from: "intel.run", to: "evidence.snapshot", via: "run_id" },
  { from: "core.audit_log", to: "core.decision", via: "decision_id" },
];
/** Template params a model may never pass (T-040: a tenant param is refused by core too). */
// The run itself, the tenant and the actor are never model parameters. A reference to another run by role (e.g.
// purchasing.quote_compare's negotiation_run_id, 0021) is an ordinary id param: the model passes it as a handle, never a uuid.
const FORBIDDEN_PARAM = /tenant|^run_id$|actor/;
// ADR-014 §5.1: pack templates that are inputs to deterministic code (forecast engine, deal review, duplicate check),
// never a model tool. Same hand list as packages/contracts/test/specialists.test.ts.
// ADR-015: the Cares follow-ups (recipient_match for expiry_risk, pickup_crew for overstaffed_slot) are mapping inputs, not tools.
const NOT_AGENT_EXPOSED_TEMPLATES = ["forecast.sales_history", "forecast.slot_profile", "purchasing.deal_inputs", "purchasing.invoice_duplicates", "cares.recipient_match", "cares.pickup_crew"];
const step = (m: string) => console.log(`ontology: ${m}`);
const fail = (m: string): never => {
  throw new Error(`ontology: ${m}`);
};

await loadRegistry(); // registers every draftable
const inputs = inputsDigest();
const db = await startTestDb({ seedPacks: false });
let doc: Json;
try {
  const q = async <R extends Json>(sql: string, params: unknown[] = []) => (await db.admin<R>(sql, params)).rows;

  // -- objects -------------------------------------------------------------------------------------------
  const tables = await q<{ name: string; tag: string | null }>(
    `SELECT n.nspname || '.' || c.relname AS name, obj_description(c.oid, 'pg_class') AS tag
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname = ANY($1) ORDER BY 1`,
    [SCHEMAS],
  );
  const columns = await q<{ tbl: string; name: string; type: string; not_null: boolean }>(
    `SELECT n.nspname || '.' || c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, a.attnum`,
    [SCHEMAS],
  );
  const keys = await q<{ tbl: string; cols: string[] }>(
    `SELECT n.nspname || '.' || c.relname AS tbl, array_agg(a.attname ORDER BY k.ord) AS cols
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indisprimary AND n.nspname = ANY($1) GROUP BY 1`,
    [SCHEMAS],
  );
  const pk = new Map(keys.map((k) => [k.tbl, k.cols]));
  const colsOf = new Map<string, Json[]>();
  for (const c of columns) (colsOf.get(c.tbl) ?? colsOf.set(c.tbl, []).get(c.tbl)!).push({ name: c.name, type: c.type, not_null: c.not_null });
  const objects = tables.map((t) => {
    const cols = colsOf.get(t.name) ?? [];
    const tag = t.tag === "munim:book" ? "book" : t.tag === "munim:operational" ? "operational" : null;
    return { name: t.name, tag, tenant: cols.some((c) => c.name === "tenant_id"), primary_key: pk.get(t.name) ?? [], columns: cols };
  });
  step(`${objects.length} object types (${objects.filter((o) => o.tenant).length} tenant-scoped, ${objects.filter((o) => o.tag === "book").length} book)`);

  // -- links ---------------------------------------------------------------------------------------------
  const fks = await q<{ name: string; from: string; from_cols: string[]; to: string; to_cols: string[] }>(
    `SELECT con.conname AS name, sn.nspname || '.' || sc.relname AS from, tn.nspname || '.' || tc.relname AS to,
            ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o) AS from_cols,
            ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o) AS to_cols
       FROM pg_constraint con
       JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
       JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
      WHERE con.contype = 'f' AND sn.nspname = ANY($1) AND NOT sc.relispartition ORDER BY 2, 1`,
    [SCHEMAS],
  );
  const edgeCheck = await q<{ def: string }>(
    `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
      WHERE con.conrelid = 'intel.edge'::regclass AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%kind%'`,
  );
  if (edgeCheck.length !== 1) fail(`expected one CHECK on intel.edge.kind, found ${edgeCheck.length}`);
  const edgeKinds = [...edgeCheck[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
  step(`${fks.length} foreign keys, ${edgeKinds.length} projection-edge kinds`);

  // -- functions (snapshot templates) ----------------------------------------------------------------------
  const templates = await q<{ id: string; version: number; params_schema: Json; columns: Json[]; min_role: string }>(
    `SELECT DISTINCT ON (id) id, version, params_schema, columns, min_role FROM evidence.snapshot_template ORDER BY id, version DESC`,
  );
  const functions = templates.map((t) => {
    const params = Object.keys((t.params_schema.properties ?? {}) as Json);
    const bad = params.filter((p) => FORBIDDEN_PARAM.test(p) || p in READ_EXTRA);
    if (bad.length) fail(`template ${t.id} has forbidden or reserved params ${bad.join(", ")}`);
    // `intel.*` templates (track record, budget left, cost estimate; 0020) are core-consumed — desk, run-frame, plan
    // preview — never a model tool.
    const agent_exposed = t.min_role !== "operator" && !t.id.startsWith("intel.") && !NOT_AGENT_EXPOSED_TEMPLATES.includes(t.id);
    const m = toModelSchema(t.params_schema, {}, { numbers: true });
    const props = { ...(m.schema.properties as Json), ...READ_EXTRA };
    const schema = { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
    const lint = lintToolSchema(schema);
    if (agent_exposed && lint.length) fail(`read_${t.id} fails lint: ${lint.join("; ")}`);
    return {
      id: t.id,
      version: t.version,
      min_role: t.min_role,
      agent_exposed,
      tool: agent_exposed ? readToolName(t.id) : null,
      params_schema: t.params_schema,
      columns: t.columns,
      model_schema: agent_exposed ? schema : null,
      leaves: m.leaves,
      optional: m.optional,
    };
  });
  step(`${functions.length} functions (${functions.filter((f) => f.agent_exposed).length} agent-exposed read tools)`);

  // -- actions (draftables) --------------------------------------------------------------------------------
  const authority = await q<{ command_type: string; allowed_roles: string[]; scope: string; max_amount_minor: string | null }>(
    `SELECT command_type, allowed_roles, scope, max_amount_minor::text FROM core.command_authority ORDER BY 1`,
  );
  const authOf = new Map(authority.map((a) => [a.command_type, a]));
  const actions = draftableTypes().map((type) => {
    const d = draftable(type)!;
    const ov = ACTION_LEAVES[type] ?? fail(`draftable ${type} has no ACTION_LEAVES entry (declare its minted ids)`);
    const { $schema: _s, ...contract } = z.toJSONSchema(d.proposal, { target: "draft-2020-12", io: "input" }) as Json;
    const m = toModelSchema(contract, ov);
    const payload = m.schema.properties as Json;
    const clash = Object.keys(PROPOSE_EXTRA).filter((k) => k in payload);
    if (clash.length) fail(`${type} payload uses reserved argument names ${clash.join(", ")}`);
    const props = { ...payload, ...PROPOSE_EXTRA };
    const schema = { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
    const agent_exposed = !(NOT_AGENT_EXPOSED as readonly string[]).includes(type);
    const lint = lintToolSchema(schema);
    if (agent_exposed && lint.length) fail(`${proposeToolName(type)} fails lint: ${lint.join("; ")}`);
    const auth = authOf.get(type) ?? fail(`draftable ${type} has no core.command_authority row`);
    return {
      command_type: type,
      contract: `proposal.${type}`,
      tool: agent_exposed ? proposeToolName(type) : null,
      agent_exposed,
      // ADR-014 §2.2: preview (POST /internal/intel/v1/drafts) → approve (a named person) → commit (as the approver).
      stages: ["preview", "approve", "commit"],
      auto_apply: false,
      authority: { allowed_roles: [...auth.allowed_roles].sort(), scope: auth.scope, max_amount_minor: auth.max_amount_minor },
      model_schema: agent_exposed ? schema : null,
      leaves: m.leaves,
      optional: m.optional,
    };
  });
  const names = [...functions.map((f) => f.tool), ...actions.map((a) => a.tool)].filter((n): n is string => n !== null);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) fail(`tool names collide: ${dup.join(", ")}`);
  step(`${actions.length} actions (${actions.filter((a) => a.agent_exposed).length} agent-exposed propose tools)`);

  // -- specialists -------------------------------------------------------------------------------------------
  const exposedTemplates = new Set(functions.filter((f) => f.agent_exposed).map((f) => f.id));
  const exposedActions = new Set(actions.filter((a) => a.agent_exposed).map((a) => a.command_type));
  const specialists = SPECIALIST_REGISTRY.specialists.map((s) => ({
    id: s.id,
    kind: s.kind,
    templates: s.templates.filter((t) => exposedTemplates.has(t)),
    templates_pending: s.templates.filter((t) => !exposedTemplates.has(t)),
    draftables: s.draftables.filter((d) => exposedActions.has(d)),
  }));
  for (const s of SPECIALIST_REGISTRY.specialists) {
    const foreign = s.draftables.filter((d) => !exposedActions.has(d));
    if (foreign.length) fail(`specialist ${s.id} proposes non-exposed draftables ${foreign.join(", ")}`);
    // Workflow draftables (DECISIONS 11 Oct, W3.2) are emitted by code, never by this specialist's model: registered, not among its
    // own propose tools, and agent-exposed only where another specialist proposes them (people's Cares task = goals.task, which
    // compliance and market propose; ADR-015 §4).
    const proposedElsewhere = (d: string) => SPECIALIST_REGISTRY.specialists.some((o) => o.id !== s.id && o.draftables.includes(d));
    const workflow = s.workflow_draftables.filter((d) => !draftable(d) || s.draftables.includes(d) || (exposedActions.has(d) && !proposedElsewhere(d)));
    if (workflow.length) fail(`specialist ${s.id} lists workflow draftables that are unregistered, its own propose tools, or agent-exposed with no proposer: ${workflow.join(", ")}`);
  }
  const owned = new Set(specialists.flatMap((s) => s.templates));
  step(`unowned agent-exposed templates: ${[...exposedTemplates].filter((t) => !owned.has(t)).join(", ") || "none"}`);

  doc = {
    $comment: "Generated by packages/contracts/scripts/ontology.ts (make ontology) — do not edit. All data synthetic; suppliers simulated.",
    objects,
    links: {
      foreign_keys: fks,
      projection_edges: edgeKinds,
      lineage: LINEAGE,
    },
    functions,
    actions,
    specialists,
  };
  doc.stamp = { inputs, body_sha256: bodyDigest(doc) };
} finally {
  await db.stop();
}
writeFileSync(ONTOLOGY_FILE, JSON.stringify(doc, null, 2) + "\n");
step(`→ ${ONTOLOGY_FILE} (inputs ${inputs.sha256.slice(0, 12)}…, ${Object.keys(inputs.files).length} files)`);
