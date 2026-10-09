-- 0004_catalogue_orders_customer — catalogue (02-schema §2.3), orders/POS (§2.4), customer + coupon_use
-- (§2.1, §2.8), per-device per-FY gapless invoice series, the currency assertion (R30), plus the
-- orchestrator scope rider of 9 Oct: per-outlet item availability, kitchen prep lists, promised-time
-- changes on order_event. Runs as munim_migrator.
-- RLS predicates: see the header of 0003 (nullif guards; inline, no helper functions).

------------------------------------------------------------------------------------------------------------
-- Customer (book). Guest checkout creates one by the customer's own command (storefront.guest.create.v1).
-- R41: one login (idp_sub) across merchants, a separate profile per merchant; erasure anonymises the
-- personal columns and keeps the row (orders keep pointing at it).
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.customer (
  tenant_id         uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                uuid        NOT NULL,
  name              text        CHECK (name <> ''),
  phone             text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email             text,
  consent           jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(consent) = 'object'),
  is_guest          boolean     NOT NULL DEFAULT true,
  idp_sub           text,
  email_verified_at timestamptz,
  erased_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idp_sub),
  CHECK (erased_at IS NOT NULL OR name IS NOT NULL),
  CHECK (erased_at IS NULL OR (name IS NULL AND phone IS NULL AND email IS NULL AND idp_sub IS NULL))
);

