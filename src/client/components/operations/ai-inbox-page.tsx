import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Inbox, CircleAlert } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import type { InboxItem } from "@/types";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/page-shell";

export function AiInboxPage({ navigate }: { navigate: (to: string) => void }) {
  const { setError } = useApp();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api<{ inbox_items: InboxItem[] }>("GET", "/api/inbox");
      setItems(data.inbox_items);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);
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
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize">{item.status.replace("_", " ")}</span>
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
