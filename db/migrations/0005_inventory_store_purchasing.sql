-- 0005_inventory_store_purchasing — inventory (02-schema §2.5), purchasing (§2.6), the store pack (R34:
-- barcodes are on item/variant in 0004; batches with expiry, MRP, supplier returns, sale returns) and the
-- expired-sale override record (ledger R40 C7). Runs as munim_migrator. All tables here are books.
-- RLS predicates: see the header of 0003.

-- MRP (maximum retail price, store pack): optional per item; a batch may carry its own printed MRP.
-- `currency` is the currency of mrp_minor (the item's only money column).
ALTER TABLE core.item
  ADD COLUMN mrp_minor bigint  CHECK (mrp_minor > 0),
  ADD COLUMN currency  char(3),
  ADD CONSTRAINT item_mrp_pair CHECK ((mrp_minor IS NULL) = (currency IS NULL));
GRANT UPDATE (mrp_minor, currency) ON core.item TO munim_core;
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.item
  FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

------------------------------------------------------------------------------------------------------------
-- Purchasing masters
------------------------------------------------------------------------------------------------------------
-- kind = 'simulated' are the suppliers-sim agents; always labelled "Simulated supplier" (project rule 12).
CREATE TABLE core.supplier (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  name         text        NOT NULL CHECK (name <> ''),
  kind         text        NOT NULL CHECK (kind IN ('real', 'simulated')),
  a2a_card_url text        CHECK (a2a_card_url ~ '^https?://\S+$'),
  terms        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(terms) = 'object'),
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- Inventory
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.batch (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  ingredient_id uuid        NOT NULL,
  batch_code    text        NOT NULL CHECK (batch_code <> ''),
  expires_on    date,
  received_at   timestamptz NOT NULL DEFAULT now(),
  supplier_id   uuid,
  mrp_minor     bigint      CHECK (mrp_minor > 0),
  currency      char(3),
  -- The receiving line; its FK is added after core.grn_line exists (grn_line also points at batch).
  grn_line_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),
  UNIQUE (tenant_id, outlet_id, ingredient_id, batch_code),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  CHECK ((mrp_minor IS NULL) = (currency IS NULL))
);

-- R40 C7: a manager or owner, as themselves, permits one sale line to draw a quantity from one expired
-- batch, with reason code + note. Single use: used_at is set once (second use refused, MB005). Whether
-- overrides exist at all is the country-pack flag expired_sale_override (default false) — read by core.
-- The order line is bound up front (client-generated id); the FK is deferred so the override and the
-- line can be written in the same placement transaction.
CREATE TABLE core.expired_sale_override (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  order_line_id uuid        NOT NULL,
  batch_id      uuid        NOT NULL,
  qty_milli     bigint      NOT NULL CHECK (qty_milli > 0),
  reason_code   text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  note          text        NOT NULL CHECK (note <> ''),
  decided_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  used_at       timestamptz,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, batch_id),
  UNIQUE (tenant_id, order_line_id, batch_id),
  FOREIGN KEY (tenant_id, outlet_id, batch_id) REFERENCES core.batch (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES core.order_line (tenant_id, id) DEFERRABLE INITIALLY DEFERRED
);