------------------------------------------------------------------------------------------------------------
-- Catalogue (book)
------------------------------------------------------------------------------------------------------------
-- The stock-keeping unit. A shop SKU stocks through its stock_ingredient_id row (item kind = 'sku').
CREATE TABLE core.ingredient (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  name             text        NOT NULL CHECK (name <> ''),
  base_unit        text        NOT NULL CHECK (base_unit ~ '^[a-z][a-z_]{0,15}$'),
  shelf_life_days  integer     CHECK (shelf_life_days > 0),
  tracked_by_batch boolean     NOT NULL DEFAULT false,
  active           boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE core.item (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('dish', 'sku', 'combo')),
  name_key   text        NOT NULL CHECK (name_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  category   text        NOT NULL CHECK (category <> ''),
  brand_id   uuid,
  barcode    text        CHECK (barcode ~ '^[0-9A-Za-z-]{4,32}$'),
  -- A shop SKU is stocked as one ingredient row (scope rider 3): required when kind = 'sku'.
  stock_ingredient_id uuid,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES core.brand (tenant_id, id),
  FOREIGN KEY (tenant_id, stock_ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  CHECK (kind <> 'sku' OR stock_ingredient_id IS NOT NULL)
);

CREATE TABLE core.variant (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  item_id    uuid        NOT NULL,
  name_key   text        NOT NULL CHECK (name_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  barcode    text        CHECK (barcode ~ '^[0-9A-Za-z-]{4,32}$'),
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id)
);

CREATE TABLE core.option_group (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  item_id    uuid        NOT NULL,
  name_key   text        NOT NULL CHECK (name_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  min_select integer     NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select integer     NOT NULL CHECK (max_select >= 1),
  required   boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  CHECK (max_select >= min_select),
  CHECK (NOT required OR min_select >= 1)
);

CREATE TABLE core.option (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL,
  option_group_id   uuid        NOT NULL,
  name_key          text        NOT NULL CHECK (name_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  price_delta_minor bigint      NOT NULL DEFAULT 0,
  currency          char(3)     NOT NULL,
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, option_group_id) REFERENCES core.option_group (tenant_id, id)
);

-- Validity windows never overlap per (item, variant): exclusion constraint (btree_gist, 0001).
CREATE TABLE core.recipe_version (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  item_id         uuid        NOT NULL,
  variant_id      uuid,
  version         integer     NOT NULL CHECK (version >= 1),
  valid_from      date        NOT NULL,
  valid_to        date,
  yield_qty_milli bigint      NOT NULL CHECK (yield_qty_milli > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  origin          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES core.variant (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT recipe_version_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, item_id WITH =,
    (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (daterange(valid_from, valid_to, '[)')) WITH &&)
);

-- What choosing an option adds to (or, negative, removes from) the recipe's consumption (rider 4, T-003).
CREATE TABLE core.option_ingredient_delta (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  option_id     uuid        NOT NULL,
  ingredient_id uuid        NOT NULL,
  qty_milli     bigint      NOT NULL CHECK (qty_milli <> 0),
  unit          text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  waste_pct_bp  integer     NOT NULL DEFAULT 0 CHECK (waste_pct_bp BETWEEN 0 AND 10000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, option_id, ingredient_id),
  FOREIGN KEY (tenant_id, option_id) REFERENCES core.option (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id)
);

CREATE TABLE core.recipe_line (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL,
  recipe_version_id uuid        NOT NULL,
  ingredient_id     uuid        NOT NULL,
  qty_milli         bigint      NOT NULL CHECK (qty_milli > 0),
  unit              text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  waste_pct_bp      integer     NOT NULL DEFAULT 0 CHECK (waste_pct_bp BETWEEN 0 AND 10000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipe_version_id) REFERENCES core.recipe_version (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id)
);

CREATE TABLE core.price (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  item_id      uuid        NOT NULL,
  variant_id   uuid,
  outlet_id    uuid        NOT NULL,
  channel_kind text        NOT NULL CHECK (channel_kind IN ('counter', 'table_qr', 'pickup', 'own_site')
                                           OR channel_kind ~ '^aggregator:[a-z][a-z0-9_]*$'),
  amount_minor bigint      NOT NULL CHECK (amount_minor >= 0),
  currency     char(3)     NOT NULL,
  tax_class    text        NOT NULL CHECK (tax_class ~ '^[a-z][a-z0-9_]*$'),
  valid_from   date        NOT NULL,
  valid_to     date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES core.variant (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT price_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, item_id WITH =,
    (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    outlet_id WITH =, channel_kind WITH =,
    (daterange(valid_from, valid_to, '[)')) WITH &&)
);

-- Judged at the promised time (outlet tz) and re-judged whenever it changes (project rule 9).
CREATE TABLE core.deal (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  name_key   text        NOT NULL CHECK (name_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  rule       jsonb       NOT NULL CHECK (jsonb_typeof(rule) = 'object'),
  windows    jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(windows) = 'array'),
  outlet_ids uuid[]      NOT NULL DEFAULT '{}',
  valid_from date        NOT NULL,
  valid_to   date,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE core.coupon (
  tenant_id             uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                    uuid        NOT NULL,
  code                  text        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
  kind                  text        NOT NULL CHECK (kind IN ('percent', 'amount')),
  value_bp              integer     CHECK (value_bp BETWEEN 1 AND 10000),
  value_minor           bigint      CHECK (value_minor > 0),
  currency              char(3)     NOT NULL,
  min_spend_minor       bigint      NOT NULL DEFAULT 0 CHECK (min_spend_minor >= 0),
  global_cap            integer     CHECK (global_cap >= 1),
  per_customer_cap      integer     CHECK (per_customer_cap >= 1),
  requires_customer     boolean     NOT NULL DEFAULT false,
  outlet_ids            uuid[]      NOT NULL DEFAULT '{}',
  -- FK to the campaign table arrives with it (W2, M-B).
  campaign_id           uuid,
  valid_from            timestamptz NOT NULL,
  valid_to              timestamptz,
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  origin                jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK ((kind = 'percent') = (value_bp IS NOT NULL AND value_minor IS NULL)),
  CHECK ((kind = 'amount') = (value_minor IS NOT NULL AND value_bp IS NULL)),
  CHECK (per_customer_cap IS NULL OR requires_customer),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Sold-out toggle per outlet (scope rider) — operational: flips during service by staff.
CREATE TABLE core.item_availability (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  item_id    uuid        NOT NULL,
  variant_id uuid,
  available  boolean     NOT NULL,
  updated_by uuid        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES core.variant (tenant_id, id)
);
CREATE UNIQUE INDEX item_availability_one_per_outlet_item ON core.item_availability
  (tenant_id, outlet_id, item_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)));

------------------------------------------------------------------------------------------------------------
-- Orders / POS
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.pickup_window (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  outlet_id       uuid        NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  capacity_orders integer     NOT NULL CHECK (capacity_orders >= 1),
  booked          integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),
  UNIQUE (tenant_id, outlet_id, starts_at),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (ends_at > starts_at),
  CHECK (booked BETWEEN 0 AND capacity_orders)
);

-- The only legal order status transitions (project rule 10). min_role is read by core-api; the
-- (from, to) legality is enforced by the order_transition trigger below.
CREATE TABLE core.order_status_transition (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  min_role    text NOT NULL CHECK (min_role IN ('customer', 'staff', 'manager', 'owner')),
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO core.order_status_transition (from_status, to_status, min_role) VALUES
  ('placed',    'accepted',  'staff'),
  ('placed',    'rejected',  'staff'),
  ('accepted',  'preparing', 'staff'),
  ('preparing', 'ready',     'staff'),
  ('ready',     'completed', 'staff'),
  ('placed',    'cancelled', 'customer'),
  ('accepted',  'cancelled', 'staff');

-- Human numbers (03-architecture §1.5): ticket_no restarts each business date per outlet (outlet tz);
-- invoice_no is gapless per device per financial year. Both come from counter rows locked by the
-- inserting transaction, so a rolled-back order releases its number. Counters are operational.
CREATE TABLE core.ticket_counter (
  tenant_id     uuid    NOT NULL,
  outlet_id     uuid    NOT NULL,
  business_date date    NOT NULL,
  last_no       integer NOT NULL CHECK (last_no >= 1),
  PRIMARY KEY (tenant_id, outlet_id, business_date),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id)
);

CREATE TABLE core.invoice_counter (
  tenant_id uuid     NOT NULL,
  device_id uuid     NOT NULL,
  fy        smallint NOT NULL,
  last_no   bigint   NOT NULL CHECK (last_no >= 1),
  PRIMARY KEY (tenant_id, device_id, fy),
  FOREIGN KEY (tenant_id, device_id) REFERENCES core.device (tenant_id, id)
);

CREATE TABLE core."order" (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  outlet_id        uuid        NOT NULL,
  channel_id       uuid        NOT NULL,
  brand_id         uuid,
  device_id        uuid,
  pickup_window_id uuid,
  kind             text        NOT NULL CHECK (kind IN ('dine_in', 'takeaway', 'pickup', 'delivery')),
  table_ref        text        CHECK (length(table_ref) BETWEEN 1 AND 20),
  promised_at      timestamptz,
  status           text        NOT NULL DEFAULT 'placed'
                     CHECK (status IN ('placed', 'accepted', 'rejected', 'preparing', 'ready', 'completed', 'cancelled')),
  business_date    date        NOT NULL,
  ticket_no        integer     NOT NULL,
  invoice_fy       smallint,
  invoice_no       bigint,
  customer_id      uuid,
  subtotal_minor   bigint      NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor   bigint      NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor        bigint      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor      bigint      NOT NULL CHECK (total_minor >= 0),
  currency         char(3)     NOT NULL,
  pricing_snapshot jsonb       NOT NULL,
  external_ref     text,
  client_totals    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),
  UNIQUE (tenant_id, outlet_id, business_date, ticket_no),
  UNIQUE (tenant_id, device_id, invoice_fy, invoice_no),
  UNIQUE (tenant_id, channel_id, external_ref),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES core.brand (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, device_id) REFERENCES core.device (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, outlet_id, pickup_window_id) REFERENCES core.pickup_window (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES core.customer (tenant_id, id),
  CHECK (total_minor = subtotal_minor - discount_minor + tax_minor),
  CHECK ((device_id IS NULL) = (invoice_no IS NULL) AND (invoice_no IS NULL) = (invoice_fy IS NULL))
);

CREATE TABLE core.order_line (
  tenant_id           uuid        NOT NULL,
  id                  uuid        NOT NULL,
  outlet_id           uuid        NOT NULL,
  order_id            uuid        NOT NULL,
  line_no             integer     NOT NULL CHECK (line_no >= 1),
  item_id             uuid        NOT NULL,
  variant_id          uuid,
  options             jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  qty_milli           bigint      NOT NULL CHECK (qty_milli > 0),
  unit_price_minor    bigint      NOT NULL CHECK (unit_price_minor >= 0),
  line_discount_minor bigint      NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
  tax_minor           bigint      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  recipe_version_id   uuid,
  note                text        CHECK (length(note) <= 200),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  origin              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES core.variant (tenant_id, id),
  FOREIGN KEY (tenant_id, recipe_version_id) REFERENCES core.recipe_version (tenant_id, id)
);

-- Append-only history: status changes, and promised-time changes with their reason (scope rider).
CREATE TABLE core.order_event (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  outlet_id        uuid        NOT NULL,
  order_id         uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('status', 'promised_at')),
  from_status      text,
  to_status        text,
  from_promised_at timestamptz,
  to_promised_at   timestamptz,
  actor            jsonb       NOT NULL,
  reason           text,
  at               timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id),
  CHECK ((kind = 'status') = (to_status IS NOT NULL)),
  CHECK (kind = 'status' OR (to_promised_at IS NOT NULL AND coalesce(reason, '') <> ''))
);

-- Payments are recorded, never processed (project hard rule 5).
CREATE TABLE core.tender (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  outlet_id    uuid        NOT NULL,
  order_id     uuid        NOT NULL,
  method       text        NOT NULL CHECK (method IN ('cash', 'card', 'upi')),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  -- Cash handed over and change given (R40 C1); null for non-cash. "Remaining" is computed by core.
  tendered_minor bigint    CHECK (tendered_minor > 0),
  change_minor   bigint    CHECK (change_minor >= 0),
  currency     char(3)     NOT NULL,
  recorded_by  uuid        NOT NULL,
  ref          text,
  at           timestamptz NOT NULL DEFAULT now(),
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES core.member (tenant_id, id),
  CHECK ((tendered_minor IS NULL) = (change_minor IS NULL)),
  CHECK (change_minor IS NULL OR change_minor = tendered_minor - amount_minor)
);

CREATE TABLE core.void (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  order_id      uuid        NOT NULL,
  order_line_id uuid,
  reason_code   text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  note          text        NOT NULL CHECK (note <> ''),
  -- Value written off by the void (e.g. a remake), scope rider 3.
  amount_minor  bigint      NOT NULL CHECK (amount_minor >= 0),
  currency      char(3)     NOT NULL,
  actor         uuid        NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES core.order_line (tenant_id, id),
  FOREIGN KEY (tenant_id, actor) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.refund (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  outlet_id    uuid        NOT NULL,
  order_id     uuid        NOT NULL,
  tender_id    uuid,
  method       text        NOT NULL CHECK (method IN ('cash', 'card', 'upi')),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  currency     char(3)     NOT NULL,
  reason_code  text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]*$'),
  note         text        NOT NULL CHECK (note <> ''),
  actor        uuid        NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, tender_id) REFERENCES core.tender (tenant_id, id),
  FOREIGN KEY (tenant_id, actor) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.shift (
  tenant_id           uuid        NOT NULL,
  id                  uuid        NOT NULL,
  outlet_id           uuid        NOT NULL,
  device_id           uuid,
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by           uuid        NOT NULL,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  float_minor         bigint      NOT NULL CHECK (float_minor >= 0),
  currency            char(3)     NOT NULL,
  closed_by           uuid,
  closed_at           timestamptz,
  counted_cash_minor  bigint      CHECK (counted_cash_minor >= 0),
  expected_cash_minor bigint      CHECK (expected_cash_minor >= 0),
  variance_minor      bigint,
  origin              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, device_id) REFERENCES core.device (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, opened_by) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES core.member (tenant_id, id),
  CHECK ((status = 'closed') = (closed_by IS NOT NULL AND closed_at IS NOT NULL AND counted_cash_minor IS NOT NULL
                                AND expected_cash_minor IS NOT NULL AND variance_minor IS NOT NULL)),
  CHECK (variance_minor IS NULL OR variance_minor = counted_cash_minor - expected_cash_minor)
);

-- Ticket states follow packages/contracts KitchenTicketStatus; their transition rules live in core-api (T-023).
CREATE TABLE core.kitchen_ticket (
  tenant_id   uuid        NOT NULL,
  id          uuid        NOT NULL,
  outlet_id   uuid        NOT NULL,
  order_id    uuid        NOT NULL,
  station     text        NOT NULL CHECK (station ~ '^[a-z][a-z0-9_]*$'),
  status      text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'preparing', 'ready', 'done')),
  accepted_at timestamptz,
  ready_at    timestamptz,
  due_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, order_id) REFERENCES core."order" (tenant_id, outlet_id, id)
);

