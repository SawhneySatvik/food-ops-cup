-- 0008_finance — finance (02-schema §2.7, packs/finance.md, R29), channel terms and disputes (orchestrator
-- ruling: book), the posting and inventory derivation rules, and finance command bindings. Runs as
-- munim_migrator. RLS predicates: see the header of 0003. Every table here is a tenant-policy table
-- (02-schema §0 lists no finance table as outlet-scoped).
--
-- Books invariants enforced here:
--   * Σ postings = 0 per journal entry per currency, ≥ 2 postings per entry — deferred constraint triggers,
--     checked at commit (MB010 books_unbalanced). The check refuses when it cannot see the entry or the
--     posting it fires for, so switching app.tenant_id before COMMIT cannot hide an unbalanced entry.
--   * Postings are written only in the transaction that created their entry (immutable entries; corrections
--     are reversing entries — `reverses_id`, at most one reversal per entry).
--   * No journal entry dated in a closed period (MB009 period_closed). Entry and close serialise on a
--     per-tenant-month advisory lock, so a close cannot slip in beside a concurrent entry.

------------------------------------------------------------------------------------------------------------
-- Chart and terms
------------------------------------------------------------------------------------------------------------
-- The chart is copied from the country pack's chart_of_accounts at onboarding (tenancy.provision.v1);
-- owners may add accounts. `type` uses the pack's vocabulary.
CREATE TABLE core.account (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  code       text        NOT NULL CHECK (code ~ '^[0-9A-Z][0-9A-Z.-]{0,15}$'),
  name       text        NOT NULL CHECK (name <> ''),
  type       text        NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- What the owner agreed with an aggregator (packs/finance.md §2: an ad fee is unapproved when terms say not
-- opted in or the month exceeds the cap). Validity windows never overlap per channel.
CREATE TABLE core.channel_terms (
  tenant_id          uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                 uuid        NOT NULL,
  channel_id         uuid        NOT NULL,
  commission_bp      integer     NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  ads_opted_in       boolean     NOT NULL,
  ad_spend_cap_minor bigint      CHECK (ad_spend_cap_minor >= 0),
  promo_share_bp     integer     NOT NULL CHECK (promo_share_bp BETWEEN 0 AND 10000),
  payout_cycle_days  integer     NOT NULL CHECK (payout_cycle_days BETWEEN 1 AND 90),
  currency           char(3)     NOT NULL,
  valid_from         date        NOT NULL,
  valid_to           date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (ads_opted_in OR ad_spend_cap_minor IS NULL),
  CONSTRAINT channel_terms_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, channel_id WITH =, (daterange(valid_from, valid_to, '[)')) WITH &&)
);

