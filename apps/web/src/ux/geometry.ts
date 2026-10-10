/** Reine Geometrie-Helfer der Arbeitsfläche (Ausrichten, Verteilen, Rubberband, Raster). */

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter';
export type DistributeMode = 'horizontal' | 'vertical';

export const GRID_SIZE = 20;

/** Rastet auf das halbe Raster (10 px) ein; ohne Snap auf ganze Pixel. */
export function snapValue(v: number, on: boolean, grid = GRID_SIZE): number {
  return on ? Math.round(v / (grid / 2)) * (grid / 2) : Math.round(v);
}

/** Normalisiert ein Rechteck aus zwei beliebigen Eckpunkten. */
export function rectFrom(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Ids aller Punkte, die im Rechteck liegen (Rubberband-Auswahl). */
export function idsInRect(points: Record<string, Pt>, r: Rect): string[] {
  return Object.entries(points)
    .filter(([, p]) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h)
    .map(([id]) => id);
}

/** Neue Positionen nach „Ausrichten“; nur geänderte Einträge. */
export function alignPositions(points: Record<string, Pt>, mode: AlignMode): Record<string, Pt> {
  const ids = Object.keys(points);
  if (ids.length < 2) return {};
  const xs = ids.map((i) => (points[i] as Pt).x);
  const ys = ids.map((i) => (points[i] as Pt).y);
  const target =
    mode === 'left'
      ? Math.min(...xs)
      : mode === 'right'
        ? Math.max(...xs)
        : mode === 'top'
          ? Math.min(...ys)
          : mode === 'bottom'
            ? Math.max(...ys)
            : mode === 'hcenter'
              ? (Math.min(...xs) + Math.max(...xs)) / 2
              : (Math.min(...ys) + Math.max(...ys)) / 2;
  const out: Record<string, Pt> = {};
  for (const id of ids) {
    const p = points[id] as Pt;
    const n =
      mode === 'left' || mode === 'right' || mode === 'hcenter'
        ? { x: target, y: p.y }
        : { x: p.x, y: target };
    if (n.x !== p.x || n.y !== p.y) out[id] = n;
  }
  return out;
}

/** Gleichmäßig verteilen (äußere Elemente bleiben stehen); mindestens drei Punkte. */
export function distributePositions(
  points: Record<string, Pt>,
  mode: DistributeMode,
): Record<string, Pt> {
  const ids = Object.keys(points);
  if (ids.length < 3) return {};
  const key = mode === 'horizontal' ? 'x' : 'y';
  const sorted = [...ids].sort(
    (a, b) => (points[a] as Pt)[key] - (points[b] as Pt)[key] || a.localeCompare(b),
  );
  const first = (points[sorted[0] as string] as Pt)[key];
  const last = (points[sorted[sorted.length - 1] as string] as Pt)[key];
  const step = (last - first) / (sorted.length - 1);
  const out: Record<string, Pt> = {};
  sorted.forEach((id, i) => {
    const p = points[id] as Pt;
    const v = Math.round(first + step * i);
    if (v !== p[key]) out[id] = { ...p, [key]: v };
  });
  return out;
}

/** Umschließendes Rechteck mit Rand. */
export function boundsOf(points: Pt[], pad: number): Rect | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** Zoom um einen Fixpunkt (Strg+Mausrad, Pinch); Skalierung begrenzt auf 0,25 … 3. */
export function zoomAt(
  view: { x: number; y: number; scale: number },
  pointer: Pt,
  factor: number,
): { x: number; y: number; scale: number } {
  const scale = Math.min(3, Math.max(0.25, view.scale * factor));
  const wx = (pointer.x - view.x) / view.scale;
  const wy = (pointer.y - view.y) / view.scale;
  return { scale, x: pointer.x - wx * scale, y: pointer.y - wy * scale };
}
