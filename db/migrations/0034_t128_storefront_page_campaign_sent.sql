-- 0034_t128_storefront_page_campaign_sent — T-128 (R66 screens wave; R67 demo campaigns), migrator lane T-128, fix forward over
-- 0001–0033. Runs as munim_migrator. Additive: two new book tables with their policies, guard, scope rows and grants, and three
-- core.command_authority rows. No existing table, column, index, policy, trigger, function, grant or derivation rule is changed;
-- no business row is written.
-- Items:
--   P1  core.storefront_page_version: one saved version of a business's storefront page (theme + home page sections, the
--       contracts' StorefrontPageDoc, checked by core-api before it is written). Insert-only: a change is a new version
--       (`version` = the next number per tenant, unique), so every look a storefront ever had stays on the books. A book
--       (munim:book): the storefront is what customers see, written only by a person's own command (storefront.page.save.v1).
--   P2  core.storefront_page_publish: one "this version goes live" event. Insert-only; the live page is the newest row. Restoring
--       an older look is a new row naming the older version. A book, written only by storefront.page.publish.v1 (owner).
--       Both tables are tenant-level (book_scope 'none'): a storefront serves every outlet, so the commands are scope 'tenant',
--       which the guard admits only in an all-outlet context (0014 book_row_in_scope).
--       Shoppers (app.role 'customer', a storefront key) read the publish rows and the versions that were ever published,
--       nothing else (customer_scope below); guests read neither (guest_scope); intel has no grant.
--   A1  storefront.page.save.v1   owner, manager, judge · tenant · core.storefront_page_version
--   A2  storefront.page.publish.v1 owner, judge · tenant · core.storefront_page_publish
--   A3  customers.campaign.record_sent.v1 owner, judge · tenant · core.campaign (R67: on a demo business the owner records a
--       queued campaign as sent, simulated — no message leaves Munim; core-api refuses it elsewhere with `demo_only`). The
--       queued → sent transition is 0014's row; munim_core's UPDATE (status) on core.campaign is 0011's.
-- New SQLSTATEs: none (23505 from the keys, 23514 from the CHECKs, 23503 from the FKs).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('core.storefront_page_version') IS NOT NULL OR to_regclass('core.storefront_page_publish') IS NOT NULL THEN
    RAISE EXCEPTION '0034: a storefront page table already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM core.command_authority
              WHERE command_type IN ('storefront.page.save.v1', 'storefront.page.publish.v1', 'customers.campaign.record_sent.v1')) THEN
    RAISE EXCEPTION '0034: a T-128 command already has a command_authority row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.book_status_transition WHERE table_name = 'core.campaign' AND from_status = 'queued' AND to_status = 'sent')
     OR NOT has_column_privilege('munim_core', 'core.campaign', 'status', 'UPDATE') THEN
    RAISE EXCEPTION '0034: core.campaign lacks the queued → sent transition or munim_core''s UPDATE (status) that A3 relies on';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. P1, P2 — the tables
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.storefront_page_version (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  version    integer     NOT NULL CONSTRAINT storefront_page_version_version_check CHECK (version >= 1),
  doc        jsonb       NOT NULL CONSTRAINT storefront_page_version_doc_check CHECK (jsonb_typeof(doc) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid        NOT NULL,
  origin     jsonb       NOT NULL,
  CONSTRAINT storefront_page_version_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT storefront_page_version_number_key UNIQUE (tenant_id, version),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.storefront_page_publish (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  page_id      uuid        NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid        NOT NULL,
  origin       jsonb       NOT NULL,
  CONSTRAINT storefront_page_publish_pkey PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, page_id) REFERENCES core.storefront_page_version (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES core.member (tenant_id, id)
);

CREATE INDEX storefront_page_version_created_by_fk_idx ON core.storefront_page_version (tenant_id, created_by);
CREATE INDEX storefront_page_publish_page_id_fk_idx ON core.storefront_page_publish (tenant_id, page_id);
CREATE INDEX storefront_page_publish_published_by_fk_idx ON core.storefront_page_publish (tenant_id, published_by);

------------------------------------------------------------------------------------------------------------
-- 2. RLS: enable + force; tenant isolation; the restrictive shopper and guest policies (0014 F4 / rider forms)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  t      text;
  tenant constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)$c$;
  nc     constant text := $c$((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer')$c$;
  ng     constant text := $c$((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest')$c$;
BEGIN
  FOREACH t IN ARRAY ARRAY['storefront_page_version', 'storefront_page_publish'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON core.%I USING (%s) WITH CHECK (%s)', t, tenant, tenant);
    EXECUTE format('CREATE POLICY guest_scope ON core.%I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)', t, ng, ng);
  END LOOP;
  -- A shopper reads every publish row (ids, a version and a time) and only the versions some publish row names; writes nothing.
  EXECUTE format('CREATE POLICY customer_scope ON core.storefront_page_publish AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (%s)', nc);
  EXECUTE format($p$CREATE POLICY customer_scope ON core.storefront_page_version AS RESTRICTIVE FOR ALL
    USING (%s OR EXISTS (SELECT 1 FROM core.storefront_page_publish p
                          WHERE p.tenant_id = storefront_page_version.tenant_id AND p.page_id = storefront_page_version.id))
    WITH CHECK (%s)$p$, nc, nc);
END $$;

------------------------------------------------------------------------------------------------------------
-- 3. Tags, book scope, the guard
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.storefront_page_version IS 'munim:book';
COMMENT ON TABLE core.storefront_page_publish IS 'munim:book';
INSERT INTO core.book_scope (table_name, outlet_kind, outlet_ref, parent_table) VALUES
  ('core.storefront_page_version', 'none', NULL, NULL),
  ('core.storefront_page_publish', 'none', NULL, NULL);
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.storefront_page_version FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.storefront_page_publish FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

------------------------------------------------------------------------------------------------------------
-- 4. A1–A3 — command authority
------------------------------------------------------------------------------------------------------------
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('storefront.page.save.v1',           ARRAY['owner', 'manager', 'judge'], 'tenant', ARRAY['core.storefront_page_version']),
  ('storefront.page.publish.v1',        ARRAY['owner', 'judge'],            'tenant', ARRAY['core.storefront_page_publish']),
  ('customers.campaign.record_sent.v1', ARRAY['owner', 'judge'],            'tenant', ARRAY['core.campaign']);

------------------------------------------------------------------------------------------------------------
-- 5. Grants: revoke, then grant. munim_core reads and inserts (no UPDATE: insert-only books); nobody else holds anything.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.storefront_page_version, core.storefront_page_publish
  FROM PUBLIC, munim_core, munim_svc, munim_platform, munim_intel_ro, munim_crosstenant, munim_view_owner;
GRANT SELECT, INSERT ON core.storefront_page_version, core.storefront_page_publish TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 6. Post-conditions (read back what Postgres holds; never trust IF NOT EXISTS)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- P1, P2: the columns, as written.
    SELECT 'columns:' || t AS x FROM (VALUES
      ('core.storefront_page_version', 'tenant_id:uuid:notnull:nodefault,id:uuid:notnull:nodefault,version:integer:notnull:nodefault,'
        || 'doc:jsonb:notnull:nodefault,created_at:timestamp with time zone:notnull:now(),created_by:uuid:notnull:nodefault,origin:jsonb:notnull:nodefault'),
      ('core.storefront_page_publish', 'tenant_id:uuid:notnull:nodefault,id:uuid:notnull:nodefault,page_id:uuid:notnull:nodefault,'
        || 'published_at:timestamp with time zone:notnull:now(),published_by:uuid:notnull:nodefault,origin:jsonb:notnull:nodefault')) v(t, want)
     WHERE (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ':notnull' ELSE '' END
                              || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'nodefault'), ',' ORDER BY a.attnum)
              FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = v.t::regclass AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM v.want
    UNION ALL
    -- The keys, each backed by a unique index on exactly its columns in order (gotcha 1).
    SELECT 'key:' || k.con FROM (VALUES ('core.storefront_page_version', 'storefront_page_version_pkey', ARRAY['tenant_id', 'id']),
                                        ('core.storefront_page_version', 'storefront_page_version_number_key', ARRAY['tenant_id', 'version']),
                                        ('core.storefront_page_publish', 'storefront_page_publish_pkey', ARRAY['tenant_id', 'id'])) k(t, con, cols)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
                        WHERE c.conrelid = k.t::regclass AND c.conname = k.con AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
                          AND i.indkey::text = (SELECT string_agg(a.attnum::text, ' ' ORDER BY o.n) FROM unnest(k.cols) WITH ORDINALITY o(c, n)
                                                  JOIN pg_attribute a ON a.attrelid = k.t::regclass AND a.attname = o.c))
    UNION ALL
    -- The FK indexes, each on exactly (tenant_id, <fk column>).
    SELECT 'fk-index:' || f.idx FROM (VALUES ('core.storefront_page_version', 'storefront_page_version_created_by_fk_idx', 'created_by'),
                                             ('core.storefront_page_publish', 'storefront_page_publish_page_id_fk_idx', 'page_id'),
                                             ('core.storefront_page_publish', 'storefront_page_publish_published_by_fk_idx', 'published_by')) f(t, idx, col)
     WHERE NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                        WHERE i.indrelid = f.t::regclass AND ic.relname = f.idx AND i.indpred IS NULL AND i.indexprs IS NULL
                          AND i.indkey::text = (SELECT a1.attnum || ' ' || a2.attnum FROM pg_attribute a1, pg_attribute a2
                                                 WHERE a1.attrelid = f.t::regclass AND a1.attname = 'tenant_id'
                                                   AND a2.attrelid = f.t::regclass AND a2.attname = f.col))
    UNION ALL
    -- The FKs: five, no cascades (assert_catalog also checks the cascade rule).
    SELECT 'fks' WHERE (SELECT count(*) FROM pg_constraint WHERE contype = 'f'
                         AND conrelid IN ('core.storefront_page_version'::regclass, 'core.storefront_page_publish'::regclass)) <> 5
    UNION ALL
    -- No trigger but the guard (no UPDATE path, so no transition trigger).
    SELECT 'triggers:' || c.relname FROM pg_class c
     WHERE c.oid IN ('core.storefront_page_version'::regclass, 'core.storefront_page_publish'::regclass)
       AND (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) IS DISTINCT FROM 'book_guard'
    UNION ALL
    -- Policies: exactly tenant_isolation (permissive) + customer_scope + guest_scope (restrictive) on each.
    SELECT 'policies:' || c.relname FROM pg_class c
     WHERE c.oid IN ('core.storefront_page_version'::regclass, 'core.storefront_page_publish'::regclass)
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR (SELECT string_agg(p.polname || ':' || p.polpermissive, ',' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid)
               IS DISTINCT FROM 'customer_scope:false,guest_scope:false,tenant_isolation:true')
    UNION ALL
    -- The shopper read of the publish rows is open; of the versions, only through a publish row.
    SELECT 'customer_scope' WHERE (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
                                    WHERE polrelid = 'core.storefront_page_publish'::regclass AND polname = 'customer_scope') IS DISTINCT FROM 'true'
       OR (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
            WHERE polrelid = 'core.storefront_page_version'::regclass AND polname = 'customer_scope') NOT LIKE '%storefront_page_publish p%'
    UNION ALL
    -- Tags, owner, scope rows.
    SELECT 'table:' || c.relname FROM pg_class c
     WHERE c.oid IN ('core.storefront_page_version'::regclass, 'core.storefront_page_publish'::regclass)
       AND (obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:book' OR c.relowner <> 'munim_migrator'::regrole
            OR NOT EXISTS (SELECT 1 FROM core.book_scope b WHERE b.table_name = 'core.' || c.relname AND b.outlet_kind = 'none'
                             AND b.outlet_ref IS NULL AND b.parent_table IS NULL AND b.customer_kind = 'none'))
    UNION ALL
    -- Grants: munim_core SELECT + INSERT only; no column grants; no other role holds anything; nobody DELETEs or TRUNCATEs.
    SELECT 'acl:' || c.relname FROM pg_class c
     WHERE c.oid IN ('core.storefront_page_version'::regclass, 'core.storefront_page_publish'::regclass)
       AND ((SELECT string_agg(x.grantee::regrole::text || ':' || x.privilege_type, ',' ORDER BY x.privilege_type)
               FROM aclexplode(c.relacl) x WHERE x.grantee <> c.relowner) IS DISTINCT FROM 'munim_core:INSERT,munim_core:SELECT'
            OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attacl IS NOT NULL))
    UNION ALL
    SELECT 'others:' || r || ':' || t FROM unnest(ARRAY['munim_svc', 'munim_platform', 'munim_intel_ro', 'munim_crosstenant', 'munim_view_owner']) r,
                                           unnest(ARRAY['core.storefront_page_version', 'core.storefront_page_publish']) t
     WHERE has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    UNION ALL
    -- A1–A3: the rows exactly as written (own commands allowed, no role cap, no outlet column, no amount cap, no customer table).
    SELECT 'authority:' || a.t FROM (VALUES ('storefront.page.save.v1', ARRAY['owner', 'manager', 'judge'], ARRAY['core.storefront_page_version']),
                                            ('storefront.page.publish.v1', ARRAY['owner', 'judge'], ARRAY['core.storefront_page_publish']),
                                            ('customers.campaign.record_sent.v1', ARRAY['owner', 'judge'], ARRAY['core.campaign'])) a(t, roles, tables)
     WHERE NOT EXISTS (SELECT 1 FROM core.command_authority ca
                        WHERE ca.command_type = a.t AND ca.allowed_roles = a.roles AND ca.scope = 'tenant' AND ca.target_tables = a.tables
                          AND ca.customer_target_tables = '{}' AND NOT ca.draft_only AND ca.role_caps = '{}' AND ca.outlet_column IS NULL
                          AND ca.max_amount_minor IS NULL)
    UNION ALL
    -- No row (this file writes none).
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.storefront_page_version) OR EXISTS (SELECT 1 FROM core.storefront_page_publish)) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0034: not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0034');
END $$;
