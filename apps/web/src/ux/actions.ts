import type { DeviceType } from '@netsim/engine';
import { api } from '../engine/client';
import { useStore } from '../store';
import {
  alignPositions,
  distributePositions,
  snapValue,
  type AlignMode,
  type DistributeMode,
  type Pt,
} from './geometry';
import { useDoc } from './uiDoc';
import { useUx } from './ux';

/** Positionen aller Geräte der Ansicht (Engine ist die Quelle der Wahrheit). */
function positions(ids?: string[]): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  for (const d of useStore.getState().view?.devices ?? [])
    if (!ids || ids.includes(d.id)) out[d.id] = { ...d.pos };
  return out;
}

/**
 * Mehrere Geräte auf einmal verschieben. Zentrale Stelle für Mehrfachverschiebung, Ausrichten und
 * Pfeiltasten – die Persistenz kann hier einen Undo-Schritt bündeln.
 */
export async function moveDevices(moves: Record<string, Pt>): Promise<void> {
  await Promise.all(Object.entries(moves).map(([id, p]) => api.moveDevice(id, p)));
}

export function selection(): string[] {
  const ux = useUx.getState().selectedIds;
  if (ux.length > 0) return ux;
  const one = useStore.getState().selectedDevice;
  return one ? [one] : [];
}

export function selectOnly(id: string | null): void {
  useUx.getState().setSelected(id ? [id] : []);
  useStore.getState().selectDevice(id);
  useUx.getState().setSelectedNote(null);
}

export function selectAll(): void {
  const ids = (useStore.getState().view?.devices ?? []).map((d) => d.id);
  useUx.getState().setSelected(ids);
  useStore.getState().selectDevice(ids[ids.length - 1] ?? null);
}

export async function alignSelected(mode: AlignMode): Promise<void> {
  const ids = selection();
  if (ids.length < 2) return;
  await moveDevices(alignPositions(positions(ids), mode));
}

export async function distributeSelected(mode: DistributeMode): Promise<void> {
  const ids = selection();
  if (ids.length < 3) return;
  await moveDevices(distributePositions(positions(ids), mode));
}

export function groupSelected(): string | null {
  const ids = selection();
  const id = useDoc.getState().addGroup(ids);
  if (!id) useStore.getState().showToast('ux.toast.groupNeedsTwo');
  return id;
}

export function ungroupSelected(): void {
  const ids = selection();
  const doc = useDoc.getState();
  for (const g of doc.groups) if (g.deviceIds.some((d) => ids.includes(d))) doc.ungroup(g.id);
}

export async function deleteSelection(): Promise<void> {
  const ux = useUx.getState();
  if (ux.selectedNote) {
    useDoc.getState().removeNote(ux.selectedNote);
    ux.setSelectedNote(null);
    return;
  }
  const ids = ux.selectedIds;
  if (ids.length > 1) {
    await Promise.all(ids.map((id) => api.removeDevice(id)));
    ux.setSelected([]);
    useStore.getState().selectDevice(null);
    return;
  }
  await useStore.getState().deleteSelected();
}

/** Verschiebt die Auswahl um (dx, dy) Welt-Pixel (Pfeiltasten). */
export async function nudgeSelection(dx: number, dy: number): Promise<void> {
  const ids = selection();
  const moves: Record<string, Pt> = {};
  for (const [id, p] of Object.entries(positions(ids))) moves[id] = { x: p.x + dx, y: p.y + dy };
  await moveDevices(moves);
}

/** Sichtbarer Bereich der Arbeitsfläche in Welt-Koordinaten. */
export function viewportWorld(): { x: number; y: number; w: number; h: number } {
  const el = document.querySelector('.canvas-wrap');
  const sv = useStore.getState().stageView;
  const w = (el?.clientWidth ?? 800) / sv.scale;
  const h = (el?.clientHeight ?? 500) / sv.scale;
  return { x: -sv.x / sv.scale, y: -sv.y / sv.scale, w, h };
}

/** Freie Rasterposition nahe der Bildmitte (Tastatur-Alternative zum Platzieren per Klick). */
export function freeSpotNearCenter(): Pt {
  const vp = viewportWorld();
  const snap = useUx.getState().snap;
  const cx = snapValue(vp.x + vp.w / 2, snap);
  const cy = snapValue(vp.y + vp.h / 2, snap);
  const taken = Object.values(positions());
  for (let r = 0; r < 12; r++) {
    for (let k = 0; k < Math.max(1, r * 6); k++) {
      const a = (k / Math.max(1, r * 6)) * Math.PI * 2;
      const p = {
        x: snapValue(cx + Math.cos(a) * r * 90, snap),
        y: snapValue(cy + Math.sin(a) * r * 90, snap),
      };
      if (taken.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= 80)) return p;
    }
  }
  return { x: cx, y: cy };
}

/** Gerät per Tastatur platzieren: nächster freier Platz in der Bildmitte. */
export async function placeAtFreeSpot(type: DeviceType): Promise<void> {
  const p = freeSpotNearCenter();
  await useStore.getState().addDevice(type, p.x, p.y);
  const id = useStore.getState().selectedDevice;
  if (id) selectOnly(id);
}

/** Zoom/Pan so einstellen, dass alle Geräte sichtbar sind. */
export function fitView(): void {
  const pts = Object.values(positions());
  const sv = useStore.getState();
  if (pts.length === 0) {
    sv.setStageView({ x: 0, y: 0, scale: 1 });
    return;
  }
  const el = document.querySelector('.canvas-wrap');
  const W = el?.clientWidth ?? 800;
  const H = el?.clientHeight ?? 500;
  const minX = Math.min(...pts.map((p) => p.x)) - 80;
  const maxX = Math.max(...pts.map((p) => p.x)) + 80;
  const minY = Math.min(...pts.map((p) => p.y)) - 80;
  const maxY = Math.max(...pts.map((p) => p.y)) + 80;
  const scale = Math.min(3, Math.max(0.25, Math.min(W / (maxX - minX), H / (maxY - minY))));
  sv.setStageView({
    scale,
    x: (W - (maxX - minX) * scale) / 2 - minX * scale,
    y: (H - (maxY - minY) * scale) / 2 - minY * scale,
  });
}

/** Neue Notiz an Weltposition anlegen und direkt zur Bearbeitung öffnen. */
export function addNoteAt(x: number, y: number): string {
  const id = useDoc.getState().addNote(x, y, '');
  useUx.getState().editNote(id);
  useUx.getState().setSelectedNote(id);
  return id;
}
