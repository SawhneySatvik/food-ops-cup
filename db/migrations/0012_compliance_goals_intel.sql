-- 0012_compliance_goals_intel — compliance & assets (02-schema §2.10, packs/compliance-assets.md), goals
-- and tasks (§2.11), market signals and viability cases (packs/market-strategy.md; operational by
-- orchestrator ruling), the intel tables (§4, 03-architecture §1.7–§1.8, R25, R40 C5), the intel_ro views
-- (§5) and platform.llm_budget_spent. Runs as munim_migrator. RLS predicates: see the header of 0003.
--
-- Intel tables are written by core-api's internal routes as munim_svc (R25); munim_core reads them (and
-- may set a finding's status for a person dismissing it). munim_intel_ro reaches none of them directly —
-- only the intel_ro views, owned by munim_view_owner (NOBYPASSRLS), so base-table RLS filters every row to
-- the app.tenant_id intel sets from its verified run token.
--
-- Invariants enforced here:
--   * claim.quote equals the source substring [span_start, span_end) of its chunk or message (MB012).
--   * supplier_quote rows are simulated: is_simulated = true AND the supplier row's kind is 'simulated'
--     (composite FK onto core.supplier (tenant_id, id, kind)).
--   * trace_event seq is gapless per run (MB014); NOTIFY munim_trace '<tenant>:<run>:<seq>' (ids only);
--     payload strings ≤ 200 chars and snake_case keys (contracts TracePayload) — no untrusted text.
--   * finding insert/update → NOTIFY munim_inbox '<tenant>:<id>'.
--   * outcome effects are snapshot refs only (snapshot id + row + column); no numeric effect column (R40 C5).
--   * licence kinds come from the tenant's country pack (MB013).

------------------------------------------------------------------------------------------------------------
-- Compliance & assets (books; checklist_run and temp_log outlet-scoped per 02-schema §0)
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.licence (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id          uuid        NOT NULL,
  outlet_id   uuid,
  kind        text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  number      text        NOT NULL CHECK (number <> ''),
  issuer      text,
  valid_from  date        NOT NULL,
  valid_to    date,
  document_id uuid,
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'lapsed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  origin      jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- outlet_id NULL = applies to every outlet. items: array of i18n item keys.
CREATE TABLE core.checklist (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  outlet_id  uuid,
  name_key   text        NOT NULL CHECK (name_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  kind       text        NOT NULL CHECK (kind IN ('opening', 'closing', 'hygiene', 'cleaning', 'other')),
  frequency  text        NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  due_time   time        NOT NULL,
  items      jsonb       NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) >= 1),
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id)
);

CREATE TABLE core.checklist_run (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  checklist_id  uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  business_date date        NOT NULL,
  results       jsonb       NOT NULL CHECK (jsonb_typeof(results) = 'object'),
  completed_by  uuid        NOT NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, checklist_id, outlet_id, business_date),
  FOREIGN KEY (tenant_id, checklist_id) REFERENCES core.checklist (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES core.member (tenant_id, id)
);

-- Temperature-holding assets carry their safe range in milli-°C (screens gap G-OPS-1).
CREATE TABLE core.asset (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  outlet_id        uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('chiller', 'freezer', 'hot_holding', 'oven', 'fryer', 'dishwasher',
                                                        'air_conditioner', 'generator', 'water_purifier', 'other')),
  name             text        NOT NULL CHECK (name <> ''),
  make_model       text,
  serial_no        text,
  safe_min_milli_c integer,
  safe_max_milli_c integer,
  installed_on     date,
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK ((safe_min_milli_c IS NULL) = (safe_max_milli_c IS NULL)),
  CHECK (safe_min_milli_c IS NULL OR safe_min_milli_c < safe_max_milli_c)
);

-- Append-only readings; the asset must belong to the reading's outlet.
CREATE TABLE core.temp_log (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  outlet_id       uuid        NOT NULL,
  asset_id        uuid        NOT NULL,
  reading_milli_c integer     NOT NULL CHECK (reading_milli_c BETWEEN -60000 AND 300000),
  read_at         timestamptz NOT NULL,
  recorded_by     uuid        NOT NULL,
  note            text,
  origin          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, asset_id) REFERENCES core.asset (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES core.member (tenant_id, id)
);

-- Overlapping AMCs are allowed on purpose: the overlap is a finding (packs/compliance-assets.md A3).
CREATE TABLE core.amc (
  tenant_id   uuid        NOT NULL,
  id          uuid        NOT NULL,
  asset_id    uuid        NOT NULL,
  vendor      text        NOT NULL CHECK (vendor <> ''),
  valid_from  date        NOT NULL,
  valid_to    date        NOT NULL,
  cost_minor  bigint      NOT NULL CHECK (cost_minor >= 0),
  currency    char(3)     NOT NULL,
  document_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  origin      jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES core.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE core.maintenance (
  tenant_id            uuid        NOT NULL,
  id                   uuid        NOT NULL,
  asset_id             uuid        NOT NULL,
  kind                 text        NOT NULL CHECK (kind IN ('preventive', 'breakdown', 'inspection')),
  status               text        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  due_on               date,
  done_on              date,
  estimated_cost_minor bigint      CHECK (estimated_cost_minor >= 0),
  cost_minor           bigint      CHECK (cost_minor >= 0),
  currency             char(3),
  vendor               text,
  amc_id               uuid,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  origin               jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES core.asset (tenant_id, id),
  FOREIGN KEY (tenant_id, amc_id) REFERENCES core.amc (tenant_id, id),
  CHECK ((status = 'done') = (done_on IS NOT NULL)),
  CHECK (status <> 'scheduled' OR due_on IS NOT NULL),
  CHECK ((currency IS NULL) = (estimated_cost_minor IS NULL AND cost_minor IS NULL))
);

------------------------------------------------------------------------------------------------------------
-- Goals and tasks (books). task.finding_id gets its FK once intel.finding exists, below.
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.goal (
  tenant_id         uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                uuid        NOT NULL,
  outlet_id         uuid,
  metric            text        NOT NULL CHECK (metric IN ('net_sales', 'orders')),
  target_value      bigint      NOT NULL CHECK (target_value > 0),
  currency          char(3),
  period_from       date        NOT NULL,
  due_on            date        NOT NULL,
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'missed', 'cancelled')),
  basis_snapshot_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, basis_snapshot_id) REFERENCES evidence.snapshot (tenant_id, id),
  CHECK ((metric = 'net_sales') = (currency IS NOT NULL)),
  CHECK (due_on > period_from)
);

