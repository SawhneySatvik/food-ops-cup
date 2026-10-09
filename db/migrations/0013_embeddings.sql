-- requires: vector
-- 0013_embeddings — the only pgvector-dependent objects (02-schema §4–§5): intel.chunk.embedding vector(768)
-- (ADK embed role, output_dimensionality = 768; gotcha 26), its HNSW index, the embedding column on
-- intel_ro.chunk_search, and the grants that go with them. Runs as munim_migrator.
--
-- The runner SKIPS this file loudly (and does not record it) where the server lacks the extension —
-- embedded Postgres in every gate. It applies on the dev the dev host project once F1 lands. UNVERIFIED there:
-- CREATE EXTENSION runs as munim_migrator; IF NOT EXISTS returns before any privilege check when the
-- extension is already installed, so on a server where vector is available but not installed an admin must
-- run `CREATE EXTENSION vector` once first (pgvector is not a trusted extension). `vector` is referenced
-- unqualified: it must resolve through the session search_path (the static gate forbids `extensions.`).
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE intel.chunk ADD COLUMN embedding vector(768);

-- Cosine distance (embeddings are compared by angle). An HNSW index cannot lead with tenant_id; RLS still
-- filters every row, and queries add the tenant predicate through the view's base-table policy.
CREATE INDEX chunk_embedding_hnsw_idx ON intel.chunk USING hnsw (embedding vector_cosine_ops);

-- core-api writes embeddings after chunking (`embeddings:batch`, R25).
GRANT UPDATE (embedding) ON intel.chunk TO munim_svc;
GRANT SELECT (embedding) ON intel.chunk TO munim_view_owner;

-- Appending a column keeps the view's owner (munim_view_owner) and its grants.
CREATE OR REPLACE VIEW intel_ro.chunk_search AS
  SELECT k.id, k.document_id, k.message_id, k.seq, k.text, k.tsv, k.embedding
    FROM intel.chunk k;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'intel.chunk'::regclass AND a.attname = 'embedding'
                    AND format_type(a.atttypid, a.atttypmod) = 'vector(768)') THEN
    RAISE EXCEPTION '0013: intel.chunk.embedding is not vector(768)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
                  WHERE i.indrelid = 'intel.chunk'::regclass AND ic.relname = 'chunk_embedding_hnsw_idx' AND am.amname = 'hnsw'
                    AND i.indkey::text = (SELECT attnum::text FROM pg_attribute
                                           WHERE attrelid = 'intel.chunk'::regclass AND attname = 'embedding')) THEN
    RAISE EXCEPTION '0013: HNSW index on intel.chunk(embedding) missing';
  END IF;
  IF (SELECT c.relowner FROM pg_class c WHERE c.oid = 'intel_ro.chunk_search'::regclass) <> 'munim_view_owner'::regrole THEN
    RAISE EXCEPTION '0013: intel_ro.chunk_search lost its owner';
  END IF;
  PERFORM munim_meta.assert_catalog('0013');
END $$;