------------------------------------------------------------------------------------------------------------
-- Journal
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.journal_entry (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  outlet_id    uuid,
  brand_id     uuid,
  channel_id   uuid,
  entry_date   date        NOT NULL,
  source_type  text        CHECK (source_type ~ '^core\.[a-z_]+$'),
  source_id    uuid,
  posting_rule text        CHECK (posting_rule ~ '^[a-z_]+\.[a-z_]+$'),
  reverses_id  uuid,
  decision_id  uuid,
  memo_key     text        CHECK (memo_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  -- Set by the trigger to the transaction's start time (postings check it — see posting_with_entry).
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT journal_entry_one_reversal UNIQUE (tenant_id, reverses_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES core.brand (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES core.journal_entry (tenant_id, id),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES core.decision (tenant_id, id),
  CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CHECK (posting_rule IS NULL OR source_id IS NOT NULL),
  CHECK (reverses_id IS NULL OR reverses_id <> id)
);
-- The same source event posted twice under one rule → refused (T-026: same event twice → 1 entry).
CREATE UNIQUE INDEX journal_entry_one_per_source_rule ON core.journal_entry (tenant_id, posting_rule, source_type, source_id)
  WHERE posting_rule IS NOT NULL AND reverses_id IS NULL;

CREATE TABLE core.posting (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  journal_entry_id uuid        NOT NULL,
  account_id       uuid        NOT NULL,
  amount_minor     bigint      NOT NULL CHECK (amount_minor <> 0),
  currency         char(3)     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES core.journal_entry (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES core.account (tenant_id, id)
);

-- A closed month for one outlet (outlet_id set) or the whole business (NULL). Permanent in v1.
CREATE TABLE core.period_close (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  outlet_id    uuid,
  period_month date        NOT NULL CHECK (extract(day FROM period_month) = 1),
  checklist    jsonb       NOT NULL CHECK (jsonb_typeof(checklist) = 'array'),
  net_minor    bigint      NOT NULL,
  currency     char(3)     NOT NULL,
  closed_by    uuid        NOT NULL,
  closed_at    timestamptz NOT NULL DEFAULT now(),
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES core.member (tenant_id, id)
);
CREATE UNIQUE INDEX period_close_one_per_month ON core.period_close
  (tenant_id, (coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid)), period_month);

------------------------------------------------------------------------------------------------------------
-- Settlements, bank lines, breaks (rows arrive through approved imports, R28)
------------------------------------------------------------------------------------------------------------
-- import_run_id gets its FK in 0009 (core.import_run is created there).
CREATE TABLE core.settlement (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  channel_id    uuid        NOT NULL,
  outlet_id     uuid,
  period_from   date        NOT NULL,
  period_to     date        NOT NULL,
  paid_on       date,
  external_ref  text        NOT NULL CHECK (external_ref <> ''),
  net_minor     bigint      NOT NULL,
  currency      char(3)     NOT NULL,
  import_run_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT settlement_external_ref_unique UNIQUE (tenant_id, channel_id, external_ref),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (period_to >= period_from)
);

-- One payout line. Fees are non-negative deductions; net = gross − commission − ad fee − promo share − tax
-- withheld on every line (an ad-fee line has gross 0 and a negative net).
CREATE TABLE core.settlement_line (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,
  settlement_id      uuid        NOT NULL,
  line_no            integer     NOT NULL CHECK (line_no >= 1),
  line_kind          text        NOT NULL CHECK (line_kind IN ('order', 'ad_fee', 'promo_share', 'adjustment', 'other')),
  external_order_ref text,
  matched_order_id   uuid,
  gross_minor        bigint      NOT NULL DEFAULT 0,
  commission_minor   bigint      NOT NULL DEFAULT 0 CHECK (commission_minor >= 0),
  ad_fee_minor       bigint      NOT NULL DEFAULT 0 CHECK (ad_fee_minor >= 0),
  promo_share_minor  bigint      NOT NULL DEFAULT 0 CHECK (promo_share_minor >= 0),
  tax_withheld_minor bigint      NOT NULL DEFAULT 0 CHECK (tax_withheld_minor >= 0),
  net_minor          bigint      NOT NULL,
  currency           char(3)     NOT NULL,
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, settlement_id, line_no),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES core.settlement (tenant_id, id),
  FOREIGN KEY (tenant_id, matched_order_id) REFERENCES core."order" (tenant_id, id),
  CHECK (net_minor = gross_minor - commission_minor - ad_fee_minor - promo_share_minor - tax_withheld_minor),
  CHECK (line_kind <> 'order' OR gross_minor >= 0),
  CHECK (matched_order_id IS NULL OR line_kind = 'order')
);

-- One bank-statement line: credits positive, debits negative. method + payee_vpa let a UPI credit be
-- matched to the outlet's own VPA (packs/finance.md: the QR-swap pattern).
CREATE TABLE core.bank_line (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  outlet_id     uuid,
  account_ref   text        NOT NULL CHECK (account_ref <> ''),
  value_date    date        NOT NULL,
  amount_minor  bigint      NOT NULL CHECK (amount_minor <> 0),
  currency      char(3)     NOT NULL,
  method        text        NOT NULL CHECK (method IN ('upi', 'card', 'bank_transfer', 'neft', 'imps', 'rtgs',
                                                       'cash_deposit', 'cheque', 'fee', 'other')),
  payee_vpa     text        CHECK (payee_vpa ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9]{1,63}$'),
  narration     text,
  external_ref  text        NOT NULL CHECK (external_ref <> ''),
  import_run_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT bank_line_external_ref_unique UNIQUE (tenant_id, account_ref, external_ref),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (payee_vpa IS NULL OR method = 'upi')
);

------------------------------------------------------------------------------------------------------------
-- Disputes (book, orchestrator ruling) — recorded and printed for the owner to send; Munim never sends
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.dispute (
  tenant_id           uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                  uuid        NOT NULL,
  counterparty        text        NOT NULL CHECK (counterparty IN ('channel', 'supplier')),
  channel_id          uuid,
  supplier_id         uuid,
  supplier_invoice_id uuid,
  basis               text        NOT NULL CHECK (basis IN ('unapproved_ad_fee', 'short_payout', 'missing_payout',
                                                            'overbilled', 'duplicate_invoice', 'other')),
  total_claimed_minor bigint      NOT NULL CHECK (total_claimed_minor > 0),
  currency            char(3)     NOT NULL,
  status              text        NOT NULL DEFAULT 'recorded'
                        CHECK (status IN ('recorded', 'sent', 'resolved', 'rejected', 'withdrawn')),
  resolved_minor      bigint      CHECK (resolved_minor >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  origin              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES core.supplier_invoice (tenant_id, id),
  CHECK ((counterparty = 'channel') = (channel_id IS NOT NULL)),
  CHECK ((counterparty = 'supplier') = (supplier_id IS NOT NULL)),
  CHECK (supplier_invoice_id IS NULL OR counterparty = 'supplier')
);

CREATE TABLE core.dispute_line (
  tenant_id                uuid    NOT NULL,
  id                       uuid    NOT NULL,
  dispute_id               uuid    NOT NULL,
  line_no                  integer NOT NULL CHECK (line_no >= 1),
  settlement_line_id       uuid,
  order_id                 uuid,
  supplier_invoice_line_id uuid,
  claimed_minor            bigint  NOT NULL CHECK (claimed_minor > 0),
  currency                 char(3) NOT NULL,
  origin                   jsonb   NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, dispute_id, line_no),
  FOREIGN KEY (tenant_id, dispute_id) REFERENCES core.dispute (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_line_id) REFERENCES core.settlement_line (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES core."order" (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_invoice_line_id) REFERENCES core.supplier_invoice_line (tenant_id, id),
  CHECK (num_nonnulls(settlement_line_id, order_id, supplier_invoice_line_id) = 1)
);

-- Operational (02-schema §2.7): computed by the finance module after an approved import; dashboards show
-- breaks only through snapshots.
CREATE TABLE core.reconciliation_break (
  tenant_id          uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                 uuid        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('short_payout', 'missing_payout', 'unapproved_deduction',
                                                          'tender_gap', 'unmatched_bank_line', 'other')),
  channel_id         uuid,
  outlet_id          uuid,
  settlement_line_id uuid,
  order_id           uuid,
  bank_line_id       uuid,
  import_run_id      uuid,
  amount_minor       bigint      NOT NULL,
  currency           char(3)     NOT NULL,
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'disputed', 'resolved', 'written_off')),
  dispute_id         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_line_id) REFERENCES core.settlement_line (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES core."order" (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_line_id) REFERENCES core.bank_line (tenant_id, id),
  FOREIGN KEY (tenant_id, dispute_id) REFERENCES core.dispute (tenant_id, id),
  CHECK ((status = 'disputed') = (dispute_id IS NOT NULL) OR status IN ('resolved', 'written_off'))
);