-- Append-only; on-hand = Σ qty_milli (negative on-hand allowed, raises an alert in core). The sign is
-- fixed by kind. A sale from an expired batch cites its override (same batch, enforced by the FK).
CREATE TABLE core.stock_movement (
  tenant_id                uuid        NOT NULL,
  id                       uuid        NOT NULL,
  outlet_id                uuid        NOT NULL,
  ingredient_id            uuid        NOT NULL,
  batch_id                 uuid,
  qty_milli                bigint      NOT NULL,
  unit                     text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  kind                     text        NOT NULL CHECK (kind IN ('receipt', 'sale_consumption', 'waste', 'transfer_out',
                                         'transfer_in', 'count_adjust', 'supplier_return', 'sale_return')),
  ref_type                 text        CHECK (ref_type ~ '^core\.[a-z_]+$'),
  ref_id                   uuid,
  unit_cost_minor          bigint      CHECK (unit_cost_minor >= 0),
  currency                 char(3),
  expired_sale_override_id uuid,
  at                       timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  origin                   jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, batch_id) REFERENCES core.batch (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, expired_sale_override_id, batch_id)
    REFERENCES core.expired_sale_override (tenant_id, id, batch_id),
  CHECK (CASE WHEN kind IN ('receipt', 'transfer_in', 'sale_return') THEN qty_milli > 0
              WHEN kind IN ('sale_consumption', 'waste', 'transfer_out', 'supplier_return') THEN qty_milli < 0
              ELSE qty_milli <> 0 END),
  CHECK ((unit_cost_minor IS NULL) = (currency IS NULL)),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CHECK (expired_sale_override_id IS NULL OR (kind = 'sale_consumption' AND batch_id IS NOT NULL))
);

CREATE TABLE core.stock_count (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  counted_by uuid        NOT NULL,
  counted_at timestamptz NOT NULL DEFAULT now(),
  status     text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'cancelled')),
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, counted_by) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.stock_count_line (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL,
  stock_count_id    uuid        NOT NULL,
  ingredient_id     uuid        NOT NULL,
  batch_id          uuid,
  -- On-hand per the movements when the line was counted; variance = counted − expected.
  expected_qty_milli bigint     NOT NULL,
  counted_qty_milli bigint      NOT NULL CHECK (counted_qty_milli >= 0),
  unit              text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, stock_count_id) REFERENCES core.stock_count (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES core.batch (tenant_id, id)
);

CREATE TABLE core.reorder_level (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  ingredient_id uuid        NOT NULL,
  min_qty_milli bigint      NOT NULL CHECK (min_qty_milli >= 0),
  par_qty_milli bigint      NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, ingredient_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  CHECK (par_qty_milli >= min_qty_milli)
);

CREATE TABLE core.waste_log (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  ingredient_id uuid        NOT NULL,
  batch_id      uuid,
  qty_milli     bigint      NOT NULL CHECK (qty_milli > 0),
  unit          text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  reason        text        NOT NULL CHECK (reason IN ('temperature', 'overprep', 'expired', 'damaged', 'other')),
  note          text,
  recorded_by   uuid        NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, batch_id) REFERENCES core.batch (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES core.member (tenant_id, id),
  CHECK (reason <> 'other' OR coalesce(note, '') <> '')
);

------------------------------------------------------------------------------------------------------------
-- Purchasing. A PO exists only once committed; proposals are core.draft rows (02-schema §2.6).
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.supplier_price (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  supplier_id      uuid        NOT NULL,
  ingredient_id    uuid        NOT NULL,
  unit             text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_price_minor bigint      NOT NULL CHECK (unit_price_minor >= 0),
  currency         char(3)     NOT NULL,
  observed_at      timestamptz NOT NULL,
  source_ref       text        NOT NULL CHECK (source_ref <> ''),
  created_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id)
);

CREATE TABLE core.purchase_order (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,
  supplier_id        uuid        NOT NULL,
  outlet_ids         uuid[]      NOT NULL CHECK (cardinality(outlet_ids) >= 1),
  status             text        NOT NULL DEFAULT 'committed' CHECK (status IN ('committed', 'received', 'cancelled')),
  currency           char(3)     NOT NULL,
  total_minor        bigint      NOT NULL CHECK (total_minor >= 0),
  expected_on        date,
  negotiation_run_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, negotiation_run_id) REFERENCES intel.run (tenant_id, id)
);

CREATE TABLE core.po_line (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  po_id            uuid        NOT NULL,
  line_no          integer     NOT NULL CHECK (line_no >= 1),
  ingredient_id    uuid        NOT NULL,
  qty_milli        bigint      NOT NULL CHECK (qty_milli > 0),
  unit             text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_price_minor bigint      NOT NULL CHECK (unit_price_minor >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, po_id, line_no),
  FOREIGN KEY (tenant_id, po_id) REFERENCES core.purchase_order (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id)
);

