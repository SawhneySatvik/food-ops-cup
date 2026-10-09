-- 0001_roles_schemas — roles (03-architecture §1.2), schemas, default-privilege revokes, extensions.
-- Runs as the connecting admin (the superuser in tests; `postgres` on a hosted project). Roles are
-- cluster-global, so each is created if missing and then ALTERed to pin every attribute, and the result is
-- asserted at the end of this file — a pre-existing role with other attributes is corrected, not trusted.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['munim_migrator', 'munim_crosstenant', 'munim_view_owner', 'munim_core',
                           'munim_svc', 'munim_platform', 'munim_intel_ro'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- Owns schemas and every object; migrations only, never at runtime.
ALTER ROLE munim_migrator    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
-- Owns exactly core.outbox_claim(), core.active_tenants(), platform.tenant_registry (gate: definer owners).
ALTER ROLE munim_crosstenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
-- Owns intel_ro views (M-B); NOBYPASSRLS so base-table policies apply through the views.
ALTER ROLE munim_view_owner  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- Runtime roles. Passwords are set outside migrations (deployment secret; the test harness sets its own).
ALTER ROLE munim_core        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE munim_svc         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE munim_platform    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE munim_intel_ro    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The admin must be able to SET ROLE munim_migrator (PG16+ does not grant SET to a non-superuser creator by
-- default). munim_migrator must be able to hand objects to the two owner roles (ALTER … OWNER needs it).
GRANT munim_migrator TO CURRENT_USER;
GRANT munim_crosstenant TO munim_migrator;
GRANT munim_view_owner TO munim_migrator;

-- Extensions. pgcrypto per 02-schema §7; btree_gist for the non-overlap exclusion constraints on
-- recipe_version and price (02-schema §2.3). Hashing uses the built-in sha256(), not pgcrypto, so no
-- function call depends on the extension's schema. pgvector arrives with 0012 (`-- requires: vector`).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA core     AUTHORIZATION munim_migrator;
CREATE SCHEMA evidence AUTHORIZATION munim_migrator;
CREATE SCHEMA intel    AUTHORIZATION munim_migrator;
CREATE SCHEMA platform AUTHORIZATION munim_migrator;
CREATE SCHEMA intel_ro AUTHORIZATION munim_migrator;
-- munim_meta is bootstrapped by the runner (it records this very file); hand it to the migrator here.
ALTER SCHEMA munim_meta OWNER TO munim_migrator;
ALTER TABLE munim_meta.schema_migrations OWNER TO munim_migrator;

-- Default privileges for everything munim_migrator will create. The revoke must be the GLOBAL form (no
-- IN SCHEMA): per-schema default privileges can only add to the global default, so an IN SCHEMA revoke of
-- EXECUTE from PUBLIC is a silent no-op. Every function still carries its own REVOKE/GRANT block.
ALTER DEFAULT PRIVILEGES FOR ROLE munim_migrator REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE munim_migrator REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE munim_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

REVOKE ALL ON SCHEMA core, evidence, intel, platform, intel_ro, munim_meta FROM PUBLIC;
REVOKE ALL ON munim_meta.schema_migrations FROM PUBLIC;

GRANT USAGE ON SCHEMA core, evidence, intel TO munim_core, munim_svc;
GRANT USAGE ON SCHEMA platform TO munim_core, munim_svc, munim_platform;
GRANT USAGE ON SCHEMA intel_ro TO munim_intel_ro;
GRANT USAGE ON SCHEMA core, platform TO munim_crosstenant;
GRANT USAGE ON SCHEMA core, intel, intel_ro TO munim_view_owner;
-- core-api /health reports the migration version.
GRANT USAGE ON SCHEMA munim_meta TO munim_core, munim_svc;
GRANT SELECT ON munim_meta.schema_migrations TO munim_core, munim_svc;

-- Post-conditions (never trust IF NOT EXISTS).
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_catalog.pg_roles
   WHERE rolname LIKE 'munim\_%'
     AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
          OR rolbypassrls <> (rolname = 'munim_crosstenant')
          OR rolcanlogin <> (rolname IN ('munim_core', 'munim_svc', 'munim_platform', 'munim_intel_ro')));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0001: role attributes wrong for %', bad; END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
       WHERE n.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta')
         AND r.rolname = 'munim_migrator') <> 6 THEN
    RAISE EXCEPTION '0001: expected 6 schemas owned by munim_migrator';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION '0001: pgcrypto or btree_gist missing';
  END IF;

  -- The global default ACL for munim_migrator's functions must exist and must not mention PUBLIC.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d
                  WHERE d.defaclrole = 'munim_migrator'::regrole AND d.defaclnamespace = 0
                    AND d.defaclobjtype = 'f'
                    AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)) THEN
    RAISE EXCEPTION '0001: default EXECUTE revoke from PUBLIC on munim_migrator functions not in place';
  END IF;
END $$;