------------------------------------------------------------------------------------------------------------
-- Budgets, expenses, payables, receivables, tax drafts
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.budget (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  outlet_id    uuid,
  category     text        NOT NULL CHECK (category IN ('purchases', 'labour', 'marketing', 'utilities', 'maintenance', 'other')),
  period_month date        NOT NULL CHECK (extract(day FROM period_month) = 1),
  amount_minor bigint      NOT NULL CHECK (amount_minor >= 0),
  currency     char(3)     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id)
);
CREATE UNIQUE INDEX budget_one_per_category_month ON core.budget
  (tenant_id, (coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid)), category, period_month);

-- `utilities` rows feed compliance.energy_per_order. document_id gets its FK in 0009.
CREATE TABLE core.expense (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  outlet_id    uuid,
  category     text        NOT NULL CHECK (category IN ('rent', 'utilities', 'repairs', 'marketing', 'packaging',
                                                        'bank_charges', 'professional_fees', 'other')),
  incurred_on  date        NOT NULL,
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  tax_minor    bigint      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  currency     char(3)     NOT NULL,
  payee        text        NOT NULL CHECK (payee <> ''),
  note         text,
  document_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (tax_minor <= amount_minor)
);

CREATE TABLE core.payable (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  supplier_id  uuid,
  payee        text        CHECK (payee <> ''),
  source_type  text        CHECK (source_type ~ '^core\.[a-z_]+$'),
  source_id    uuid,
  due_on       date        NOT NULL,
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  currency     char(3)     NOT NULL,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'disputed', 'void')),
  paid_on      date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  CHECK (supplier_id IS NOT NULL OR payee IS NOT NULL),
  CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL))
);