CREATE TABLE core.coupon_use (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL,
  coupon_id      uuid        NOT NULL,
  order_id       uuid        NOT NULL,
  customer_id    uuid,
  discount_minor bigint      NOT NULL CHECK (discount_minor >= 0),
  currency       char(3)     NOT NULL,
  -- The member, or the customer for a self-applied storefront coupon, who applied it.
  applied_by     uuid        NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  origin         jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, coupon_id, order_id),
  FOREIGN KEY (tenant_id, coupon_id) REFERENCES core.coupon (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES core."order" (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES core.customer (tenant_id, id)
);

-- Expected prep seconds per item and station (scope rider 3): operational, versioned by validity.
CREATE TABLE core.prep_time (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  item_id    uuid        NOT NULL,
  station    text        NOT NULL CHECK (station ~ '^[a-z][a-z0-9_]*$'),
  prep_sec   integer     NOT NULL CHECK (prep_sec BETWEEN 1 AND 86400),
  valid_from date        NOT NULL,
  valid_to   date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT prep_time_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, outlet_id WITH =, item_id WITH =, station WITH =,
    (daterange(valid_from, valid_to, '[)')) WITH &&)
);

-- Kitchen prep lists (scope rider 1): book — created by an approved draft or a member's own command.
CREATE TABLE core.prep_list (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  business_date date        NOT NULL,
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  draft_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES core.draft (tenant_id, id)
);