CREATE TABLE core.goods_received (
  tenant_id   uuid        NOT NULL,
  id          uuid        NOT NULL,
  outlet_id   uuid        NOT NULL,
  supplier_id uuid        NOT NULL,
  po_id       uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid        NOT NULL,
  note        text,
  origin      jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, po_id) REFERENCES core.purchase_order (tenant_id, id),
  FOREIGN KEY (tenant_id, received_by) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.grn_line (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL,
  goods_received_id uuid        NOT NULL,
  po_line_id        uuid,
  ingredient_id     uuid        NOT NULL,
  batch_id          uuid,
  qty_milli         bigint      NOT NULL CHECK (qty_milli > 0),
  unit              text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_cost_minor   bigint      NOT NULL CHECK (unit_cost_minor >= 0),
  currency          char(3)     NOT NULL,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, goods_received_id) REFERENCES core.goods_received (tenant_id, id),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES core.po_line (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES core.batch (tenant_id, id)
);
ALTER TABLE core.batch
  ADD FOREIGN KEY (tenant_id, grn_line_id) REFERENCES core.grn_line (tenant_id, id);

-- A duplicate supplier invoice number is refused (02-schema §8).
-- document_id gets its FK when core.document exists (W2, M-B 0008).
CREATE TABLE core.supplier_invoice (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL,
  supplier_id    uuid        NOT NULL,
  invoice_no     text        NOT NULL CHECK (invoice_no <> ''),
  invoice_date   date        NOT NULL,
  po_id          uuid,
  subtotal_minor bigint      NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor      bigint      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor    bigint      NOT NULL CHECK (total_minor >= 0),
  currency       char(3)     NOT NULL,
  status         text        NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'approved', 'disputed', 'void')),
  document_id    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  origin         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT supplier_invoice_no_unique UNIQUE (tenant_id, supplier_id, invoice_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, po_id) REFERENCES core.purchase_order (tenant_id, id),
  CHECK (total_minor = subtotal_minor + tax_minor)
);

CREATE TABLE core.supplier_invoice_line (
  tenant_id           uuid        NOT NULL,
  id                  uuid        NOT NULL,
  supplier_invoice_id uuid        NOT NULL,
  line_no             integer     NOT NULL CHECK (line_no >= 1),
  po_line_id          uuid,
  ingredient_id       uuid,
  description         text        CHECK (description <> ''),
  qty_milli           bigint      NOT NULL CHECK (qty_milli > 0),
  unit                text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_price_minor    bigint      NOT NULL CHECK (unit_price_minor >= 0),
  tax_minor           bigint      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  line_total_minor    bigint      NOT NULL CHECK (line_total_minor >= 0),
  origin              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, supplier_invoice_id, line_no),
  FOREIGN KEY (tenant_id, supplier_invoice_id) REFERENCES core.supplier_invoice (tenant_id, id),
  FOREIGN KEY (tenant_id, po_line_id) REFERENCES core.po_line (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  CHECK (ingredient_id IS NOT NULL OR description IS NOT NULL)
);

CREATE TABLE core.supplier_return (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL,
  outlet_id         uuid        NOT NULL,
  supplier_id       uuid        NOT NULL,
  goods_received_id uuid,
  reason_code       text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  note              text        NOT NULL CHECK (note <> ''),
  returned_by       uuid        NOT NULL,
  returned_at       timestamptz NOT NULL DEFAULT now(),
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES core.supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, goods_received_id) REFERENCES core.goods_received (tenant_id, id),
  FOREIGN KEY (tenant_id, returned_by) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.supplier_return_line (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,
  supplier_return_id uuid        NOT NULL,
  ingredient_id      uuid        NOT NULL,
  batch_id           uuid,
  qty_milli          bigint      NOT NULL CHECK (qty_milli > 0),
  unit               text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_cost_minor    bigint      NOT NULL CHECK (unit_cost_minor >= 0),
  currency           char(3)     NOT NULL,
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_return_id) REFERENCES core.supplier_return (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES core.batch (tenant_id, id)
);