CREATE TABLE core.task (
  tenant_id          uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                 uuid        NOT NULL,
  outlet_id          uuid,
  title_key          text        NOT NULL CHECK (title_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  assignee_member_id uuid        NOT NULL,
  due_on             date        NOT NULL,
  finding_id         uuid,
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_at            timestamptz,
  done_by            uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_member_id) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, done_by) REFERENCES core.member (tenant_id, id),
  CHECK ((status = 'done') = (done_at IS NOT NULL AND done_by IS NOT NULL))
);

------------------------------------------------------------------------------------------------------------
-- Market (operational, orchestrator ruling). Signals enter only through an approved import run
-- (built-in parser market_signal_v1: on_date, kind, label, outlet_ref, value, unit, source — R28).
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.market_signal (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  outlet_id     uuid,
  on_date       date        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('weather', 'festival', 'holiday', 'local_event', 'competitor_price', 'other')),
  label         text        NOT NULL CHECK (label ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  value_milli   bigint,
  unit          text        CHECK (unit ~ '^[a-z][a-z0-9_]{0,15}$'),
  item_id       uuid,
  value_minor   bigint      CHECK (value_minor >= 0),
  currency      char(3),
  source        text        NOT NULL CHECK (source <> ''),
  import_run_id uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id),
  CHECK ((value_milli IS NULL) = (unit IS NULL)),
  CHECK ((value_minor IS NULL) = (currency IS NULL)),
  CHECK ((kind = 'competitor_price') = (item_id IS NOT NULL AND value_minor IS NOT NULL))
);

-- The owner's stated case for a new site (market.viability reads it); a planning input, not a book.
CREATE TABLE core.viability_case (
  tenant_id             uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                    uuid        NOT NULL,
  name                  text        NOT NULL CHECK (name <> ''),
  outlet_kind           text        NOT NULL CHECK (outlet_kind IN ('restaurant', 'cloud_kitchen', 'store')),
  comparable_outlet_id  uuid,
  rent_minor            bigint      CHECK (rent_minor >= 0),
  capex_minor           bigint      CHECK (capex_minor >= 0),
  avg_ticket_minor      bigint      CHECK (avg_ticket_minor > 0),
  expected_daily_orders integer     CHECK (expected_daily_orders >= 0),
  currency              char(3)     NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, comparable_outlet_id) REFERENCES core.outlet (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- intel (02-schema §4) — knowledge
------------------------------------------------------------------------------------------------------------
CREATE TABLE intel.entity (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('business', 'outlet', 'brand', 'channel', 'item', 'ingredient',
                                                  'supplier', 'person', 'customer', 'day', 'other')),
  core_ref   text        CHECK (core_ref ~ '^core\.[a-z_]+:[0-9a-f-]{36}$'),
  name       text        NOT NULL CHECK (name <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, core_ref)
);

CREATE TABLE intel.alias (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  entity_id  uuid        NOT NULL,
  alias      text        NOT NULL CHECK (alias <> ''),
  normalized text        NOT NULL CHECK (normalized <> '' AND normalized = lower(normalized)),
  source     text        NOT NULL CHECK (source IN ('core', 'claim', 'import', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, entity_id, normalized),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES intel.entity (tenant_id, id)
);

-- Text of a document (extracted) or a message, chunked for retrieval. tsv is computed by Postgres.
-- The embedding column arrives with 0013 (`-- requires: vector`).
CREATE TABLE intel.chunk (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id          uuid        NOT NULL,
  document_id uuid,
  message_id  uuid,
  seq         integer     NOT NULL CHECK (seq >= 0),
  char_start  integer     NOT NULL DEFAULT 0 CHECK (char_start >= 0),
  text        text        NOT NULL CHECK (text <> ''),
  tsv         tsvector    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
  run_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES core.message (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  CHECK (num_nonnulls(document_id, message_id) = 1)
);

-- Extracted claim. quote must equal the source substring [span_start, span_end) (0-based, characters) of
-- its chunk text or message body — checked at insert by intel.claim_quote_matches().
CREATE TABLE intel.claim (
  tenant_id         uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                uuid        NOT NULL,
  run_id            uuid        NOT NULL,
  chunk_id          uuid,
  message_id        uuid,
  span_start        integer     NOT NULL CHECK (span_start >= 0),
  span_end          integer     NOT NULL,
  quote             text        NOT NULL CHECK (quote <> ''),
  subject_entity_id uuid,
  predicate         text        NOT NULL CHECK (predicate ~ '^[a-z][a-z0-9_]*$'),
  object            text,
  object_entity_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES intel.chunk (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES core.message (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_entity_id) REFERENCES intel.entity (tenant_id, id),
  FOREIGN KEY (tenant_id, object_entity_id) REFERENCES intel.entity (tenant_id, id),
  CHECK (span_end > span_start),
  CHECK (num_nonnulls(chunk_id, message_id) = 1)
);

-- Graph edges (02-schema §6): provenance always (a claim or a core row); no money or quantity columns.
CREATE TABLE intel.edge (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('uses', 'quoted', 'sold', 'wasted', 'supplies', 'works_at', 'mentions',
                                                     'supported_by', 'proposes', 'about', 'contradicts')),
  src_entity_id uuid        NOT NULL,
  dst_entity_id uuid        NOT NULL,
  claim_id      uuid,
  source_ref    text        CHECK (source_ref ~ '^core\.[a-z_]+:[0-9a-f-]{36}$'),
  valid_from    date,
  valid_to      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, src_entity_id) REFERENCES intel.entity (tenant_id, id),
  FOREIGN KEY (tenant_id, dst_entity_id) REFERENCES intel.entity (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES intel.claim (tenant_id, id),
  CHECK (claim_id IS NOT NULL OR source_ref IS NOT NULL),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE TABLE intel.wiki_page (
  tenant_id       uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id              uuid        NOT NULL,
  entity_id       uuid,
  kind            text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  slug            text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  title           text        NOT NULL CHECK (title <> ''),
  current_version integer     CHECK (current_version >= 1),
  dirty           boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES intel.entity (tenant_id, id)
);

-- Append-only page versions; body = cited segments (refs only, validated by core-api).
CREATE TABLE intel.wiki_version (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  page_id    uuid        NOT NULL,
  version    integer     NOT NULL CHECK (version >= 1),
  body       jsonb       NOT NULL CHECK (jsonb_typeof(body) = 'array'),
  run_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, page_id, version),
  FOREIGN KEY (tenant_id, page_id) REFERENCES intel.wiki_page (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- intel — forecasts (deterministic service; allow-listed numeric source with inputs_snapshot_id)
------------------------------------------------------------------------------------------------------------
CREATE TABLE intel.forecast_run (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  run_id           uuid        NOT NULL,
  method           text        NOT NULL CHECK (method ~ '^[a-z][a-z0-9_]*$'),
  trained_through  date        NOT NULL,
  horizon_days     integer     NOT NULL CHECK (horizon_days BETWEEN 1 AND 60),
  holdout_days     integer     NOT NULL CHECK (holdout_days >= 0),
  wape_bp          integer     CHECK (wape_bp >= 0),
  baseline_wape_bp integer     CHECK (baseline_wape_bp >= 0),
  bias_bp          integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id)
);

-- item_id NULL = the outlet's 'other' series; slot_start NULL = the whole day. Outlet-scoped (a manager
-- scoped to one outlet reads only its forecasts).
CREATE TABLE intel.forecast_point (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,
  forecast_run_id    uuid        NOT NULL,
  outlet_id          uuid        NOT NULL,
  item_id            uuid,
  business_on        date        NOT NULL,
  slot_start         time,
  method             text        NOT NULL CHECK (method ~ '^[a-z][a-z0-9_]*$'),
  qty_milli          bigint      NOT NULL CHECK (qty_milli >= 0),
  lo_qty_milli       bigint      NOT NULL,
  hi_qty_milli       bigint      NOT NULL,
  inputs_snapshot_id uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, forecast_run_id) REFERENCES intel.forecast_run (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, inputs_snapshot_id) REFERENCES evidence.snapshot (tenant_id, id),
  CHECK (lo_qty_milli >= 0 AND lo_qty_milli <= qty_milli AND qty_milli <= hi_qty_milli)
);
CREATE UNIQUE INDEX forecast_point_one_per_series ON intel.forecast_point
  (tenant_id, forecast_run_id, outlet_id, (coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid)),
   business_on, (coalesce(slot_start, '00:00'::time)), (slot_start IS NULL), method);

