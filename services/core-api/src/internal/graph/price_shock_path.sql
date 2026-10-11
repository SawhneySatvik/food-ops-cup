-- Who is hit when this ingredient's price moves: every item that uses it (transitively, through sub-recipes) and every
-- outlet that sold those items. Reverse walk over `uses` and `sold`. Ids, kinds, names and hop depth only (no money).
-- The tenant parameter is bound by core from the run token, never by a caller; every leg reads only visible nodes and edges.
WITH RECURSIVE {{visible}}, walk(node_id, depth, path) AS (
  SELECT e.id, 0, ARRAY[e.id]
    FROM vnode e
   WHERE e.id = :ingredient_id::uuid
  UNION ALL
  SELECT g.src_entity_id, w.depth + 1, w.path || g.src_entity_id
    FROM walk w
    JOIN vedge g ON g.dst_entity_id = w.node_id AND g.kind IN ('uses', 'sold')
   WHERE w.depth < :depth::int AND NOT g.src_entity_id = ANY (w.path)
)
SELECT n.id::text AS node_id, n.kind, n.name, min(w.depth) AS depth
  FROM walk w
  JOIN vnode n ON n.id = w.node_id
 WHERE w.depth > 0
 GROUP BY n.id, n.kind, n.name
 ORDER BY depth, n.name, n.id
 LIMIT 50
