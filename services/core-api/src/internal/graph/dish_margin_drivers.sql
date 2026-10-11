-- What a dish is made of (transitively through sub-recipes) and who supplies each ingredient. Forward walk over `uses`,
-- then `supplies`. A supplier column that is null means no supplier edge is known. Ids, kinds, names, depth only.
WITH RECURSIVE {{visible}}, walk(node_id, depth, path) AS (
  SELECT e.id, 0, ARRAY[e.id]
    FROM vnode e
   WHERE e.id = :item_id::uuid
  UNION ALL
  SELECT g.dst_entity_id, w.depth + 1, w.path || g.dst_entity_id
    FROM walk w
    JOIN vedge g ON g.src_entity_id = w.node_id AND g.kind = 'uses'
   WHERE w.depth < :depth::int AND NOT g.dst_entity_id = ANY (w.path)
)
SELECT i.id::text AS ingredient_id, i.name AS ingredient_name, min(w.depth) AS depth,
       s.id::text AS supplier_id, s.name AS supplier_name
  FROM walk w
  JOIN vnode i ON i.id = w.node_id AND i.kind = 'ingredient'
  LEFT JOIN vedge sg ON sg.kind = 'supplies' AND sg.dst_entity_id = i.id
  LEFT JOIN vnode s ON s.id = sg.src_entity_id
 WHERE w.depth > 0
 GROUP BY i.id, i.name, s.id, s.name
 ORDER BY depth, i.name, i.id, s.name, s.id
 LIMIT 50