------------------------------------------------------------------------------------------------------------
-- intel — findings, answers, traces
------------------------------------------------------------------------------------------------------------
-- impact = a snapshot cell (snapshot id + row + column), never a typed number. outlet_ids scope the inbox
-- like core.draft (overlap policy). confidence_bp is intel-supplied: never a template numeric source (R40 C5).
CREATE TABLE intel.finding (
  tenant_id          uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                 uuid        NOT NULL,
  run_id             uuid        NOT NULL,
  outlet_ids         uuid[]      NOT NULL DEFAULT '{}',
  pack               text        NOT NULL CHECK (pack ~ '^[a-z][a-z0-9_]*$'),
  type               text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  severity           text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'resolved')),
  impact_snapshot_id uuid,
  impact_row         integer     CHECK (impact_row >= 0),
  impact_column      text        CHECK (impact_column ~ '^[a-z_][a-z0-9_]*$'),
  confidence_bp      integer     NOT NULL CHECK (confidence_bp BETWEEN 0 AND 10000),
  envelope           jsonb       NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  dedupe_key         text        NOT NULL CHECK (dedupe_key <> ''),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  FOREIGN KEY (tenant_id, impact_snapshot_id) REFERENCES evidence.snapshot (tenant_id, id),
  CHECK (num_nonnulls(impact_snapshot_id, impact_row, impact_column) IN (0, 3))
);
-- One open finding per dedupe key (04 §5: re-detections merge into it).
CREATE UNIQUE INDEX finding_one_open_per_dedupe_key ON intel.finding (tenant_id, dedupe_key) WHERE status = 'open';

CREATE TABLE intel.answer (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id          uuid        NOT NULL,
  run_id      uuid        NOT NULL,
  question    text        NOT NULL CHECK (question <> ''),
  asked_by    uuid,
  envelope    jsonb       NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  abstained   boolean     NOT NULL,
  reason_code text        CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  FOREIGN KEY (tenant_id, asked_by) REFERENCES core.member (tenant_id, id),
  CHECK (abstained = (reason_code IS NOT NULL))
);

-- 03-architecture §1.8; kinds = packages/contracts TRACE_KINDS (incl. 'review', rider G-OFF-3).
CREATE TABLE intel.trace_event (
  tenant_id uuid        NOT NULL,
  run_id    uuid        NOT NULL,
  seq       integer     NOT NULL CHECK (seq >= 1),
  id        uuid        NOT NULL,
  parent_id uuid,
  kind      text        NOT NULL CHECK (kind IN ('route', 'skill_load', 'subagent_start', 'subagent_end', 'tool_call',
                                                 'tool_result', 'a2a_send', 'a2a_receive', 'finding', 'draft', 'abstain',
                                                 'error', 'review')),
  actor     text        NOT NULL CHECK (actor ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  payload   jsonb       NOT NULL,
  at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id, seq),
  CONSTRAINT trace_event_id_unique UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  CONSTRAINT trace_event_payload_labels CHECK (
    jsonb_typeof(payload) = 'object'
    AND NOT jsonb_path_exists(payload, '$.keyvalue() ? (!(@.key like_regex "^[a-z_][a-z0-9_]*$"))')
    AND NOT jsonb_path_exists(payload, '$.** ? (@.type() == "string" && @ like_regex "^.{201}" flag "s")'))
);

------------------------------------------------------------------------------------------------------------
-- intel — supplier quotes (simulated only, R22/R23), spend, outcomes, event claims, watch state
------------------------------------------------------------------------------------------------------------
-- The composite FK below needs (tenant_id, id, kind) to be a key of core.supplier (additive).
ALTER TABLE core.supplier ADD CONSTRAINT supplier_id_kind_unique UNIQUE (tenant_id, id, kind);