-- Stock moved between two outlets of the tenant (scope rider 3). The paired transfer_out / transfer_in
-- movements cite it via ref_type/ref_id. Visible when either end is in the caller's outlet scope.
CREATE TABLE core.transfer (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL,
  from_outlet_id uuid        NOT NULL,
  to_outlet_id   uuid        NOT NULL,
  status         text        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'cancelled')),
  sent_by        uuid        NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  received_by    uuid,
  received_at    timestamptz,
  origin         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, from_outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, to_outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, sent_by) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, received_by) REFERENCES core.member (tenant_id, id),
  CHECK (from_outlet_id <> to_outlet_id),
  CHECK ((status = 'received') = (received_by IS NOT NULL AND received_at IS NOT NULL))
);

CREATE TABLE core.transfer_line (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  transfer_id   uuid        NOT NULL,
  ingredient_id uuid        NOT NULL,
  batch_id      uuid,
  qty_milli     bigint      NOT NULL CHECK (qty_milli > 0),
  unit          text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES core.transfer (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES core.batch (tenant_id, id)
);

-- Goods back from a customer against a sold line; any money back is a core.refund row.
CREATE TABLE core.sale_return (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  order_id      uuid        NOT NULL,
  order_line_id uuid        NOT NULL,
  qty_milli     bigint      NOT NULL CHECK (qty_milli > 0),
  restock       boolean     NOT NULL,
  reason_code   text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  note          text        NOT NULL CHECK (note <> ''),
  actor         uuid        NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES core.order_line (tenant_id, id),
  FOREIGN KEY (tenant_id, actor) REFERENCES core.member (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- Seeds: derivation rule and command authority
------------------------------------------------------------------------------------------------------------
-- Consumption is posted from the order by rule (02-schema §2.5); the source must be an existing order.
-- consume_order: dishes through their recipe; consume_sku: a SKU item consumes its stock_ingredient_id 1:1
-- by quantity, no recipe (rider 4, orchestrator ruling). Ids match packages/core-domain rules (T-003).
INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  ('inventory.consume_order', 'core.order', 'core.stock_movement'),
  ('inventory.consume_sku',   'core.order', 'core.stock_movement');

-- R40 C7 (roles per the orchestrator rider: manager, owner).
INSERT INTO core.command_authority (command_type, allowed_roles, scope) VALUES
  ('inventory.expired_sale.override.v1', ARRAY['owner', 'manager'], 'outlet');

------------------------------------------------------------------------------------------------------------
-- Functions
------------------------------------------------------------------------------------------------------------
-- Transfer status: sent → received | cancelled only.
CREATE FUNCTION core.transfer_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'sent' AND NEW.status IN ('received', 'cancelled')) THEN
    RAISE EXCEPTION 'illegal_transition: transfer % → %', OLD.status, NEW.status USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.transfer_transition() FROM PUBLIC;

-- R40 C7: the deciding person is the signed-in member; used_at is set once, never cleared or re-set.
CREATE FUNCTION core.expired_override_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.used_at IS NOT NULL
       OR NEW.decided_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '') THEN
      RAISE EXCEPTION 'override_refused: decided_by must be the signed-in member and the override unused'
        USING ERRCODE = 'MB005';
    END IF;
  ELSIF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN
    RAISE EXCEPTION 'override_refused: expired-sale override % is single-use', OLD.id USING ERRCODE = 'MB005';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.expired_override_rules() FROM PUBLIC;

-- Purchase order status: committed → received | cancelled only.
CREATE FUNCTION core.purchase_order_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'committed' AND NEW.status IN ('received', 'cancelled')) THEN
    RAISE EXCEPTION 'illegal_transition: purchase order % → %', OLD.status, NEW.status USING ERRCODE = 'MB004';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.purchase_order_transition() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------------------------------------
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.supplier              FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.batch                 FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.expired_sale_override FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.stock_movement        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.stock_count           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.stock_count_line      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.reorder_level         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.waste_log             FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.supplier_price        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.purchase_order        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.po_line               FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.goods_received        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.grn_line              FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.supplier_invoice      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.supplier_invoice_line FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.supplier_return       FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.supplier_return_line  FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.sale_return           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.transfer              FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.transfer_line         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.batch                FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.stock_movement       FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.supplier_price       FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.purchase_order       FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.grn_line             FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.supplier_invoice     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.supplier_return_line FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

