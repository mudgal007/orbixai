"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge, Button, Card, Dialog, EmptyState, Input, Label, Skeleton, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useOrg } from "@/lib/hooks";

interface Doc {
  id: string;
  title: string;
  collection: string;
  version: number;
  sourceUrl: string | null;
  embeddingModel: string;
  createdAt: string;
  _count: { chunks: number };
}
interface Hit {
  documentId: string;
  title: string;
  sourceUrl: string | null;
  version: number;
  chunkId: string;
  content: string;
  score: number;
}

export default function KnowledgePage() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const docs = useQuery({ queryKey: ["knowledge", orgId], queryFn: () => api<{ documents: Doc[]; embeddingModel: string }>(`/orgs/${orgId}/knowledge/documents`) });
  const search = useQuery({
    queryKey: ["knowledge-search", orgId, submitted],
    queryFn: () => api<{ results: Hit[] }>(`/orgs/${orgId}/knowledge/search?q=${encodeURIComponent(submitted)}`),
    enabled: submitted.length > 1,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge"
        description="Organization-scoped documents, chunked and embedded for retrieval with citations. Retrieved text is treated as untrusted data by every agent."
        actions={can("knowledge:write") && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add document</Button>}
      />
      {docs.data?.embeddingModel === "orbix-hash-256" && (
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink-3">Embeddings use the local lexical hashing model because no embedding API is configured. Results match words, not meaning.</p>
      )}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSubmitted(query.trim()); }}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your knowledge base…" aria-label="Search knowledge" />
        <Button type="submit" icon={<Search className="size-4" />}>Search</Button>
      </form>
      {submitted && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold">Results for “{submitted}”</h3>
          {search.isLoading ? <Skeleton className="mt-3 h-24" /> : search.data?.results.length === 0 ? <p className="mt-2 text-xs text-ink-3">No matching passages.</p> : (
            <ul className="mt-3 space-y-3">
              {search.data?.results.map((h) => (
                <li key={h.chunkId} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex items-center gap-2 text-xs"><span className="font-medium text-ink">{h.title}</span><Badge>v{h.version}</Badge><span className="ml-auto tabular-nums text-ink-3">score {Number(h.score).toFixed(3)}</span></div>
                  <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-ink-2">{h.content}</p>
                  {h.sourceUrl && <a href={h.sourceUrl} className="mt-1 inline-block text-[11px] text-indigo hover:underline" target="_blank" rel="noreferrer">{h.sourceUrl}</a>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {!docs.data ? <Skeleton className="h-40" /> : docs.data.documents.length === 0 ? (
        <Card><EmptyState icon={<BookOpen className="size-5" />} title="No documents" description="Add runbooks, policies or product docs. Agents can retrieve them with the knowledge.search step." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-3"><tr><th className="px-4 py-3 font-medium">Title</th><th className="px-4 py-3 font-medium">Collection</th><th className="px-4 py-3 font-medium">Version</th><th className="px-4 py-3 font-medium">Chunks</th><th className="px-4 py-3 text-right font-medium">Added</th></tr></thead>
            <tbody className="divide-y divide-line">
              {docs.data.documents.map((d) => (
                <tr key={d.id}><td className="px-4 py-3">{d.title}</td><td className="px-4 py-3 text-ink-2">{d.collection}</td><td className="px-4 py-3"><Badge tone="indigo">v{d.version}</Badge></td><td className="px-4 py-3 tabular-nums text-ink-2">{d._count.chunks}</td><td className="px-4 py-3 text-right text-xs text-ink-3">{timeAgo(d.createdAt)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {adding && <AddDoc orgId={orgId!} onClose={() => setAdding(false)} onDone={() => qc.invalidateQueries({ queryKey: ["knowledge", orgId] })} />}
    </div>
  );
}

function AddDoc({ orgId, onClose, onDone }: { orgId: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState("general");
  const [content, setContent] = useState("");
  const m = useMutation({
    mutationFn: () => api<{ chunks: number; unchanged: boolean; document: { version: number } }>(`/orgs/${orgId}/knowledge/documents`, { body: { title, collection, content } }),
    onSuccess: (r) => {
      toast.success(r.unchanged ? "Unchanged — existing version kept" : `Indexed v${r.document.version} (${r.chunks} chunks)`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Ingest failed"),
  });
  return (
    <Dialog open onClose={onClose} title="Add document" wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label htmlFor="kt">Title</Label><Input id="kt" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div><Label htmlFor="kc" hint="same title + collection creates a new version">Collection</Label><Input id="kc" value={collection} onChange={(e) => setCollection(e.target.value)} /></div>
      </div>
      <div className="mt-3"><Label htmlFor="kb">Content</Label><Textarea id="kb" rows={12} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste text or markdown…" /></div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!title || !content} onClick={() => m.mutate()}>Index document</Button></div>
    </Dialog>
  );
}
