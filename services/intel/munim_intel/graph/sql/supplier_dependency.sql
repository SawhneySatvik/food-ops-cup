-- What a supplier supplies, and who else could. other_supplier_* null = the supplier is the only known source.
SELECT i.id::text AS ingredient_id, i.name AS ingredient_name,
       o.id::text AS other_supplier_id, o.name AS other_supplier_name
  FROM intel.edge g
  JOIN intel.entity i ON i.tenant_id = :tenant_id AND i.id = g.dst_entity_id
  LEFT JOIN intel.edge og ON og.tenant_id = :tenant_id AND og.kind = 'supplies' AND og.dst_entity_id = g.dst_entity_id
                         AND og.src_entity_id <> g.src_entity_id
  LEFT JOIN intel.entity o ON o.tenant_id = :tenant_id AND o.id = og.src_entity_id
 WHERE g.tenant_id = :tenant_id AND g.kind = 'supplies' AND g.src_entity_id = :supplier_id::uuid
 GROUP BY i.id, i.name, o.id, o.name
 ORDER BY i.name, i.id, o.name, o.id
 LIMIT 50
