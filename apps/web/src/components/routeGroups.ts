import type { RibEntry } from '@netsim/engine';

/** Gleichwertige Pfade (ECMP) zum selben Präfix in einer Zeile zusammenfassen. */
export function groupRoutes(routes: RibEntry[]): RibEntry[][] {
  const out: RibEntry[][] = [];
  const idx = new Map<string, RibEntry[]>();
  for (const r of routes) {
    const k = `${r.type}|${r.prefix}/${r.plen}`;
    let g = idx.get(k);
    if (!g) {
      g = [];
      idx.set(k, g);
      out.push(g);
    }
    g.push(r);
  }
  return out;
}