CREATE TABLE intel.supplier_quote (
  tenant_id           uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                  uuid        NOT NULL,
  run_id              uuid        NOT NULL,
  supplier_id         uuid        NOT NULL,
  supplier_kind       text        NOT NULL DEFAULT 'simulated' CHECK (supplier_kind = 'simulated'),
  ingredient_id       uuid        NOT NULL,
  round               smallint    NOT NULL CHECK (round BETWEEN 1 AND 3),
  qty_milli           bigint      NOT NULL CHECK (qty_milli > 0),
  unit                text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_price_minor    bigint      NOT NULL CHECK (unit_price_minor >= 0),
  currency            char(3)     NOT NULL,
  min_order_qty_milli bigint      NOT NULL DEFAULT 0 CHECK (min_order_qty_milli >= 0),
  payment_days        integer     NOT NULL CHECK (payment_days BETWEEN 0 AND 365),
  terms               jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(terms) = 'object'),
  trace_event_id      uuid,
  is_simulated        boolean     NOT NULL DEFAULT true CONSTRAINT supplier_quote_is_simulated CHECK (is_simulated),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  CONSTRAINT supplier_quote_simulated_supplier FOREIGN KEY (tenant_id, supplier_id, supplier_kind)
    REFERENCES core.supplier (tenant_id, id, kind),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, trace_event_id) REFERENCES intel.trace_event (tenant_id, id)
);

-- Model spend per call (04 §10). Platform cost, so its currency is the budget's, not asserted against
-- the tenant's base currency.
CREATE TABLE intel.intel_spend (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  run_id        uuid        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('router', 'reason', 'extract', 'narrate', 'vision', 'embed')),
  provider      text        NOT NULL CHECK (provider IN ('gemini', 'openai', 'openrouter', 'nvidia')),
  model_id      text        NOT NULL CHECK (model_id <> ''),
  input_tokens  integer     NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer     NOT NULL CHECK (output_tokens >= 0),
  amount_minor  bigint      NOT NULL CHECK (amount_minor >= 0),
  currency      char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id)
);

-- Did an executed draft help? status is set by core's check job; the measured effect is a core-template
-- snapshot cell (snapshot id + row + column) — no numeric effect column exists (R40 C5).
CREATE TABLE intel.outcome (
  tenant_id          uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                 uuid        NOT NULL,
  finding_id         uuid,
  draft_id           uuid        NOT NULL,
  decision_id        uuid,
  check_kind         text        NOT NULL CHECK (check_kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'improved', 'no_change', 'worse', 'cannot_verify')),
  effect_snapshot_id uuid,
  effect_row         integer     CHECK (effect_row >= 0),
  effect_column      text        CHECK (effect_column ~ '^[a-z_][a-z0-9_]*$'),
  checked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES intel.finding (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES core.draft (tenant_id, id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES core.decision (tenant_id, id),
  FOREIGN KEY (tenant_id, effect_snapshot_id) REFERENCES evidence.snapshot (tenant_id, id),
  CHECK (num_nonnulls(effect_snapshot_id, effect_row, effect_column) IN (0, 3)),
  CHECK (status IN ('pending', 'cannot_verify') OR effect_snapshot_id IS NOT NULL),
  CHECK ((status = 'pending') = (checked_at IS NULL))
);

-- Durable event dedupe (03-architecture §1.7): a second claim of an event id is a PK conflict.
CREATE TABLE intel.event_claim (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  event_id   uuid        NOT NULL,
  run_id     uuid        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id)
);

-- Leading-edge watcher debounce per pack (04 §5).
CREATE TABLE intel.watch_state (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  pack        text        NOT NULL CHECK (pack ~ '^[a-z][a-z0-9_]*$'),
  last_run_at timestamptz NOT NULL,
  last_run_id uuid        NOT NULL,
  PRIMARY KEY (tenant_id, pack),
  FOREIGN KEY (tenant_id, last_run_id) REFERENCES intel.run (tenant_id, id)
);

-- FKs waiting for intel.finding (0003 core.draft.finding_id; core.task above).
ALTER TABLE core.draft ADD FOREIGN KEY (tenant_id, finding_id) REFERENCES intel.finding (tenant_id, id);
ALTER TABLE core.task  ADD FOREIGN KEY (tenant_id, finding_id) REFERENCES intel.finding (tenant_id, id);

------------------------------------------------------------------------------------------------------------
-- Functions
------------------------------------------------------------------------------------------------------------
-- Licence kinds come from the tenant's active country pack (licence_kinds[].code), MB013.
CREATE FUNCTION core.licence_pack_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE kinds jsonb;
BEGIN
  SELECT p.doc -> 'licence_kinds' INTO kinds
    FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
   WHERE t.tenant_id = NEW.tenant_id
   ORDER BY p.version DESC LIMIT 1;
  IF NOT coalesce(jsonb_path_exists(kinds, '$[*] ? (@.code == $k)', jsonb_build_object('k', NEW.kind)), false) THEN
    RAISE EXCEPTION 'out_of_pack_scope: licence kind % is not in this country pack', NEW.kind USING ERRCODE = 'MB013';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.licence_pack_kind() FROM PUBLIC;

-- MB012: the quote must be the exact source span. An invisible source (other tenant, no context) refuses.
CREATE FUNCTION intel.claim_quote_matches() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE src text;
BEGIN
  IF NEW.chunk_id IS NOT NULL THEN
    SELECT c.text INTO src FROM intel.chunk c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.chunk_id;
  ELSE
    SELECT m.body INTO src FROM core.message m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.message_id;
  END IF;
  IF src IS NULL OR NEW.span_end > length(src)
     OR substr(src, NEW.span_start + 1, NEW.span_end - NEW.span_start) IS DISTINCT FROM NEW.quote THEN
    RAISE EXCEPTION 'claim_quote_mismatch: claim % quote is not the source text at [%, %)', NEW.id, NEW.span_start, NEW.span_end
      USING ERRCODE = 'MB012';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION intel.claim_quote_matches() FROM PUBLIC;