CREATE TABLE core.prep_list_line (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  prep_list_id  uuid        NOT NULL,
  item_id       uuid,
  ingredient_id uuid,
  qty_milli     bigint      NOT NULL CHECK (qty_milli > 0),
  unit          text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, prep_list_id) REFERENCES core.prep_list (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  CHECK ((item_id IS NULL) <> (ingredient_id IS NULL))
);

INSERT INTO core.command_authority (command_type, allowed_roles, scope) VALUES
  ('kitchen.prep_list.create.v1', ARRAY['owner', 'manager', 'judge'], 'outlet'),
  -- R41 customer self-service (scope own). Erasure: the customer's own command, or an owner (rider 5).
  ('customers.account.link.v1',     ARRAY['customer'],          'own'),
  ('customers.profile.update.v1',   ARRAY['customer'],          'own'),
  ('customers.consent.set.v1',      ARRAY['customer'],          'own'),
  ('customers.data.export.v1',      ARRAY['customer'],          'own'),
  ('customers.erasure.request.v1',  ARRAY['customer', 'owner'], 'own');

------------------------------------------------------------------------------------------------------------
-- Functions
------------------------------------------------------------------------------------------------------------
-- Assigns business_date (outlet tz), ticket_no and — when a device is named — invoice_fy/invoice_no.
-- Values the caller supplies for these columns are overwritten. Runs as the caller (munim_core), under RLS.
CREATE FUNCTION core.order_assign_numbers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  outlet_tz text;
  fy_start  smallint;
