-- 0009_documents_imports — documents, import formats/runs/staging/quarantine, conversations and messages
-- (02-schema §2.13, R28, R5). All operational (R29: documents, conversations, import staging and quarantine
-- are not books). Approving an import run's draft (imports.run.commit.v1, 0008) moves staging rows into book
-- tables under the approver. Runs as munim_migrator. RLS predicates: see the header of 0003.
--
-- Writers: core-worker parses files as munim_svc (03-architecture §1.3: munim_svc INSERTs core.document,
-- core.import_staging, core.import_quarantine — and, added here, core.import_run, whose counters the parser
-- fills). Members' own uploads and conversations go through munim_core.
--
-- Mapping grammar (R28): an import_format mapping is a JSON array of {source, target, unit?} string objects —
-- column renames plus declared units, nothing else (no expressions, no arithmetic). Enforced by CHECK.

CREATE TABLE core.document (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id          uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('supplier_invoice', 'payout_statement', 'bank_statement', 'pos_export',
                                                   'tally_export', 'aggregator_orders', 'market_signal', 'menu',
                                                   'price_list', 'chat_export', 'agreement', 'licence', 'other')),
  media_type  text        NOT NULL CHECK (media_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  filename    text        CHECK (length(filename) BETWEEN 1 AND 255),
  byte_size   bigint      NOT NULL CHECK (byte_size > 0),
  sha256      text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Key in the storage port (the dev blob store in dev); the bytes never live in Postgres.
  storage_ref text        NOT NULL CHECK (storage_ref <> ''),
  uploaded_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT document_sha256_unique UNIQUE (tenant_id, sha256),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES core.member (tenant_id, id)
);

-- A tenant's mapping for a file layout the built-in parsers do not know. Written only when its mapping draft
-- is approved: decision_id must name an approved decision executing in this transaction (trigger below).
CREATE TABLE core.import_format (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('payout_statement', 'bank_statement', 'pos_export', 'tally_export',
                                                        'aggregator_orders', 'supplier_invoice', 'market_signal', 'menu',
                                                        'price_list', 'reviews')),
  name             text        NOT NULL CHECK (name <> ''),
  header_signature text        NOT NULL CHECK (header_signature ~ '^[0-9a-f]{64}$'),
  mapping          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  decision_id      uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES core.decision (tenant_id, id),
  CONSTRAINT import_format_mapping_grammar CHECK (
    jsonb_typeof(mapping) = 'array' AND jsonb_array_length(mapping) >= 1
    AND NOT jsonb_path_exists(mapping, '$[*] ? (@.type() != "object")')
    AND NOT jsonb_path_exists(mapping, '$[*].keyvalue() ? (@.key != "source" && @.key != "target" && @.key != "unit")')
    AND NOT jsonb_path_exists(mapping, '$[*] ? (!(exists(@.source)) || !(exists(@.target)))')
    AND NOT jsonb_path_exists(mapping, '$[*].* ? (@.type() != "string")')
    AND NOT jsonb_path_exists(mapping, '$[*].target ? (!(@ like_regex "^[a-z][a-z0-9_]*$"))')
    AND NOT jsonb_path_exists(mapping, '$[*].unit ? (!(@ like_regex "^[a-z][a-z0-9_]{0,15}$"))'))
);
CREATE UNIQUE INDEX import_format_one_active ON core.import_format (tenant_id, kind, header_signature) WHERE status = 'active';