-- Gapless seq per run (MB014), serialised per run by a transaction advisory lock. Rows earlier in the same
-- INSERT statement are visible here, so one 500-row batch insert works.
CREATE FUNCTION intel.trace_seq_gapless() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE last_seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('intel.trace:' || NEW.tenant_id::text || ':' || NEW.run_id::text, 0));
  SELECT max(t.seq) INTO last_seq FROM intel.trace_event t WHERE t.tenant_id = NEW.tenant_id AND t.run_id = NEW.run_id;
  IF NEW.seq <> coalesce(last_seq, 0) + 1 THEN
    RAISE EXCEPTION 'sequence_gap: trace seq % for run % (expected %)', NEW.seq, NEW.run_id, coalesce(last_seq, 0) + 1
      USING ERRCODE = 'MB014';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION intel.trace_seq_gapless() FROM PUBLIC;

-- NOTIFY munim_trace '<tenant>:<run>:<seq>' (ids only), delivered at commit.
CREATE FUNCTION intel.notify_trace() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_notify('munim_trace', NEW.tenant_id::text || ':' || NEW.run_id::text || ':' || NEW.seq::text);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION intel.notify_trace() FROM PUBLIC;

CREATE TRIGGER pack_scope BEFORE INSERT OR UPDATE ON core.licence FOR EACH ROW EXECUTE FUNCTION core.licence_pack_kind();
CREATE TRIGGER quote_matches BEFORE INSERT ON intel.claim FOR EACH ROW EXECUTE FUNCTION intel.claim_quote_matches();
CREATE TRIGGER seq_gapless BEFORE INSERT ON intel.trace_event FOR EACH ROW EXECUTE FUNCTION intel.trace_seq_gapless();
CREATE TRIGGER notify_trace AFTER INSERT ON intel.trace_event FOR EACH ROW EXECUTE FUNCTION intel.notify_trace();
CREATE TRIGGER notify_inbox AFTER INSERT OR UPDATE ON intel.finding FOR EACH ROW EXECUTE FUNCTION core.notify_ids('munim_inbox');
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON intel.finding FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON intel.outcome FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON intel.entity FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON intel.wiki_page FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.viability_case FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON intel.supplier_quote
  FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency_svc('currency');

CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.licence       FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.checklist     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.checklist_run FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.asset         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.temp_log      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.amc           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.maintenance   FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.goal          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.task          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.amc            FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.maintenance    FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.goal           FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.market_signal  FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.viability_case FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

------------------------------------------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.licence', 'core.checklist', 'core.asset', 'core.amc', 'core.maintenance', 'core.goal',
                           'core.task', 'core.market_signal', 'core.viability_case', 'intel.entity', 'intel.alias',
                           'intel.chunk', 'intel.claim', 'intel.edge', 'intel.wiki_page', 'intel.wiki_version',
                           'intel.forecast_run', 'intel.answer', 'intel.trace_event', 'intel.supplier_quote',
                           'intel.intel_spend', 'intel.outcome', 'intel.event_claim', 'intel.watch_state'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %s
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['core.checklist_run', 'core.temp_log', 'intel.forecast_point'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_outlet_isolation ON %s
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
             AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
                  OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
             AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
                  OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))$p$, t);
  END LOOP;
END $$;

-- finding: outlet_ids overlap with the caller's scope, as core.draft (02-schema §0).
ALTER TABLE intel.finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel.finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_overlap ON intel.finding
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_ids && (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}')::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_ids && (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}')::uuid[])));

-- Operators read model spend across tenants for budgets (platform.llm_budget_spent), as they read
-- platform.llm_budget. Read-only, four columns.
CREATE POLICY operator_read ON intel.intel_spend FOR SELECT TO munim_platform USING (true);

------------------------------------------------------------------------------------------------------------
-- Tags (R29): compliance, goals, tasks are books; market_signal and viability_case are operational
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.licence        IS 'munim:book';
COMMENT ON TABLE core.checklist      IS 'munim:book';
COMMENT ON TABLE core.checklist_run  IS 'munim:book';
COMMENT ON TABLE core.asset          IS 'munim:book';
COMMENT ON TABLE core.temp_log       IS 'munim:book';
COMMENT ON TABLE core.amc            IS 'munim:book';
COMMENT ON TABLE core.maintenance    IS 'munim:book';
COMMENT ON TABLE core.goal           IS 'munim:book';
COMMENT ON TABLE core.task           IS 'munim:book';
COMMENT ON TABLE core.market_signal  IS 'munim:operational';
COMMENT ON TABLE core.viability_case IS 'munim:operational';

------------------------------------------------------------------------------------------------------------
-- Grants
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.licence, core.checklist, core.checklist_run, core.asset, core.temp_log, core.amc, core.maintenance,
  core.goal, core.task, core.market_signal, core.viability_case FROM PUBLIC;
GRANT SELECT ON core.licence, core.checklist, core.checklist_run, core.asset, core.temp_log, core.amc, core.maintenance,
  core.goal, core.task, core.market_signal, core.viability_case TO munim_core, munim_svc;
GRANT INSERT ON core.licence, core.checklist, core.checklist_run, core.asset, core.temp_log, core.amc, core.maintenance,
  core.goal, core.task, core.market_signal, core.viability_case TO munim_core;
GRANT UPDATE (status) ON core.licence TO munim_core;
GRANT UPDATE (due_time, items, active) ON core.checklist TO munim_core;
GRANT UPDATE (name, make_model, serial_no, safe_min_milli_c, safe_max_milli_c, active) ON core.asset TO munim_core;
GRANT UPDATE (status, done_on, cost_minor, currency, vendor, amc_id, note) ON core.maintenance TO munim_core;
GRANT UPDATE (status) ON core.goal TO munim_core;
GRANT UPDATE (assignee_member_id, due_on, status, done_at, done_by) ON core.task TO munim_core;
GRANT UPDATE (name, comparable_outlet_id, rent_minor, capex_minor, avg_ticket_minor, expected_daily_orders)
  ON core.viability_case TO munim_core;