BEGIN
  SELECT o.tz INTO outlet_tz FROM core.outlet o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outlet_id;
  SELECT t.fy_start_month INTO fy_start FROM core.tenant t WHERE t.tenant_id = NEW.tenant_id;
  IF outlet_tz IS NULL OR fy_start IS NULL THEN
    RAISE EXCEPTION 'order_numbers: outlet % not visible in this context', NEW.outlet_id USING ERRCODE = 'MB001';
  END IF;
  NEW.business_date := (now() AT TIME ZONE outlet_tz)::date;

  INSERT INTO core.ticket_counter AS c (tenant_id, outlet_id, business_date, last_no)
  VALUES (NEW.tenant_id, NEW.outlet_id, NEW.business_date, 1)
  ON CONFLICT (tenant_id, outlet_id, business_date) DO UPDATE SET last_no = c.last_no + 1
  RETURNING c.last_no INTO NEW.ticket_no;

  IF NEW.device_id IS NULL THEN
    NEW.invoice_fy := NULL;
    NEW.invoice_no := NULL;
  ELSE
    NEW.invoice_fy := extract(year FROM NEW.business_date)::smallint
                      - CASE WHEN extract(month FROM NEW.business_date) < fy_start THEN 1 ELSE 0 END;
    INSERT INTO core.invoice_counter AS c (tenant_id, device_id, fy, last_no)
    VALUES (NEW.tenant_id, NEW.device_id, NEW.invoice_fy, 1)
    ON CONFLICT (tenant_id, device_id, fy) DO UPDATE SET last_no = c.last_no + 1
    RETURNING c.last_no INTO NEW.invoice_no;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_assign_numbers() FROM PUBLIC;

