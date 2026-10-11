-- Every entity within `depth` hops of this one, over edges of any kind in either direction. Ids, kinds, names, depth.
WITH RECURSIVE walk(node_id, depth, path) AS (
  SELECT e.id, 0, ARRAY[e.id]
    FROM intel.entity e
   WHERE e.tenant_id = :tenant_id AND e.id = :entity_id::uuid
  UNION ALL
  SELECT nx.id, w.depth + 1, w.path || nx.id
    FROM walk w
    JOIN intel.edge g ON g.tenant_id = :tenant_id AND (g.src_entity_id = w.node_id OR g.dst_entity_id = w.node_id)
    CROSS JOIN LATERAL (SELECT CASE WHEN g.src_entity_id = w.node_id THEN g.dst_entity_id ELSE g.src_entity_id END AS id) nx
   WHERE w.depth < :depth::int AND NOT nx.id = ANY (w.path)
)
SELECT n.id::text AS node_id, n.kind, n.name, min(w.depth) AS depth
  FROM walk w
  JOIN intel.entity n ON n.tenant_id = :tenant_id AND n.id = w.node_id
 WHERE w.depth > 0
 GROUP BY n.id, n.kind, n.name
 ORDER BY depth, n.name, n.id
 LIMIT 50