REVOKE ALL ON intel.entity, intel.alias, intel.chunk, intel.claim, intel.edge, intel.wiki_page, intel.wiki_version,
  intel.forecast_run, intel.forecast_point, intel.finding, intel.answer, intel.trace_event, intel.supplier_quote,
  intel.intel_spend, intel.outcome, intel.event_claim, intel.watch_state FROM PUBLIC;
GRANT SELECT ON intel.entity, intel.alias, intel.chunk, intel.claim, intel.edge, intel.wiki_page, intel.wiki_version,
  intel.forecast_run, intel.forecast_point, intel.finding, intel.answer, intel.trace_event, intel.supplier_quote,
  intel.intel_spend, intel.outcome, intel.event_claim, intel.watch_state TO munim_core, munim_svc;
GRANT INSERT ON intel.entity, intel.alias, intel.chunk, intel.claim, intel.edge, intel.wiki_page, intel.wiki_version,
  intel.forecast_run, intel.forecast_point, intel.finding, intel.answer, intel.trace_event, intel.supplier_quote,
  intel.intel_spend, intel.outcome, intel.event_claim, intel.watch_state TO munim_svc;
GRANT UPDATE (name) ON intel.entity TO munim_svc;
GRANT UPDATE (title, current_version, dirty) ON intel.wiki_page TO munim_svc;
GRANT UPDATE (outlet_ids, severity, status, impact_snapshot_id, impact_row, impact_column, confidence_bp, envelope)
  ON intel.finding TO munim_svc;
GRANT UPDATE (status) ON intel.finding TO munim_core;
GRANT UPDATE (status, effect_snapshot_id, effect_row, effect_column, checked_at) ON intel.outcome TO munim_svc;
GRANT UPDATE (last_run_at, last_run_id) ON intel.watch_state TO munim_svc;

GRANT USAGE ON SCHEMA intel TO munim_platform;
GRANT SELECT (tenant_id, amount_minor, currency, at) ON intel.intel_spend TO munim_platform;

------------------------------------------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------------------------------------------
CREATE INDEX licence_outlet_id_fk_idx ON core.licence (tenant_id, outlet_id);
CREATE INDEX licence_document_id_fk_idx ON core.licence (tenant_id, document_id);
CREATE INDEX checklist_outlet_id_fk_idx ON core.checklist (tenant_id, outlet_id);
CREATE INDEX checklist_run_outlet_id_fk_idx ON core.checklist_run (tenant_id, outlet_id, business_date);
CREATE INDEX checklist_run_completed_by_fk_idx ON core.checklist_run (tenant_id, completed_by);
CREATE INDEX temp_log_outlet_id_asset_id_fk_idx ON core.temp_log (tenant_id, outlet_id, asset_id, read_at);
CREATE INDEX temp_log_recorded_by_fk_idx ON core.temp_log (tenant_id, recorded_by);
CREATE INDEX amc_asset_id_fk_idx ON core.amc (tenant_id, asset_id);
CREATE INDEX amc_document_id_fk_idx ON core.amc (tenant_id, document_id);
CREATE INDEX maintenance_asset_id_fk_idx ON core.maintenance (tenant_id, asset_id);
CREATE INDEX maintenance_amc_id_fk_idx ON core.maintenance (tenant_id, amc_id);
CREATE INDEX goal_outlet_id_fk_idx ON core.goal (tenant_id, outlet_id);
CREATE INDEX goal_basis_snapshot_id_fk_idx ON core.goal (tenant_id, basis_snapshot_id);
CREATE INDEX task_outlet_id_fk_idx ON core.task (tenant_id, outlet_id);
CREATE INDEX task_assignee_member_id_fk_idx ON core.task (tenant_id, assignee_member_id);
CREATE INDEX task_done_by_fk_idx ON core.task (tenant_id, done_by);
CREATE INDEX task_finding_id_fk_idx ON core.task (tenant_id, finding_id);
CREATE INDEX market_signal_outlet_id_fk_idx ON core.market_signal (tenant_id, outlet_id, on_date);
CREATE INDEX market_signal_item_id_fk_idx ON core.market_signal (tenant_id, item_id);
CREATE INDEX market_signal_import_run_id_fk_idx ON core.market_signal (tenant_id, import_run_id);
CREATE INDEX viability_case_comparable_outlet_id_fk_idx ON core.viability_case (tenant_id, comparable_outlet_id);
CREATE INDEX draft_finding_id_fk_idx ON core.draft (tenant_id, finding_id);
CREATE INDEX alias_entity_id_fk_idx ON intel.alias (tenant_id, entity_id);
CREATE INDEX alias_normalized_idx ON intel.alias (tenant_id, normalized);
CREATE INDEX chunk_document_id_fk_idx ON intel.chunk (tenant_id, document_id);
CREATE INDEX chunk_message_id_fk_idx ON intel.chunk (tenant_id, message_id);
CREATE INDEX chunk_run_id_fk_idx ON intel.chunk (tenant_id, run_id);
CREATE INDEX chunk_tsv_idx ON intel.chunk USING gin (tsv);
CREATE INDEX claim_run_id_fk_idx ON intel.claim (tenant_id, run_id);
CREATE INDEX claim_chunk_id_fk_idx ON intel.claim (tenant_id, chunk_id);
CREATE INDEX claim_message_id_fk_idx ON intel.claim (tenant_id, message_id);
CREATE INDEX claim_subject_entity_id_fk_idx ON intel.claim (tenant_id, subject_entity_id);
CREATE INDEX claim_object_entity_id_fk_idx ON intel.claim (tenant_id, object_entity_id);
CREATE INDEX edge_src_entity_id_fk_idx ON intel.edge (tenant_id, src_entity_id);
CREATE INDEX edge_dst_entity_id_fk_idx ON intel.edge (tenant_id, dst_entity_id);
CREATE INDEX edge_claim_id_fk_idx ON intel.edge (tenant_id, claim_id);
CREATE INDEX wiki_page_entity_id_fk_idx ON intel.wiki_page (tenant_id, entity_id);
CREATE INDEX wiki_version_run_id_fk_idx ON intel.wiki_version (tenant_id, run_id);
CREATE INDEX forecast_run_run_id_fk_idx ON intel.forecast_run (tenant_id, run_id);
CREATE INDEX forecast_point_outlet_id_fk_idx ON intel.forecast_point (tenant_id, outlet_id, business_on);
CREATE INDEX forecast_point_item_id_fk_idx ON intel.forecast_point (tenant_id, item_id);
CREATE INDEX forecast_point_inputs_snapshot_id_fk_idx ON intel.forecast_point (tenant_id, inputs_snapshot_id);
CREATE INDEX finding_run_id_fk_idx ON intel.finding (tenant_id, run_id);
CREATE INDEX finding_impact_snapshot_id_fk_idx ON intel.finding (tenant_id, impact_snapshot_id);
CREATE INDEX finding_inbox_idx ON intel.finding (tenant_id, status, updated_at);
-- Inbox / SSE replay by updated_at (03-architecture §1.8; T-006).
CREATE INDEX finding_replay_idx ON intel.finding (tenant_id, updated_at, id);
CREATE INDEX answer_run_id_fk_idx ON intel.answer (tenant_id, run_id);
CREATE INDEX answer_asked_by_fk_idx ON intel.answer (tenant_id, asked_by);
CREATE INDEX supplier_quote_run_id_fk_idx ON intel.supplier_quote (tenant_id, run_id);
CREATE INDEX supplier_quote_supplier_fk_idx ON intel.supplier_quote (tenant_id, supplier_id, supplier_kind);
CREATE INDEX supplier_quote_ingredient_id_fk_idx ON intel.supplier_quote (tenant_id, ingredient_id);
CREATE INDEX supplier_quote_trace_event_id_fk_idx ON intel.supplier_quote (tenant_id, trace_event_id);
CREATE INDEX intel_spend_run_id_fk_idx ON intel.intel_spend (tenant_id, run_id);
CREATE INDEX intel_spend_at_idx ON intel.intel_spend (tenant_id, at);
CREATE INDEX outcome_finding_id_fk_idx ON intel.outcome (tenant_id, finding_id);
CREATE INDEX outcome_draft_id_fk_idx ON intel.outcome (tenant_id, draft_id);
CREATE INDEX outcome_decision_id_fk_idx ON intel.outcome (tenant_id, decision_id);
CREATE INDEX outcome_effect_snapshot_id_fk_idx ON intel.outcome (tenant_id, effect_snapshot_id);
CREATE INDEX event_claim_run_id_fk_idx ON intel.event_claim (tenant_id, run_id);
CREATE INDEX watch_state_last_run_id_fk_idx ON intel.watch_state (tenant_id, last_run_id);