CREATE TABLE core.receivable (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  channel_id   uuid,
  customer_id  uuid,
  supplier_id  uuid,
  dispute_id   uuid,
  source_type  text        CHECK (source_type ~ '^core\.[a-z_]+$'),
  source_id    uuid,
  due_on       date,
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  currency     char(3)     NOT NULL,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received', 'written_off', 'void')),
  received_on  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES core.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, dispute_id) REFERENCES core.dispute (tenant_id, id),
  CHECK (num_nonnulls(channel_id, customer_id, supplier_id) = 1),
  CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CHECK ((status = 'received') = (received_on IS NOT NULL))
);

-- A prepared return the owner files elsewhere; return_code is a pack compliance_calendar code.
CREATE TABLE core.tax_return_draft (
  tenant_id         uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                uuid        NOT NULL,
  outlet_id         uuid,
  return_code       text        NOT NULL CHECK (return_code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  period_from       date        NOT NULL,
  period_to         date        NOT NULL,
  output_tax_minor  bigint      NOT NULL CHECK (output_tax_minor >= 0),
  input_tax_minor   bigint      NOT NULL CHECK (input_tax_minor >= 0),
  net_payable_minor bigint      NOT NULL,
  currency          char(3)     NOT NULL,
  status            text        NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'filed_externally', 'void')),
  filed_ref         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (period_to >= period_from),
  CHECK (net_payable_minor = output_tax_minor - input_tax_minor),
  CHECK ((status = 'filed_externally') = (filed_ref IS NOT NULL))
);

------------------------------------------------------------------------------------------------------------
-- Functions
------------------------------------------------------------------------------------------------------------
-- Closed-period refusal (MB009) and the entry's creation stamp. Takes the tenant-month lock in SHARE mode;
-- period_close takes it EXCLUSIVE, so whichever commits second sees the other.
CREATE FUNCTION core.journal_entry_open_period() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.created_at := now();
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('core.period:' || NEW.tenant_id::text || ':' || to_char(NEW.entry_date, 'YYYY-MM'), 0));
  IF EXISTS (SELECT 1 FROM core.period_close pc
              WHERE pc.tenant_id = NEW.tenant_id
                AND pc.period_month = date_trunc('month', NEW.entry_date)::date
                AND (pc.outlet_id IS NULL OR NEW.outlet_id IS NULL OR pc.outlet_id = NEW.outlet_id)) THEN
    RAISE EXCEPTION 'period_closed: % is in a closed period', NEW.entry_date USING ERRCODE = 'MB009';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.journal_entry_open_period() FROM PUBLIC;

CREATE FUNCTION core.period_close_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('core.period:' || NEW.tenant_id::text || ':' || to_char(NEW.period_month, 'YYYY-MM'), 0));
  NEW.closed_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.period_close_lock() FROM PUBLIC;

