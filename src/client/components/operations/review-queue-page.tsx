import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CheckCircle2 } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import type { ReviewItem } from "@/types";
import { Card } from "@/components/ui/card";
import { PageShell } from "@/components/page-shell";

function proposalDetails(item: ReviewItem) {
  if (!item.proposed_json) return [] as Array<[string, string]>;
  try {
    const value = JSON.parse(item.proposed_json) as Record<string, unknown>;
    const labels: Record<string, string> = {
      title: "Title", priority: "Priority", category: "Category",
      document_date: "Document date", deadline_at: "Deadline",
      description: "Description", ai_summary: "Summary",
      history_label: "Unit history", history_cost: "Cost",
    };
    return Object.entries(value)
      .filter(([key, val]) => key !== "storage_ref" && val != null && String(val).trim() !== "")
      .map(([key, val]) => [labels[key] || key.replaceAll("_", " "), String(val)] as [string, string]);
  } catch { return [] as Array<[string, string]>; }
}

export function ReviewQueuePage() {
  const { setError } = useApp();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api<{ review_items: ReviewItem[] }>("GET", "/api/review-items?status=open");
      setItems(data.review_items);
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);
  async function resolve(item: ReviewItem, status: "approved" | "dismissed") {
    try {
      setWorking(item.id);
      await api("POST", `/api/review-items/${item.id}/resolve`, {
        status, resolution: status === "approved" ? "Approved by manager" : "Dismissed by manager",
      });
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(null); }
  }
  return <PageShell title="Needs Attention" meta="Only exceptions and decisions that need a human">
    {loading ? <div className="py-12 text-center text-muted-foreground">Loading review queue…</div> :
      items.length === 0 ? <Card className="flex flex-col items-center gap-2 p-10 text-center">
        <CheckCircle2 className="h-6 w-6 text-success" />
        <div className="font-semibold">You're caught up</div>
        <div className="text-sm text-muted-foreground">Nothing needs your decision right now.</div>
      </Card> :
      <div className="space-y-3">{items.map(item => <Card key={item.id} className="p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              {item.risk_level === "high" && <CircleAlert className="h-4 w-4 text-destructive" />}
              <h2 className="font-semibold">{item.title}</h2>
            </div>
            <p className="text-sm text-muted-foreground">{item.reason || "Manager review requested."}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {[item.property_name, item.unit_name, item.tenant_name].filter(Boolean).join(" · ")}
              {item.confidence != null ? ` · AI confidence ${Math.round(item.confidence * 100)}%` : ""}
            </p>
            {item.proposed_action && <p className="mt-3 text-sm"><span className="font-medium">Suggested:</span> {item.proposed_action}</p>}
            {proposalDetails(item).length > 0 && <div className="mt-3 rounded-md border bg-muted/30 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What will happen if you approve</div>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {proposalDetails(item).map(([label, value]) => <div key={label} className={label === "Description" || label === "Summary" ? "sm:col-span-2" : ""}>
                  <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                  <dd className="whitespace-pre-wrap">{value}</dd>
                </div>)}
              </dl>
            </div>}
          </div>
          <div className="flex shrink-0 gap-2">
            <button disabled={working === item.id} onClick={() => void resolve(item, "dismissed")}
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Dismiss</button>
            <button disabled={working === item.id} onClick={() => void resolve(item, "approved")}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Approve</button>
          </div>
        </div>
      </Card>)}</div>}
  </PageShell>;
}