-- One import of one document: parsed by a built-in parser (e.g. 'swiggy_orders_v1', 'market_signal_v1')
-- or a tenant import_format. Totals of the ready rows are computed by core over import_staging in the same
-- response that shows them (R40, orchestrator derivation) — never stored here.
CREATE TABLE core.import_run (
  tenant_id           uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                  uuid        NOT NULL,
  document_id         uuid        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('payout_statement', 'bank_statement', 'pos_export', 'tally_export',
                                                           'aggregator_orders', 'supplier_invoice', 'market_signal', 'menu',
                                                           'price_list', 'reviews')),
  parser              text        CHECK (parser ~ '^[a-z][a-z0-9_]*_v[0-9]+$'),
  format_id           uuid,
  status              text        NOT NULL DEFAULT 'parsing'
                        CHECK (status IN ('parsing', 'previewed', 'committed', 'rejected', 'failed')),
  rows_ok             integer     NOT NULL DEFAULT 0 CHECK (rows_ok >= 0),
  rows_quarantined    integer     NOT NULL DEFAULT 0 CHECK (rows_quarantined >= 0),
  -- The total printed in the file (a row field, shown as such); NULL when the file states none.
  control_total_minor bigint,
  currency            char(3),
  draft_id            uuid,
  decision_id         uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id),
  FOREIGN KEY (tenant_id, format_id) REFERENCES core.import_format (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES core.draft (tenant_id, id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES core.decision (tenant_id, id),
  CHECK (num_nonnulls(parser, format_id) = 1),
  CHECK ((control_total_minor IS NULL) = (currency IS NULL)),
  CHECK ((status IN ('committed', 'rejected')) = (decision_id IS NOT NULL))
);

-- Parsed rows awaiting the run's approval. `data` holds the mapped fields; amount_minor is the row's money
-- in the run's currency (rows in another currency are quarantined, never staged — R30).
CREATE TABLE core.import_staging (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  import_run_id uuid        NOT NULL,
  row_no        integer     NOT NULL CHECK (row_no >= 1),
  target_table  text        NOT NULL CHECK (target_table ~ '^core\.[a-z_]+$'),
  data          jsonb       NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  amount_minor  bigint,
  external_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, import_run_id, row_no),
  FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id)
);

-- Rows that could not be staged. `raw` is untrusted text: shown as plain text only, never in traces.
CREATE TABLE core.import_quarantine (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  import_run_id uuid        NOT NULL,
  row_no        integer     NOT NULL CHECK (row_no >= 1),
  raw           text        NOT NULL,
  reason_code   text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, import_run_id, row_no),
  FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id)
);

-- Shift handover notes, supplier threads and imported chats (R5). Human-authored; intel reads them (claims,
-- quarantined extraction) and never posts.
CREATE TABLE core.conversation (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id          uuid        NOT NULL,
  outlet_id   uuid,
  kind        text        NOT NULL CHECK (kind IN ('handover', 'supplier', 'customer', 'imported_chat', 'other')),
  title       text        CHECK (length(title) BETWEEN 1 AND 200),
  document_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id),
  CHECK ((kind = 'imported_chat') = (document_id IS NOT NULL))
);

-- Append-only. A member's note has author_member_id; an imported message has an author_label instead.
CREATE TABLE core.message (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  conversation_id  uuid        NOT NULL,
  author_member_id uuid,
  author_label     text        CHECK (length(author_label) BETWEEN 1 AND 100),
  body             text        NOT NULL CHECK (body <> ''),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES core.conversation (tenant_id, id),
  FOREIGN KEY (tenant_id, author_member_id) REFERENCES core.member (tenant_id, id),
  CHECK (num_nonnulls(author_member_id, author_label) = 1)
);

------------------------------------------------------------------------------------------------------------
-- FKs waiting for these tables (0005 supplier_invoice, 0008 settlement / bank_line / expense / breaks)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.supplier_invoice     ADD FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id);
ALTER TABLE core.expense              ADD FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id);
ALTER TABLE core.settlement           ADD FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id);
ALTER TABLE core.bank_line            ADD FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id);
ALTER TABLE core.reconciliation_break ADD FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id);

------------------------------------------------------------------------------------------------------------
-- Functions and triggers
------------------------------------------------------------------------------------------------------------
-- R28: a format mapping exists only through its approved draft. Same test as the guard's decision branch:
-- an approved/edited decision whose draft is executing in this very transaction (MB006 otherwise).
CREATE FUNCTION core.import_format_decided() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.decision d
                   JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
                  WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.decision_id
                    AND d.verdict IN ('approved', 'edited')
                    AND r.status = 'executing' AND r.exec_txid = txid_current()) THEN
    RAISE EXCEPTION 'decision_refused: an import format is saved only by approving its mapping draft'
      USING ERRCODE = 'MB006';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.import_format_decided() FROM PUBLIC;