-- A posting joins an entry created in this same transaction (entries are immutable once committed).
CREATE FUNCTION core.posting_with_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.journal_entry je
                  WHERE je.tenant_id = NEW.tenant_id AND je.id = NEW.journal_entry_id AND je.created_at = now()) THEN
    RAISE EXCEPTION 'books_unbalanced: postings are written with their journal entry, in its transaction'
      USING ERRCODE = 'MB010', HINT = 'correct a committed entry with a reversing entry';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.posting_with_entry() FROM PUBLIC;

-- Deferred to COMMIT: the entry has ≥ 2 postings and Σ amount_minor = 0 per currency. Refuses when the
-- entry (or the firing posting) is not visible in the committing context.
CREATE FUNCTION core.journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  entry uuid;
  n     integer;
  bad   text;
BEGIN
  IF TG_TABLE_NAME = 'posting' THEN
    entry := NEW.journal_entry_id;
    IF NOT EXISTS (SELECT 1 FROM core.posting p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.id) THEN
      RAISE EXCEPTION 'books_unbalanced: posting % is not visible at commit; cannot verify its entry', NEW.id
        USING ERRCODE = 'MB010';
    END IF;
  ELSE
    entry := NEW.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.journal_entry je WHERE je.tenant_id = NEW.tenant_id AND je.id = entry) THEN
    RAISE EXCEPTION 'books_unbalanced: journal entry % is not visible at commit; cannot verify it', entry
      USING ERRCODE = 'MB010';
  END IF;
  SELECT count(*) INTO n FROM core.posting p WHERE p.tenant_id = NEW.tenant_id AND p.journal_entry_id = entry;
  IF n < 2 THEN
    RAISE EXCEPTION 'books_unbalanced: journal entry % has % posting(s); at least 2 are required', entry, n
      USING ERRCODE = 'MB010';
  END IF;
  SELECT string_agg(x.currency, ', ') INTO bad
    FROM (SELECT p.currency FROM core.posting p
           WHERE p.tenant_id = NEW.tenant_id AND p.journal_entry_id = entry
           GROUP BY p.currency HAVING sum(p.amount_minor) <> 0) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'books_unbalanced: journal entry % does not balance in %', entry, bad USING ERRCODE = 'MB010';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION core.journal_entry_balanced() FROM PUBLIC;

CREATE TRIGGER period_open BEFORE INSERT ON core.journal_entry
  FOR EACH ROW EXECUTE FUNCTION core.journal_entry_open_period();
CREATE TRIGGER posting_with_entry BEFORE INSERT ON core.posting
  FOR EACH ROW EXECUTE FUNCTION core.posting_with_entry();
CREATE CONSTRAINT TRIGGER entry_balanced AFTER INSERT ON core.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.journal_entry_balanced();
CREATE CONSTRAINT TRIGGER posting_balanced AFTER INSERT ON core.posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.journal_entry_balanced();
CREATE TRIGGER period_lock BEFORE INSERT ON core.period_close
  FOR EACH ROW EXECUTE FUNCTION core.period_close_lock();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.reconciliation_break
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.account          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.channel_terms    FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.journal_entry    FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.posting          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.period_close     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.settlement       FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.settlement_line  FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.bank_line        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.dispute          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.dispute_line     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.budget           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.expense          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.payable          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.receivable       FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.tax_return_draft FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.channel_terms        FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.posting              FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.period_close         FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.settlement           FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.settlement_line      FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.bank_line            FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.dispute              FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.dispute_line         FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.reconciliation_break FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.budget               FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.expense              FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.payable              FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.receivable           FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.tax_return_draft     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

