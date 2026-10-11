-- What the run may see (R-A 1). index.ts puts this in place of {{visible}} in every template, which then reads `vnode` and
-- `vedge` and never intel.entity / intel.edge. intel.entity, intel.edge and intel.claim are tenant-only under RLS, so for a
-- run scoped to some outlets (:outlet_ids not null) a node is visible only by its kind, deny by default:
--   tenant-wide kinds (business, brand, channel, item, ingredient, supplier, day) — core shows those rows to every scope;
--   an outlet — its core_ref names an outlet in the scope;
--   a person — its core_ref names a core.staff row this run's RLS shows (staff of the scoped outlets);
--   a customer — its core_ref names a customer with an order this run's RLS shows;
--   'other' — a finding this run's RLS shows (outlet overlap), or a claim from a document (tenant-wide) or from a message
--   this run's RLS shows (its conversation's outlet);
--   anything else, or an outlet / person / customer without a core_ref, is not visible.
-- An edge is visible when both its ends are, and the outlet-anchored kinds (sold, wasted, works_at) also need an outlet end:
-- a walk never crosses a node it may not see, so an out-of-scope outlet is no bridge either. A '*' run sees the tenant.
vnode AS (
  SELECT e.id, e.kind, e.name
    FROM (SELECT x.*, split_part(x.core_ref, ':', 1) AS ref_table,
                 CASE WHEN split_part(x.core_ref, ':', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN split_part(x.core_ref, ':', 2)::uuid END AS ref_id
            FROM intel.entity x WHERE x.tenant_id = :tenant_id) e
   WHERE :outlet_ids::uuid[] IS NULL
      OR e.kind IN ('business', 'brand', 'channel', 'item', 'ingredient', 'supplier', 'day')
      OR (e.kind = 'outlet' AND e.ref_table = 'core.outlet' AND e.ref_id = ANY (:outlet_ids::uuid[]))
      OR (e.kind = 'person' AND e.ref_table = 'core.staff'
          AND EXISTS (SELECT 1 FROM core.staff s WHERE s.tenant_id = :tenant_id AND s.id = e.ref_id))
      OR (e.kind = 'customer' AND e.ref_table = 'core.customer'
          AND EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = :tenant_id AND o.customer_id = e.ref_id))
      OR (e.kind = 'other'
          AND (EXISTS (SELECT 1 FROM intel.finding f WHERE f.tenant_id = :tenant_id AND f.id = e.id)
               OR EXISTS (SELECT 1 FROM intel.claim c LEFT JOIN intel.chunk ch ON ch.tenant_id = c.tenant_id AND ch.id = c.chunk_id
                           WHERE c.tenant_id = :tenant_id AND c.id = e.id
                             AND (ch.document_id IS NOT NULL
                                  OR EXISTS (SELECT 1 FROM core.message m
                                              WHERE m.tenant_id = :tenant_id AND m.id = coalesce(c.message_id, ch.message_id))))))
), vedge AS (
  SELECT g.kind, g.src_entity_id, g.dst_entity_id
    FROM intel.edge g
    JOIN vnode s ON s.id = g.src_entity_id
    JOIN vnode d ON d.id = g.dst_entity_id
   WHERE g.tenant_id = :tenant_id
     AND (:outlet_ids::uuid[] IS NULL OR g.kind NOT IN ('sold', 'wasted', 'works_at') OR 'outlet' IN (s.kind, d.kind))
)
