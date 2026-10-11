-- The claims a finding stands on, the entities each mentions, and the claims that contradict them (either direction).
-- relation: 'supports' | 'contradicts'. Claim nodes are entities of kind 'other' named `claim:<id>`.
WITH {{visible}}, supp AS (
  SELECT g.dst_entity_id AS claim_id
    FROM vedge g
   WHERE g.kind = 'supported_by' AND g.src_entity_id = :finding_id::uuid
), contra AS (
  SELECT x.claim_id
    FROM (SELECT g.dst_entity_id AS claim_id
            FROM vedge g JOIN supp s ON s.claim_id = g.src_entity_id
           WHERE g.kind = 'contradicts'
          UNION
          SELECT g.src_entity_id
            FROM vedge g JOIN supp s ON s.claim_id = g.dst_entity_id
           WHERE g.kind = 'contradicts') x
   WHERE x.claim_id NOT IN (SELECT claim_id FROM supp)
), claims AS (
  SELECT claim_id, 'supports' AS relation FROM supp
  UNION ALL
  SELECT claim_id, 'contradicts' FROM contra
)
SELECT c.claim_id::text AS claim_id, n.name AS claim_name, c.relation, m.id::text AS entity_id, m.name AS entity_name
  FROM claims c
  JOIN vnode n ON n.id = c.claim_id
  LEFT JOIN vedge me ON me.kind = 'mentions' AND me.src_entity_id = c.claim_id
  LEFT JOIN vnode m ON m.id = me.dst_entity_id
 ORDER BY c.relation DESC, n.name, c.claim_id, m.name, m.id
 LIMIT 50
