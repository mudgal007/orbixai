import type { PrismaClient } from "@orbix/db";
import { sha256 } from "@orbix/core/node";
import type { ModelClient } from "./model";

export function chunkText(text: string, target = 800, overlap = 120): string[] {
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > target) {
      chunks.push(cur);
      cur = cur.slice(-overlap) + "\n\n" + p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    while (cur.length > target * 1.5) {
      chunks.push(cur.slice(0, target));
      cur = cur.slice(target - overlap);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

let vectorSupport: boolean | undefined;

/** True when migration installed pgvector and the mirrored `embedding_vec` column exists. */
export async function hasPgvector(prisma: PrismaClient): Promise<boolean> {
  if (vectorSupport !== undefined) return vectorSupport;
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM information_schema.columns
    WHERE table_name = 'KnowledgeChunk' AND column_name = 'embedding_vec'`;
  vectorSupport = Number(rows[0]?.n ?? 0) > 0;
  return vectorSupport;
}

export async function ingestDocument(
  prisma: PrismaClient,
  model: ModelClient,
  input: { organizationId: string; title: string; content: string; collection: string; sourceUrl?: string; createdById?: string; retentionDays?: number },
) {
  const contentHash = sha256(input.content);
  const previous = await prisma.knowledgeDocument.findFirst({
    where: { organizationId: input.organizationId, collection: input.collection, title: input.title },
    orderBy: { version: "desc" },
  });
  if (previous && previous.contentHash === contentHash) return { document: previous, chunks: 0, unchanged: true };

  const pieces = chunkText(input.content);
  const embeddings = await model.embed(pieces);
  const doc = await prisma.knowledgeDocument.create({
    data: {
      organizationId: input.organizationId,
      collection: input.collection,
      title: input.title,
      sourceUrl: input.sourceUrl,
      version: (previous?.version ?? 0) + 1,
      supersedesId: previous?.id,
      contentHash,
      embeddingModel: model.embeddingModel,
      createdById: input.createdById,
      retentionUntil: input.retentionDays ? new Date(Date.now() + input.retentionDays * 86_400_000) : null,
    },
  });
  await prisma.knowledgeChunk.createMany({
    data: pieces.map((content, ordinal) => ({
      organizationId: input.organizationId,
      documentId: doc.id,
      ordinal,
      content,
      tokenCount: Math.ceil(content.length / 4),
      embedding: embeddings[ordinal] ?? [],
    })),
  });
  if (await hasPgvector(prisma)) {
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeChunk" SET embedding_vec = embedding::vector WHERE "documentId" = $1`,
      doc.id,
    );
  }
  return { document: doc, chunks: pieces.length, unchanged: false };
}

export interface SearchHit {
  documentId: string;
  title: string;
  sourceUrl: string | null;
  version: number;
  chunkId: string;
  content: string;
  score: number;
}

/** Org-scoped semantic search over the latest, unexpired version of each document. */
export async function searchKnowledge(
  prisma: PrismaClient,
  model: ModelClient,
  input: { organizationId: string; query: string; limit?: number; collection?: string },
): Promise<SearchHit[]> {
  const [vec] = await model.embed([input.query]);
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const literal = `[${(vec ?? []).join(",")}]`;
  const useVector = await hasPgvector(prisma);
  const score = useVector
    ? `1 - (c.embedding_vec <=> $2::vector)`
    : `(SELECT COALESCE(SUM(a * b), 0) FROM unnest(c.embedding, $2::float8[]) AS t(a, b))`;
  const param = useVector ? literal : `{${(vec ?? []).join(",")}}`;
  return prisma.$queryRawUnsafe<SearchHit[]>(
    `SELECT d.id AS "documentId", d.title, d."sourceUrl", d.version, c.id AS "chunkId", c.content, ${score} AS score
       FROM "KnowledgeChunk" c
       JOIN "KnowledgeDocument" d ON d.id = c."documentId"
      WHERE c."organizationId" = $1 AND d."organizationId" = $1
        AND d."embeddingModel" = $3
        AND ($5::text IS NULL OR d.collection = $5)
        AND (d."retentionUntil" IS NULL OR d."retentionUntil" > now())
        AND NOT EXISTS (SELECT 1 FROM "KnowledgeDocument" n WHERE n."supersedesId" = d.id)
      ORDER BY score DESC
      LIMIT $4`,
    input.organizationId,
    param,
    model.embeddingModel,
    limit,
    input.collection ?? null,
  );
}