-- munim_svc writes runs and staging rows; it holds no UPDATE on core.tenant, so it cannot take the FOR SHARE
-- lock core.assert_tenant_currency() uses. These rows are not books, so a plain read is enough (R30).
CREATE FUNCTION core.assert_tenant_currency_svc() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  col  text;
  val  text;
  base text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    val := to_jsonb(NEW) ->> col;
    CONTINUE WHEN val IS NULL;
    IF base IS NULL THEN
      SELECT t.base_currency INTO base FROM core.tenant t WHERE t.tenant_id = NEW.tenant_id;
    END IF;
    IF base IS NULL OR val <> base THEN
      RAISE EXCEPTION 'currency_mismatch: %.% = % but the tenant base currency is %',
        TG_TABLE_NAME, col, val, coalesce(base, '?') USING ERRCODE = 'MB003';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.assert_tenant_currency_svc() FROM PUBLIC;

CREATE TRIGGER format_decided BEFORE INSERT ON core.import_format
  FOR EACH ROW EXECUTE FUNCTION core.import_format_decided();
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.import_run
  FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency_svc('currency');
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.import_run
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

------------------------------------------------------------------------------------------------------------
-- RLS, tags, grants
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document', 'import_format', 'import_run', 'import_staging', 'import_quarantine',
                           'conversation', 'message'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON core.%I
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))$p$, t);
    EXECUTE format('COMMENT ON TABLE core.%I IS %L', t, 'munim:operational');
  END LOOP;
END $$;

REVOKE ALL ON core.document, core.import_format, core.import_run, core.import_staging, core.import_quarantine,
  core.conversation, core.message FROM PUBLIC;

GRANT SELECT ON core.document, core.import_format, core.import_run, core.import_staging, core.import_quarantine,
  core.conversation, core.message TO munim_core, munim_svc;

GRANT INSERT ON core.document TO munim_core, munim_svc;
GRANT INSERT ON core.import_format TO munim_core;
GRANT UPDATE (status) ON core.import_format TO munim_core;
GRANT INSERT ON core.import_run TO munim_core, munim_svc;
GRANT UPDATE (status, rows_ok, rows_quarantined, control_total_minor, currency, draft_id) ON core.import_run TO munim_svc;
GRANT UPDATE (status, decision_id) ON core.import_run TO munim_core;
GRANT INSERT ON core.import_staging, core.import_quarantine TO munim_svc;
GRANT INSERT ON core.conversation, core.message TO munim_core;

------------------------------------------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------------------------------------------
CREATE INDEX document_uploaded_by_fk_idx ON core.document (tenant_id, uploaded_by);
CREATE INDEX import_format_decision_id_fk_idx ON core.import_format (tenant_id, decision_id);
CREATE INDEX import_run_document_id_fk_idx ON core.import_run (tenant_id, document_id);
CREATE INDEX import_run_format_id_fk_idx ON core.import_run (tenant_id, format_id);
CREATE INDEX import_run_draft_id_fk_idx ON core.import_run (tenant_id, draft_id);
CREATE INDEX import_run_decision_id_fk_idx ON core.import_run (tenant_id, decision_id);
CREATE INDEX conversation_outlet_id_fk_idx ON core.conversation (tenant_id, outlet_id);
CREATE INDEX conversation_document_id_fk_idx ON core.conversation (tenant_id, document_id);
CREATE INDEX message_conversation_id_fk_idx ON core.message (tenant_id, conversation_id, sent_at);
CREATE INDEX message_author_member_id_fk_idx ON core.message (tenant_id, author_member_id);
CREATE INDEX supplier_invoice_document_id_fk_idx ON core.supplier_invoice (tenant_id, document_id);
CREATE INDEX expense_document_id_fk_idx ON core.expense (tenant_id, document_id);
CREATE INDEX settlement_import_run_id_fk_idx ON core.settlement (tenant_id, import_run_id);
CREATE INDEX bank_line_import_run_id_fk_idx ON core.bank_line (tenant_id, import_run_id);
CREATE INDEX reconciliation_break_import_run_id_fk_idx ON core.reconciliation_break (tenant_id, import_run_id);

-- The mapping draft's command (writes the operational import_format; no book table).
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('imports.format.approve.v1', ARRAY['owner', 'manager', 'judge'], 'tenant', ARRAY[]::text[]);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_sha256_unique' AND contype = 'u'
                    AND conrelid = 'core.document'::regclass) THEN
    RAISE EXCEPTION '0009: document sha256 uniqueness missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_format_mapping_grammar' AND contype = 'c'
                    AND conrelid = 'core.import_format'::regclass) THEN
    RAISE EXCEPTION '0009: mapping grammar check missing';
  END IF;
  PERFORM munim_meta.assert_catalog('0009');
END $$;