-- R41 erasure: setting erased_at is allowed only under customers.erasure.request.v1 (whose authority row
-- admits the customer or an owner — checked first by book_guard) and blanks the personal columns here.
-- An erased profile is final: any later change is refused. MB007.
CREATE FUNCTION core.customer_erasure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'customer_erased: profile % was erased', OLD.id USING ERRCODE = 'MB007';
  END IF;
  IF NEW.erased_at IS NOT NULL THEN
    IF nullif(current_setting('app.command_type', true), '') IS DISTINCT FROM 'customers.erasure.request.v1' THEN
      RAISE EXCEPTION 'customer_erased: erasure needs customers.erasure.request.v1' USING ERRCODE = 'MB007';
    END IF;
    NEW.name := NULL;
    NEW.phone := NULL;
    NEW.email := NULL;
    NEW.idp_sub := NULL;
    NEW.email_verified_at := NULL;
    NEW.consent := '{}';
    NEW.erased_at := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.customer_erasure() FROM PUBLIC;

-- Status changes must be a row of core.order_status_transition (MB004 otherwise).
CREATE FUNCTION core.order_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT EXISTS (SELECT 1 FROM core.order_status_transition t
                      WHERE t.from_status = OLD.status AND t.to_status = NEW.status) THEN
    RAISE EXCEPTION 'illegal_transition: order % → %', OLD.status, NEW.status USING ERRCODE = 'MB004';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_transition() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------------------------------------
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.customer       FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.item           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.variant        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.option_group   FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.option         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.option_ingredient_delta FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.ingredient     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.recipe_version FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.recipe_line    FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.price          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.deal           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.coupon         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core."order"        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.order_line     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.order_event    FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.tender         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.void           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.refund         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.shift          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.coupon_use     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.prep_list      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.prep_list_line FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.option     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.price      FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.coupon     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core."order"    FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.tender     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.void       FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.refund     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.shift      FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.coupon_use FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

CREATE TRIGGER customer_erasure BEFORE UPDATE ON core.customer FOR EACH ROW EXECUTE FUNCTION core.customer_erasure();
CREATE TRIGGER order_numbers BEFORE INSERT ON core."order" FOR EACH ROW EXECUTE FUNCTION core.order_assign_numbers();
CREATE TRIGGER order_transition BEFORE UPDATE ON core."order" FOR EACH ROW EXECUTE FUNCTION core.order_transition();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.kitchen_ticket FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.item_availability FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