CREATE TRIGGER override_rules BEFORE INSERT OR UPDATE ON core.expired_sale_override
  FOR EACH ROW EXECUTE FUNCTION core.expired_override_rules();
CREATE TRIGGER po_transition BEFORE UPDATE ON core.purchase_order
  FOR EACH ROW EXECUTE FUNCTION core.purchase_order_transition();
CREATE TRIGGER transfer_transition BEFORE UPDATE ON core.transfer
  FOR EACH ROW EXECUTE FUNCTION core.transfer_transition();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.reorder_level
  FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

------------------------------------------------------------------------------------------------------------
-- RLS. Outlet-scoped per 02-schema §0: batch, stock_movement, stock_count, reorder_level, waste_log,
-- goods_received; plus expired_sale_override, supplier_return and sale_return (per-outlet records).
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.supplier FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.supplier
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.stock_count_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.stock_count_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.stock_count_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.supplier_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.supplier_price FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.supplier_price
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.purchase_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.purchase_order FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.purchase_order
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.po_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.po_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.po_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.grn_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.grn_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.grn_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.supplier_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.supplier_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.supplier_invoice
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.supplier_invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.supplier_invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.supplier_invoice_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.supplier_return_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.supplier_return_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.supplier_return_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.transfer_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.transfer_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.transfer_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

-- transfer: either end inside the caller's outlet scope.
ALTER TABLE core.transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_either_end ON core.transfer
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR from_outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])
              OR to_outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR from_outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])
              OR to_outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.batch
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.expired_sale_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.expired_sale_override FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.expired_sale_override
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.stock_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.stock_movement
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.stock_count ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.stock_count FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.stock_count
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.reorder_level ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.reorder_level FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.reorder_level
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.waste_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.waste_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.waste_log
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.goods_received ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.goods_received FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.goods_received
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.supplier_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.supplier_return FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.supplier_return
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.sale_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sale_return FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.sale_return
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

------------------------------------------------------------------------------------------------------------
-- Tags (R29) — every table in this file is a book
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.supplier              IS 'munim:book';
COMMENT ON TABLE core.batch                 IS 'munim:book';
COMMENT ON TABLE core.expired_sale_override IS 'munim:book';
COMMENT ON TABLE core.stock_movement        IS 'munim:book';
COMMENT ON TABLE core.stock_count           IS 'munim:book';
COMMENT ON TABLE core.stock_count_line      IS 'munim:book';
COMMENT ON TABLE core.reorder_level         IS 'munim:book';
COMMENT ON TABLE core.waste_log             IS 'munim:book';
COMMENT ON TABLE core.supplier_price        IS 'munim:book';
COMMENT ON TABLE core.purchase_order        IS 'munim:book';
COMMENT ON TABLE core.po_line               IS 'munim:book';
COMMENT ON TABLE core.goods_received        IS 'munim:book';
COMMENT ON TABLE core.grn_line              IS 'munim:book';
COMMENT ON TABLE core.supplier_invoice      IS 'munim:book';
COMMENT ON TABLE core.supplier_invoice_line IS 'munim:book';
COMMENT ON TABLE core.supplier_return       IS 'munim:book';
COMMENT ON TABLE core.supplier_return_line  IS 'munim:book';
COMMENT ON TABLE core.sale_return           IS 'munim:book';
COMMENT ON TABLE core.transfer              IS 'munim:book';
COMMENT ON TABLE core.transfer_line         IS 'munim:book';