------------------------------------------------------------------------------------------------------------
-- RLS (tenant policy on every table here)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'channel_terms', 'journal_entry', 'posting', 'period_close', 'settlement',
                           'settlement_line', 'bank_line', 'dispute', 'dispute_line', 'reconciliation_break',
                           'budget', 'expense', 'payable', 'receivable', 'tax_return_draft'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON core.%I
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))$p$, t);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- Tags (R29; channel_terms and dispute are books by orchestrator ruling)
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.account              IS 'munim:book';
COMMENT ON TABLE core.channel_terms        IS 'munim:book';
COMMENT ON TABLE core.journal_entry        IS 'munim:book';
COMMENT ON TABLE core.posting              IS 'munim:book';
COMMENT ON TABLE core.period_close         IS 'munim:book';
COMMENT ON TABLE core.settlement           IS 'munim:book';
COMMENT ON TABLE core.settlement_line      IS 'munim:book';
COMMENT ON TABLE core.bank_line            IS 'munim:book';
COMMENT ON TABLE core.dispute              IS 'munim:book';
COMMENT ON TABLE core.dispute_line         IS 'munim:book';
COMMENT ON TABLE core.budget               IS 'munim:book';
COMMENT ON TABLE core.expense              IS 'munim:book';
COMMENT ON TABLE core.payable              IS 'munim:book';
COMMENT ON TABLE core.receivable           IS 'munim:book';
COMMENT ON TABLE core.tax_return_draft     IS 'munim:book';
COMMENT ON TABLE core.reconciliation_break IS 'munim:operational';

------------------------------------------------------------------------------------------------------------
-- Grants. Journal, postings, settlements, bank lines, period closes and dispute lines are append-only.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.account, core.channel_terms, core.journal_entry, core.posting, core.period_close, core.settlement,
  core.settlement_line, core.bank_line, core.dispute, core.dispute_line, core.reconciliation_break, core.budget,
  core.expense, core.payable, core.receivable, core.tax_return_draft FROM PUBLIC;

GRANT SELECT ON core.account, core.channel_terms, core.journal_entry, core.posting, core.period_close, core.settlement,
  core.settlement_line, core.bank_line, core.dispute, core.dispute_line, core.reconciliation_break, core.budget,
  core.expense, core.payable, core.receivable, core.tax_return_draft TO munim_core, munim_svc;

GRANT INSERT ON core.account, core.channel_terms, core.journal_entry, core.posting, core.period_close, core.settlement,
  core.settlement_line, core.bank_line, core.dispute, core.dispute_line, core.reconciliation_break, core.budget,
  core.expense, core.payable, core.receivable, core.tax_return_draft TO munim_core;

GRANT UPDATE (name, active) ON core.account TO munim_core;
GRANT UPDATE (valid_to) ON core.channel_terms TO munim_core;
GRANT UPDATE (status, resolved_minor) ON core.dispute TO munim_core;
GRANT UPDATE (status, dispute_id) ON core.reconciliation_break TO munim_core;
GRANT UPDATE (amount_minor) ON core.budget TO munim_core;
GRANT UPDATE (status, paid_on) ON core.payable TO munim_core;
GRANT UPDATE (status, received_on) ON core.receivable TO munim_core;
GRANT UPDATE (status, filed_ref) ON core.tax_return_draft TO munim_core;

