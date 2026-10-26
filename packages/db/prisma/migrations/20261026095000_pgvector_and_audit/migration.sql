-- Optional pgvector acceleration. Applies only where the `vector` extension is installed
-- (the docker-compose image ships it). Without it, knowledge search falls back to cosine over float8[].
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS embedding_vec vector(256);
    CREATE INDEX IF NOT EXISTS knowledge_chunk_embedding_hnsw
      ON "KnowledgeChunk" USING hnsw (embedding_vec vector_cosine_ops);
  END IF;
END $$;

-- Audit log is append-only: block UPDATE and DELETE at the database level.
CREATE OR REPLACE FUNCTION orbix_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_immutable ON "AuditEvent";
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION orbix_audit_immutable();
