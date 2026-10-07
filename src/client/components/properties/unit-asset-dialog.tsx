import { useEffect, useState } from "react";
import { api } from "@/api";
import { useApp } from "@/context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Unit, UnitAsset } from "@/types";

export function UnitAssetDialog({ open, onOpenChange, unit, asset, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; unit: Unit; asset?: UnitAsset; onSaved?: () => void;
}) {
  const app = useApp();
  const [assetType, setAssetType] = useState("property_history");
  const [description, setDescription] = useState("");
  const [installedAt, setInstalledAt] = useState("");
  const [life, setLife] = useState("");
  const [cost, setCost] = useState("");
  const [status, setStatus] = useState<UnitAsset["status"]>("active");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAssetType(asset?.asset_type ?? "property_history");
    setDescription(asset?.description ?? "");
    setInstalledAt(asset?.installed_at?.slice(0, 10) ?? "");
    setLife(asset?.expected_life_years != null ? String(asset.expected_life_years) : "");
    setCost(asset?.replacement_cost != null ? String(asset.replacement_cost) : "");
    setStatus(asset?.status ?? "active");
    setNotes(asset?.notes ?? "");
  }, [open, asset]);

  async function save() {
    if (asset ? !assetType.trim() : !description.trim()) return;
    setSaving(true);
    try {
      const payload = {
        unit_id: unit.id, asset_type: assetType.trim(), description: description.trim() || null,
        installed_at: installedAt || null, expected_life_years: life ? Number(life) : null,
        replacement_cost: cost ? Number(cost) : null, status, notes: notes.trim() || null,
      };
      await api(asset ? "PUT" : "POST", asset ? `/api/unit-assets/${asset.id}` : "/api/unit-assets", payload);
      onSaved?.(); onOpenChange(false);
    } catch (err) { app.setError((err as Error).message); }
    finally { setSaving(false); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{asset ? "Edit unit history" : `Add unit history — ${unit.name}`}</DialogTitle></DialogHeader>
    <div className="grid gap-3">
      {asset && asset.asset_type !== "property_history" && <div><Label htmlFor="asset-type">Record type</Label><Input id="asset-type" value={assetType} onChange={e => setAssetType(e.target.value)} /></div>}
      <div><Label htmlFor="asset-description">What happened?</Label><Input id="asset-description" value={description} onChange={e => setDescription(e.target.value)} placeholder="New Whirlpool stove" /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="asset-date">Date</Label><Input id="asset-date" type="date" value={installedAt} onChange={e => setInstalledAt(e.target.value)} /></div>
        <div><Label htmlFor="asset-cost">Cost</Label><Input id="asset-cost" type="number" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} /></div>
      </div>
      {asset && asset.asset_type !== "property_history" && <>
        <div><Label htmlFor="asset-life">Expected life (years)</Label><Input id="asset-life" type="number" min="1" value={life} onChange={e => setLife(e.target.value)} /></div>
        <div><Label>Status</Label><Select value={status} onValueChange={v => setStatus(v as UnitAsset["status"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="active">Active</SelectItem><SelectItem value="needs_attention">Needs attention</SelectItem><SelectItem value="replaced">Replaced</SelectItem><SelectItem value="removed">Removed</SelectItem>
        </SelectContent></Select></div>
      </>}
      <div><Label htmlFor="asset-notes">Notes</Label><Textarea id="asset-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} /></div>
    </div>
    <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={saving || (asset ? !assetType.trim() : !description.trim())}>{saving ? "Saving…" : "Save"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