------------------------------------------------------------------------------------------------------------
-- Indexes: every tenant-leading FK, plus read paths
------------------------------------------------------------------------------------------------------------
CREATE INDEX channel_terms_channel_id_fk_idx ON core.channel_terms (tenant_id, channel_id);
CREATE INDEX journal_entry_outlet_id_fk_idx ON core.journal_entry (tenant_id, outlet_id);
CREATE INDEX journal_entry_brand_id_fk_idx ON core.journal_entry (tenant_id, brand_id);
CREATE INDEX journal_entry_channel_id_fk_idx ON core.journal_entry (tenant_id, channel_id);
CREATE INDEX journal_entry_decision_id_fk_idx ON core.journal_entry (tenant_id, decision_id);
CREATE INDEX journal_entry_entry_date_idx ON core.journal_entry (tenant_id, entry_date);
CREATE INDEX posting_journal_entry_id_fk_idx ON core.posting (tenant_id, journal_entry_id);
CREATE INDEX posting_account_id_fk_idx ON core.posting (tenant_id, account_id);
CREATE INDEX period_close_outlet_id_fk_idx ON core.period_close (tenant_id, outlet_id);
CREATE INDEX period_close_closed_by_fk_idx ON core.period_close (tenant_id, closed_by);
CREATE INDEX settlement_outlet_id_fk_idx ON core.settlement (tenant_id, outlet_id);
CREATE INDEX settlement_line_matched_order_id_fk_idx ON core.settlement_line (tenant_id, matched_order_id);
CREATE INDEX bank_line_outlet_id_fk_idx ON core.bank_line (tenant_id, outlet_id);
CREATE INDEX dispute_channel_id_fk_idx ON core.dispute (tenant_id, channel_id);
CREATE INDEX dispute_supplier_id_fk_idx ON core.dispute (tenant_id, supplier_id);
CREATE INDEX dispute_supplier_invoice_id_fk_idx ON core.dispute (tenant_id, supplier_invoice_id);
CREATE INDEX dispute_line_settlement_line_id_fk_idx ON core.dispute_line (tenant_id, settlement_line_id);
CREATE INDEX dispute_line_order_id_fk_idx ON core.dispute_line (tenant_id, order_id);
CREATE INDEX dispute_line_supplier_invoice_line_id_fk_idx ON core.dispute_line (tenant_id, supplier_invoice_line_id);
CREATE INDEX reconciliation_break_channel_id_fk_idx ON core.reconciliation_break (tenant_id, channel_id);
CREATE INDEX reconciliation_break_outlet_id_fk_idx ON core.reconciliation_break (tenant_id, outlet_id);
CREATE INDEX reconciliation_break_settlement_line_id_fk_idx ON core.reconciliation_break (tenant_id, settlement_line_id);
CREATE INDEX reconciliation_break_order_id_fk_idx ON core.reconciliation_break (tenant_id, order_id);
CREATE INDEX reconciliation_break_bank_line_id_fk_idx ON core.reconciliation_break (tenant_id, bank_line_id);
CREATE INDEX reconciliation_break_dispute_id_fk_idx ON core.reconciliation_break (tenant_id, dispute_id);
CREATE INDEX budget_outlet_id_fk_idx ON core.budget (tenant_id, outlet_id);
CREATE INDEX expense_outlet_id_fk_idx ON core.expense (tenant_id, outlet_id);
CREATE INDEX payable_supplier_id_fk_idx ON core.payable (tenant_id, supplier_id);
CREATE INDEX receivable_channel_id_fk_idx ON core.receivable (tenant_id, channel_id);
CREATE INDEX receivable_customer_id_fk_idx ON core.receivable (tenant_id, customer_id);
CREATE INDEX receivable_supplier_id_fk_idx ON core.receivable (tenant_id, supplier_id);
CREATE INDEX receivable_dispute_id_fk_idx ON core.receivable (tenant_id, dispute_id);
CREATE INDEX tax_return_draft_outlet_id_fk_idx ON core.tax_return_draft (tenant_id, outlet_id);

------------------------------------------------------------------------------------------------------------
-- Derivation rules (03-architecture §1.3 branch 3). Ids match packages/core-domain rules (T-024, T-025,
-- T-026). The guard checks that the source row exists; the module checks its state (e.g. an approved
-- supplier invoice) before it derives.
------------------------------------------------------------------------------------------------------------
INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  -- Posting rules (T-026): order completed, tender, GRN, approved supplier invoice, approved settlement.
  ('finance.post_order',            'core.order',            'core.journal_entry'),
  ('finance.post_order',            'core.order',            'core.posting'),
  ('finance.post_tender',           'core.tender',           'core.journal_entry'),
  ('finance.post_tender',           'core.tender',           'core.posting'),
  ('finance.post_grn',              'core.goods_received',   'core.journal_entry'),
  ('finance.post_grn',              'core.goods_received',   'core.posting'),
  ('finance.post_supplier_invoice', 'core.supplier_invoice', 'core.journal_entry'),
  ('finance.post_supplier_invoice', 'core.supplier_invoice', 'core.posting'),
  ('finance.post_settlement',       'core.settlement',       'core.journal_entry'),
  ('finance.post_settlement',       'core.settlement',       'core.posting'),
  -- An approved supplier invoice raises its payable (T-025 "payables link"; INFERENCE).
  ('purchasing.payable_from_invoice', 'core.supplier_invoice', 'core.payable'),
  -- Stock movements derived from their source documents (T-024, T-025).
  ('inventory.receive_grn',         'core.goods_received',   'core.stock_movement'),
  ('inventory.record_waste',        'core.waste_log',        'core.stock_movement'),
  ('inventory.transfer_out',        'core.transfer',         'core.stock_movement'),
  ('inventory.transfer_in',         'core.transfer',         'core.stock_movement'),
  ('inventory.supplier_return',     'core.supplier_return',  'core.stock_movement'),
  ('inventory.sale_return',         'core.sale_return',      'core.stock_movement');

