import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Inbox, CircleAlert, FileText, Wrench, Sparkles } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import type { InboxItem } from "@/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";

export function AiInboxPage({ navigate }: { navigate: (to: string) => void }) {
  const { setError } = useApp();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api<{ inbox_items: InboxItem[] }>("GET", "/api/inbox");
      setItems(data.inbox_items);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  async function classifyItem(item: InboxItem) {
    try {
      setProcessingId(item.id);
      const result = await api<{ routed: string; next_action?: string | null }>("POST", `/api/inbox/${item.id}/auto-process`, {});
      if (result.next_action) await api("POST", result.next_action, {});
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setProcessingId(null); }
  }

  async function processItem(item: InboxItem, kind: "maintenance" | "document") {
    try {
      setProcessingId(item.id);
      if (kind === "maintenance") {
        await api("POST", `/api/inbox/${item.id}/process-maintenance`, {});
      } else {
        await api("POST", `/api/inbox/${item.id}/process-document`, {});
      }
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setProcessingId(null); }
  }
  const waiting = items.filter(i => i.status === "new" || i.status === "classified");
  const review = items.filter(i => i.status === "needs_review");
  const handled = items.filter(i => i.status === "handled");
  return <PageShell title="AI Inbox" meta="One intake stream for email, photos, documents, integrations and manager-entered items">
    <section className="grid grid-cols-3 gap-4">
      <Metric label="Waiting" value={waiting.length} />
      <Metric label="Needs attention" value={review.length} />
      <Metric label="Handled" value={handled.length} />
    </section>
    {loading ? <div className="py-12 text-center text-muted-foreground">Loading inbox…</div> :
      items.length === 0 ? <Card className="flex flex-col items-center gap-2 p-10 text-center">
        <Inbox className="h-6 w-6 text-muted-foreground" />
        <div className="font-semibold">Inbox is clear</div>
        <div className="text-sm text-muted-foreground">Incoming operational items will appear here before the system routes them.</div>
      </Card> :
      <div className="space-y-3">{items.map(item => <Card key={item.id} className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {item.status === "needs_review" ? <CircleAlert className="h-4 w-4 text-warning" /> :
               item.status === "handled" ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Inbox className="h-4 w-4 text-muted-foreground" />}
              <p className="truncate text-sm font-semibold">{item.subject || item.item_type.replace("_", " ")}</p>
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.raw_text || "No preview available."}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {item.source_type} · {[item.property_name, item.unit_name, item.tenant_name].filter(Boolean).join(" · ") || "Not assigned"}
              {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize">{item.status.replace("_", " ")}</span>
            {(item.status === "new" || item.status === "classified") && (
              <div className="flex gap-2">
                {item.status === "new" && <Button size="sm" disabled={processingId === item.id}
                  onClick={() => void classifyItem(item)}>
                  <Sparkles className="h-3.5 w-3.5" /> Auto-process
                </Button>}
                <Button size="sm" variant="outline" disabled={processingId === item.id}
                  onClick={() => void processItem(item, "maintenance")}>
                  <Wrench className="h-3.5 w-3.5" /> Maintenance
                </Button>
                <Button size="sm" variant="outline" disabled={processingId === item.id}
                  onClick={() => void processItem(item, "document")}>
                  <FileText className="h-3.5 w-3.5" /> Document
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>)}</div>}
    {review.length > 0 && <button type="button" onClick={() => navigate("/review")}
      className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
      Review {review.length} item{review.length === 1 ? "" : "s"}
    </button>}
  </PageShell>;
}
function Metric({label,value}:{label:string;value:number}) {
  return <Card className="p-4"><div className="text-xl font-semibold tabular-nums">{value}</div><div className="text-xs text-muted-foreground">{label}</div></Card>;
}
