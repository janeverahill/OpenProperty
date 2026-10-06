import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, FileText } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import type { DocumentRecord } from "@/types";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/page-shell";

export function DocumentsPage() {
  const { setError } = useApp();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api<{ documents: DocumentRecord[] }>("GET", "/api/documents");
      setDocuments(data.documents);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  const upcoming = useMemo(() => documents
    .filter(d => d.deadline_at)
    .sort((a, b) => String(a.deadline_at).localeCompare(String(b.deadline_at))), [documents]);

  return <PageShell title="Documents & Deadlines" meta="Filed records, AI summaries and dates that need follow-up">
    <section className="grid grid-cols-2 gap-4">
      <Card className="p-4"><div className="text-xl font-semibold tabular-nums">{documents.length}</div><div className="text-xs text-muted-foreground">Filed documents</div></Card>
      <Card className="p-4"><div className="text-xl font-semibold tabular-nums">{upcoming.length}</div><div className="text-xs text-muted-foreground">Tracked deadlines</div></Card>
    </section>
    {upcoming.length > 0 && <Card className="p-5">
      <div className="mb-3 flex items-center gap-2"><CalendarClock className="h-4 w-4 text-warning" /><h2 className="text-sm font-semibold">Deadlines</h2></div>
      <div className="space-y-3">{upcoming.map(d => <div key={d.id} className="flex items-start justify-between gap-4 border-t pt-3 first:border-0 first:pt-0">
        <div><div className="text-sm font-medium">{d.title}</div><div className="text-xs text-muted-foreground">{[d.property_name,d.unit_name,d.tenant_name].filter(Boolean).join(" · ") || "Unassigned"}</div></div>
        <div className="shrink-0 text-sm font-semibold">{d.deadline_at}</div>
      </div>)}</div>
    </Card>}
    {loading ? <div className="py-12 text-center text-muted-foreground">Loading documents…</div> :
      documents.length === 0 ? <Card className="flex flex-col items-center gap-2 p-10 text-center"><CheckCircle2 className="h-6 w-6 text-success" /><div className="font-semibold">No documents filed yet</div><div className="text-sm text-muted-foreground">Documents processed through the operations layer will appear here.</div></Card> :
      <div className="space-y-3">{documents.map(d => <Card key={d.id} className="p-4">
        <div className="flex items-start gap-3"><FileText className="mt-0.5 h-4 w-4 text-muted-foreground" /><div className="min-w-0">
          <div className="text-sm font-semibold">{d.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">{d.category} · {[d.property_name,d.unit_name,d.tenant_name].filter(Boolean).join(" · ") || "Unassigned"}</div>
          {d.ai_summary && <p className="mt-2 text-sm text-muted-foreground">{d.ai_summary}</p>}
        </div></div>
      </Card>)}</div>}
  </PageShell>;
}