------------------------------------------------------------------------------------------------------------
-- platform.llm_budget_spent (02-schema §1): budgets with spend summed from intel.intel_spend for the month
-- (UTC) in the budget's currency. security_invoker, so each reader's own RLS applies: a tenant context sees
-- its own row; the operator role sees all (operator_all on llm_budget, operator_read on intel_spend).
------------------------------------------------------------------------------------------------------------
CREATE VIEW platform.llm_budget_spent WITH (security_invoker = true) AS
  SELECT b.tenant_id, b.month, b.limit_minor, b.currency,
         coalesce((SELECT sum(s.amount_minor)
                     FROM intel.intel_spend s
                    WHERE s.tenant_id = b.tenant_id AND s.currency = b.currency
                      AND (s.at AT TIME ZONE 'UTC') >= b.month
                      AND (s.at AT TIME ZONE 'UTC') < (b.month + interval '1 month')), 0)::bigint AS spent_minor
    FROM platform.llm_budget b;
REVOKE ALL ON platform.llm_budget_spent FROM PUBLIC;
GRANT SELECT ON platform.llm_budget_spent TO munim_core, munim_svc, munim_platform;

------------------------------------------------------------------------------------------------------------
-- intel_ro views (02-schema §5). Owned by munim_view_owner (NOBYPASSRLS): base-table policies apply to the
-- view owner, reading the session's app.tenant_id / app.outlet_ids, which intel sets from its verified run
-- token (03-architecture §1.4, §1.7). Text retrieval only; finding_recent has no numeric column.
------------------------------------------------------------------------------------------------------------
CREATE VIEW intel_ro.wiki_current AS
  SELECT p.id AS page_id, p.slug, p.title, p.kind, p.entity_id, v.version, v.body, v.created_at AS version_at
    FROM intel.wiki_page p
    JOIN intel.wiki_version v ON v.tenant_id = p.tenant_id AND v.page_id = p.id AND v.version = p.current_version;

CREATE VIEW intel_ro.claim_search AS
  SELECT c.id, c.subject_entity_id, c.predicate, c.object, c.object_entity_id, c.quote, c.chunk_id, c.message_id,
         c.span_start, c.span_end, c.created_at
    FROM intel.claim c;

CREATE VIEW intel_ro.chunk_search AS
  SELECT k.id, k.document_id, k.message_id, k.seq, k.text, k.tsv
    FROM intel.chunk k;

CREATE VIEW intel_ro.entity_alias AS
  SELECT e.id AS entity_id, e.kind, e.name, e.core_ref, a.alias, a.normalized
    FROM intel.entity e
    LEFT JOIN intel.alias a ON a.tenant_id = e.tenant_id AND a.entity_id = e.id;

CREATE VIEW intel_ro.finding_recent AS
  SELECT f.id, f.pack, f.type, f.severity, f.status, f.dedupe_key
    FROM intel.finding f
   WHERE f.updated_at > now() - interval '30 days';

CREATE VIEW intel_ro.trace_recent AS
  SELECT t.run_id, t.seq, t.id, t.parent_id, t.kind, t.actor, t.payload, t.at
    FROM intel.trace_event t
   WHERE t.at > now() - interval '7 days';

CREATE VIEW intel_ro.outlet_names AS SELECT o.id, o.name FROM core.outlet o;
CREATE VIEW intel_ro.item_names AS SELECT i.id, i.kind, i.name_key, i.category FROM core.item i;
CREATE VIEW intel_ro.ingredient_names AS SELECT g.id, g.name FROM core.ingredient g;
CREATE VIEW intel_ro.supplier_names AS SELECT s.id, s.name, s.kind FROM core.supplier s;