------------------------------------------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------------------------------------------
-- R41: a customer context (app.role = 'customer') sees and writes only its own profile (app.customer_id).
ALTER TABLE core.customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.customer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_customer_own ON core.customer
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'
              OR id = (SELECT nullif(current_setting('app.customer_id', true), '')::uuid)))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'
              OR id = (SELECT nullif(current_setting('app.customer_id', true), '')::uuid)));

ALTER TABLE core.item ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.item
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.variant ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.variant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.variant
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.option_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.option_group FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.option_group
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.option ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.option FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.option
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.option_ingredient_delta ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.option_ingredient_delta FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.option_ingredient_delta
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.ingredient ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ingredient FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.ingredient
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.recipe_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.recipe_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.recipe_version
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.recipe_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.recipe_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.recipe_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.price ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.price FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.price
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.deal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.deal
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.coupon ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.coupon FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.coupon
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.ticket_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ticket_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.ticket_counter
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.invoice_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.invoice_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.invoice_counter
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.coupon_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.coupon_use FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.coupon_use
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.prep_list_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.prep_list_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.prep_list_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

-- Outlet-scoped (02-schema §0: pickup_window, order + lines, events, tenders, voids, refunds, kitchen
-- tickets, shift; plus the riders' item_availability, prep_time and prep_list, which are per-outlet).
ALTER TABLE core.item_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.item_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.item_availability
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.prep_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.prep_time FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.prep_time
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.pickup_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.pickup_window FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.pickup_window
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core."order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE core."order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core."order"
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.order_line
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.order_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.order_event
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.tender ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.tender FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.tender
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.void ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.void FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.void
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.refund FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.refund
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.shift ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.shift FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.shift
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.kitchen_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.kitchen_ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.kitchen_ticket
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.prep_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.prep_list FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.prep_list
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

------------------------------------------------------------------------------------------------------------
-- Tags (R29)
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.customer                IS 'munim:book';
COMMENT ON TABLE core.item                    IS 'munim:book';
COMMENT ON TABLE core.variant                 IS 'munim:book';
COMMENT ON TABLE core.option_group            IS 'munim:book';
COMMENT ON TABLE core.option                  IS 'munim:book';
COMMENT ON TABLE core.option_ingredient_delta IS 'munim:book';
COMMENT ON TABLE core.ingredient              IS 'munim:book';
COMMENT ON TABLE core.recipe_version          IS 'munim:book';
COMMENT ON TABLE core.recipe_line             IS 'munim:book';
COMMENT ON TABLE core.price                   IS 'munim:book';
COMMENT ON TABLE core.deal                    IS 'munim:book';
COMMENT ON TABLE core.coupon                  IS 'munim:book';
COMMENT ON TABLE core."order"                 IS 'munim:book';
COMMENT ON TABLE core.order_line              IS 'munim:book';
COMMENT ON TABLE core.order_event             IS 'munim:book';
COMMENT ON TABLE core.tender                  IS 'munim:book';
COMMENT ON TABLE core.void                    IS 'munim:book';
COMMENT ON TABLE core.refund                  IS 'munim:book';
COMMENT ON TABLE core.shift                   IS 'munim:book';
COMMENT ON TABLE core.coupon_use              IS 'munim:book';
COMMENT ON TABLE core.prep_list               IS 'munim:book';
COMMENT ON TABLE core.prep_list_line          IS 'munim:book';
COMMENT ON TABLE core.item_availability       IS 'munim:operational';
COMMENT ON TABLE core.pickup_window           IS 'munim:operational';
COMMENT ON TABLE core.order_status_transition IS 'munim:operational';
COMMENT ON TABLE core.ticket_counter          IS 'munim:operational';
COMMENT ON TABLE core.invoice_counter         IS 'munim:operational';
COMMENT ON TABLE core.kitchen_ticket          IS 'munim:operational';
COMMENT ON TABLE core.prep_time               IS 'munim:operational';

------------------------------------------------------------------------------------------------------------
-- Grants: revoke-then-grant. munim_svc reads only. Append-only books (order_event, tender, void, refund,
-- coupon_use, recipe_line, order_line, prep_list_line) get INSERT and no UPDATE.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.customer, core.item, core.variant, core.option_group, core.option, core.option_ingredient_delta, core.ingredient,
  core.recipe_version, core.recipe_line, core.price, core.deal, core.coupon, core.item_availability,
  core.pickup_window, core.order_status_transition, core.ticket_counter, core.invoice_counter, core."order",
  core.order_line, core.order_event, core.tender, core.void, core.refund, core.shift, core.kitchen_ticket,
  core.coupon_use, core.prep_list, core.prep_list_line, core.prep_time FROM PUBLIC;

GRANT SELECT ON core.customer, core.item, core.variant, core.option_group, core.option, core.option_ingredient_delta, core.ingredient,
  core.recipe_version, core.recipe_line, core.price, core.deal, core.coupon, core.item_availability,
  core.pickup_window, core.order_status_transition, core.ticket_counter, core.invoice_counter, core."order",
  core.order_line, core.order_event, core.tender, core.void, core.refund, core.shift, core.kitchen_ticket,
  core.coupon_use, core.prep_list, core.prep_list_line, core.prep_time TO munim_core, munim_svc;

GRANT INSERT ON core.customer, core.item, core.variant, core.option_group, core.option, core.option_ingredient_delta, core.ingredient,
  core.recipe_version, core.recipe_line, core.price, core.deal, core.coupon, core.item_availability,
  core.pickup_window, core.ticket_counter, core.invoice_counter, core."order", core.order_line,
  core.order_event, core.tender, core.void, core.refund, core.shift, core.kitchen_ticket, core.coupon_use,
  core.prep_list, core.prep_list_line, core.prep_time TO munim_core;

GRANT UPDATE (name, phone, email, consent, is_guest, idp_sub, email_verified_at, erased_at) ON core.customer TO munim_core;
GRANT UPDATE (name_key, category, brand_id, barcode, stock_ingredient_id, active) ON core.item TO munim_core;
GRANT UPDATE (name_key, barcode, active) ON core.variant TO munim_core;
GRANT UPDATE (name_key, min_select, max_select, required) ON core.option_group TO munim_core;
GRANT UPDATE (name_key, price_delta_minor, active) ON core.option TO munim_core;
GRANT UPDATE (qty_milli, unit, waste_pct_bp) ON core.option_ingredient_delta TO munim_core;
GRANT UPDATE (name, base_unit, shelf_life_days, tracked_by_batch, active) ON core.ingredient TO munim_core;
GRANT UPDATE (valid_to) ON core.recipe_version TO munim_core;
GRANT UPDATE (valid_to) ON core.price TO munim_core;
GRANT UPDATE (rule, windows, outlet_ids, valid_to, active) ON core.deal TO munim_core;
GRANT UPDATE (global_cap, per_customer_cap, valid_to, active) ON core.coupon TO munim_core;
GRANT UPDATE (available, updated_by) ON core.item_availability TO munim_core;
GRANT UPDATE (capacity_orders, booked) ON core.pickup_window TO munim_core;
GRANT UPDATE (last_no) ON core.ticket_counter TO munim_core;
GRANT UPDATE (last_no) ON core.invoice_counter TO munim_core;
GRANT UPDATE (status, promised_at, pickup_window_id, customer_id, subtotal_minor, discount_minor, tax_minor,
  total_minor, pricing_snapshot) ON core."order" TO munim_core;
GRANT UPDATE (status, closed_by, closed_at, counted_cash_minor, expected_cash_minor, variance_minor)
  ON core.shift TO munim_core;
GRANT UPDATE (status, accepted_at, ready_at, due_at) ON core.kitchen_ticket TO munim_core;
GRANT UPDATE (status) ON core.prep_list TO munim_core;
GRANT UPDATE (valid_to) ON core.prep_time TO munim_core;
