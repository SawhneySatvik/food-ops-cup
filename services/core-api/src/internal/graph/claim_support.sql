-- The claims a finding stands on, the entities each mentions, and the claims that contradict them (either direction).
-- relation: 'supports' | 'contradicts'. Claim nodes are entities of kind 'other' named `claim:<id>`.
WITH supp AS (
  SELECT g.dst_entity_id AS claim_id
    FROM intel.edge g
   WHERE g.tenant_id = :tenant_id AND g.kind = 'supported_by' AND g.src_entity_id = :finding_id::uuid
), contra AS (
  SELECT x.claim_id
    FROM (SELECT g.dst_entity_id AS claim_id
            FROM intel.edge g JOIN supp s ON s.claim_id = g.src_entity_id
           WHERE g.tenant_id = :tenant_id AND g.kind = 'contradicts'
          UNION
          SELECT g.src_entity_id
            FROM intel.edge g JOIN supp s ON s.claim_id = g.dst_entity_id
           WHERE g.tenant_id = :tenant_id AND g.kind = 'contradicts') x
   WHERE x.claim_id NOT IN (SELECT claim_id FROM supp)
), claims AS (
  SELECT claim_id, 'supports' AS relation FROM supp
  UNION ALL
  SELECT claim_id, 'contradicts' FROM contra
)
SELECT c.claim_id::text AS claim_id, n.name AS claim_name, c.relation, m.id::text AS entity_id, m.name AS entity_name
  FROM claims c
  JOIN intel.entity n ON n.tenant_id = :tenant_id AND n.id = c.claim_id
  LEFT JOIN intel.edge me ON me.tenant_id = :tenant_id AND me.kind = 'mentions' AND me.src_entity_id = c.claim_id
  LEFT JOIN intel.entity m ON m.tenant_id = :tenant_id AND m.id = me.dst_entity_id
 ORDER BY c.relation DESC, n.name, c.claim_id, m.name, m.id
 LIMIT 50