-- The view owner reads exactly the columns the views (and the base-table policies) use.
GRANT SELECT (tenant_id, id, kind, slug, title, entity_id, current_version) ON intel.wiki_page TO munim_view_owner;
GRANT SELECT (tenant_id, page_id, version, body, created_at) ON intel.wiki_version TO munim_view_owner;
GRANT SELECT (tenant_id, id, subject_entity_id, predicate, object, object_entity_id, quote, chunk_id, message_id,
  span_start, span_end, created_at) ON intel.claim TO munim_view_owner;
GRANT SELECT (tenant_id, id, document_id, message_id, seq, text, tsv) ON intel.chunk TO munim_view_owner;
GRANT SELECT (tenant_id, id, kind, name, core_ref) ON intel.entity TO munim_view_owner;
GRANT SELECT (tenant_id, entity_id, alias, normalized) ON intel.alias TO munim_view_owner;
GRANT SELECT (tenant_id, id, outlet_ids, pack, type, severity, status, dedupe_key, updated_at) ON intel.finding TO munim_view_owner;
GRANT SELECT (tenant_id, run_id, seq, id, parent_id, kind, actor, payload, at) ON intel.trace_event TO munim_view_owner;
GRANT SELECT (tenant_id, id, name) ON core.outlet TO munim_view_owner;
GRANT SELECT (tenant_id, id, kind, name_key, category) ON core.item TO munim_view_owner;
GRANT SELECT (tenant_id, id, name) ON core.ingredient TO munim_view_owner;
GRANT SELECT (tenant_id, id, name, kind) ON core.supplier TO munim_view_owner;

REVOKE ALL ON intel_ro.wiki_current, intel_ro.claim_search, intel_ro.chunk_search, intel_ro.entity_alias,
  intel_ro.finding_recent, intel_ro.trace_recent, intel_ro.outlet_names, intel_ro.item_names, intel_ro.ingredient_names,
  intel_ro.supplier_names FROM PUBLIC;
GRANT SELECT ON intel_ro.wiki_current, intel_ro.claim_search, intel_ro.chunk_search, intel_ro.entity_alias,
  intel_ro.finding_recent, intel_ro.trace_recent, intel_ro.outlet_names, intel_ro.item_names, intel_ro.ingredient_names,
  intel_ro.supplier_names TO munim_intel_ro;

GRANT CREATE ON SCHEMA intel_ro TO munim_view_owner;
ALTER VIEW intel_ro.wiki_current     OWNER TO munim_view_owner;
ALTER VIEW intel_ro.claim_search     OWNER TO munim_view_owner;
ALTER VIEW intel_ro.chunk_search     OWNER TO munim_view_owner;
ALTER VIEW intel_ro.entity_alias     OWNER TO munim_view_owner;
ALTER VIEW intel_ro.finding_recent   OWNER TO munim_view_owner;
ALTER VIEW intel_ro.trace_recent     OWNER TO munim_view_owner;
ALTER VIEW intel_ro.outlet_names     OWNER TO munim_view_owner;
ALTER VIEW intel_ro.item_names       OWNER TO munim_view_owner;
ALTER VIEW intel_ro.ingredient_names OWNER TO munim_view_owner;
ALTER VIEW intel_ro.supplier_names   OWNER TO munim_view_owner;
REVOKE CREATE ON SCHEMA intel_ro FROM munim_view_owner;

------------------------------------------------------------------------------------------------------------
-- Command authority with table bindings (draft types from the D-1 packs; member commands INFERENCE)
------------------------------------------------------------------------------------------------------------
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('compliance.licence.upsert.v1',       ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.licence']),
  ('compliance.checklist.upsert.v1',     ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.checklist']),
  ('compliance.checklist.complete.v1',   ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.checklist_run']),
  ('compliance.temp.record.v1',          ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.temp_log']),
  ('compliance.asset.upsert.v1',         ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.asset']),
  ('compliance.amc.record.v1',           ARRAY['owner', 'judge'],                     'outlet', ARRAY['core.amc']),
  ('compliance.maintenance.schedule.v1', ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.maintenance']),
  ('compliance.maintenance.record.v1',   ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.maintenance']),
  ('goals.goal.create.v1',               ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.goal']),
  ('goals.goal.update.v1',               ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.goal']),
  ('goals.task.create.v1',               ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.task']),
  ('goals.task.update.v1',               ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.task']);

------------------------------------------------------------------------------------------------------------
-- Post-conditions
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE bad text;
BEGIN
  -- finding_recent: exactly the six text-ish columns, none numeric (02-schema §5, R40 C5).
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = 'intel_ro.finding_recent'::regclass AND a.attnum > 0)
     IS DISTINCT FROM 'id:uuid,pack:text,type:text,severity:text,status:text,dedupe_key:text' THEN
    RAISE EXCEPTION '0012: intel_ro.finding_recent columns are not exactly the six written here';
  END IF;
  -- Views are owner-privileged (not security_invoker), so RLS runs as munim_view_owner.
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'intel_ro' AND coalesce(array_to_string(c.reloptions, ','), '') LIKE '%security_invoker=true%';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0012: security_invoker intel_ro views: %', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'platform.llm_budget_spent'::regclass
                    AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%') THEN
    RAISE EXCEPTION '0012: platform.llm_budget_spent must be security_invoker';
  END IF;
  -- munim_intel_ro: USAGE on intel_ro only, SELECT on its views only.
  IF has_schema_privilege('munim_intel_ro', 'intel', 'USAGE') OR has_schema_privilege('munim_intel_ro', 'core', 'USAGE')
     OR has_schema_privilege('munim_intel_ro', 'evidence', 'USAGE') OR has_schema_privilege('munim_intel_ro', 'platform', 'USAGE') THEN
    RAISE EXCEPTION '0012: munim_intel_ro has USAGE outside intel_ro';
  END IF;
  -- The GIN index for full-text search, on tsv (gotcha 1).
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
                  WHERE i.indrelid = 'intel.chunk'::regclass AND am.amname = 'gin'
                    AND i.indkey::text = (SELECT attnum::text FROM pg_attribute WHERE attrelid = 'intel.chunk'::regclass AND attname = 'tsv')) THEN
    RAISE EXCEPTION '0012: GIN index on intel.chunk(tsv) missing';
  END IF;
  PERFORM munim_meta.assert_catalog('0012');
END $$;