------------------------------------------------------------------------------------------------------------
-- Command authority (R27) with table bindings. Names from packs/finance.md §6 / §10 where given; the rest
-- INFERENCE. imports.run.commit.v1 is the import-run draft (R28); its row is here because settlement and
-- bank lines have no other writer (0011 adds core.review to it).
------------------------------------------------------------------------------------------------------------
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.account']
 WHERE command_type = 'tenancy.provision.v1';

INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('finance.account.upsert.v1',     ARRAY['owner', 'judge'],            'tenant', ARRAY['core.account']),
  ('finance.channel_terms.set.v1',  ARRAY['owner', 'judge'],            'tenant', ARRAY['core.channel_terms']),
  ('finance.budget.set.v1',         ARRAY['owner', 'judge'],            'outlet', ARRAY['core.budget']),
  ('finance.expense.record.v1',     ARRAY['owner', 'manager', 'judge'], 'outlet', ARRAY['core.expense']),
  ('finance.payable.update.v1',     ARRAY['owner', 'judge'],            'tenant', ARRAY['core.payable']),
  ('finance.receivable.update.v1',  ARRAY['owner', 'judge'],            'tenant', ARRAY['core.receivable']),
  ('finance.tax_return.prepare.v1', ARRAY['owner', 'judge'],            'outlet', ARRAY['core.tax_return_draft']),
  ('finance.journal.adjust.v1',     ARRAY['owner', 'judge'],            'tenant',
                                    ARRAY['core.journal_entry', 'core.posting', 'core.receivable']),
  ('finance.dispute.draft.v1',      ARRAY['owner', 'judge'],            'tenant', ARRAY['core.dispute', 'core.dispute_line']),
  ('finance.dispute.update.v1',     ARRAY['owner', 'judge'],            'tenant', ARRAY['core.dispute']),
  ('finance.period.close.v1',       ARRAY['owner', 'judge'],            'outlet', ARRAY['core.period_close']),
  ('purchasing.invoice.dispute.v1', ARRAY['owner', 'manager', 'judge'], 'tenant', ARRAY['core.dispute', 'core.dispute_line']),
  ('imports.run.commit.v1',         ARRAY['owner', 'manager', 'judge'], 'tenant',
                                    ARRAY['core.settlement', 'core.settlement_line', 'core.bank_line', 'core.expense',
                                          'core.supplier_invoice', 'core.supplier_invoice_line']);

------------------------------------------------------------------------------------------------------------
-- Post-conditions
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  -- The two balance triggers are deferred constraint triggers (they must run at COMMIT, not per statement).
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgfoid = 'core.journal_entry_balanced()'::regprocedure
         AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND t.tgrelid IN ('core.journal_entry'::regclass, 'core.posting'::regclass)) <> 2 THEN
    RAISE EXCEPTION '0008: balance triggers are not two deferred constraint triggers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_terms_no_overlap' AND contype = 'x'
                    AND conrelid = 'core.channel_terms'::regclass) THEN
    RAISE EXCEPTION '0008: channel_terms_no_overlap exclusion constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'core.journal_entry_one_per_source_rule'::regclass
                    AND i.indisunique AND i.indpred IS NOT NULL AND i.indnatts = 4) THEN
    RAISE EXCEPTION '0008: journal_entry_one_per_source_rule is not the partial unique index written here';
  END IF;
  PERFORM munim_meta.assert_catalog('0008');
END $$;