------------------------------------------------------------------------------------------------------------
-- Grants. Append-only books (stock_movement, waste_log, supplier_price, lines, returns) get no UPDATE.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.supplier, core.batch, core.expired_sale_override, core.stock_movement, core.stock_count,
  core.stock_count_line, core.reorder_level, core.waste_log, core.supplier_price, core.purchase_order, core.po_line,
  core.goods_received, core.grn_line, core.supplier_invoice, core.supplier_invoice_line, core.supplier_return,
  core.supplier_return_line, core.sale_return, core.transfer, core.transfer_line FROM PUBLIC;

GRANT SELECT ON core.supplier, core.batch, core.expired_sale_override, core.stock_movement, core.stock_count,
  core.stock_count_line, core.reorder_level, core.waste_log, core.supplier_price, core.purchase_order, core.po_line,
  core.goods_received, core.grn_line, core.supplier_invoice, core.supplier_invoice_line, core.supplier_return,
  core.supplier_return_line, core.sale_return, core.transfer, core.transfer_line TO munim_core, munim_svc;

GRANT INSERT ON core.supplier, core.batch, core.expired_sale_override, core.stock_movement, core.stock_count,
  core.stock_count_line, core.reorder_level, core.waste_log, core.supplier_price, core.purchase_order, core.po_line,
  core.goods_received, core.grn_line, core.supplier_invoice, core.supplier_invoice_line, core.supplier_return,
  core.supplier_return_line, core.sale_return, core.transfer, core.transfer_line TO munim_core;

GRANT UPDATE (name, a2a_card_url, terms, active) ON core.supplier TO munim_core;
GRANT UPDATE (expires_on, mrp_minor, currency) ON core.batch TO munim_core;
GRANT UPDATE (status, received_by, received_at) ON core.transfer TO munim_core;
GRANT UPDATE (used_at) ON core.expired_sale_override TO munim_core;
GRANT UPDATE (status) ON core.stock_count TO munim_core;
GRANT UPDATE (min_qty_milli, par_qty_milli) ON core.reorder_level TO munim_core;
GRANT UPDATE (status, expected_on) ON core.purchase_order TO munim_core;
GRANT UPDATE (status) ON core.supplier_invoice TO munim_core;

------------------------------------------------------------------------------------------------------------
-- Snapshot template (02-schema §7: inventory.below_reorder). Runs under the minting context's RLS.
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'inventory.below_reorder', 1,
  $tpl$SELECT r.outlet_id, r.ingredient_id, i.name AS ingredient_name,
       coalesce(sum(m.qty_milli), 0)::bigint AS on_hand_milli, r.min_qty_milli, r.par_qty_milli
  FROM core.reorder_level r
  JOIN core.ingredient i ON i.tenant_id = r.tenant_id AND i.id = r.ingredient_id
  LEFT JOIN core.stock_movement m
         ON m.tenant_id = r.tenant_id AND m.outlet_id = r.outlet_id AND m.ingredient_id = r.ingredient_id
 GROUP BY r.outlet_id, r.ingredient_id, i.name, r.min_qty_milli, r.par_qty_milli
HAVING coalesce(sum(m.qty_milli), 0) < r.min_qty_milli
 ORDER BY r.outlet_id, r.ingredient_id$tpl$,
  '{"type": "object", "properties": {}, "additionalProperties": false}',
  '[{"name": "outlet_id", "type": "uuid"},
    {"name": "ingredient_id", "type": "uuid"},
    {"name": "ingredient_name", "type": "text"},
    {"name": "on_hand_milli", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"},
    {"name": "min_qty_milli", "type": "integer", "numeric_source": "core.reorder_level.min_qty_milli"},
    {"name": "par_qty_milli", "type": "integer", "numeric_source": "core.reorder_level.par_qty_milli"}]',
  'manager');
