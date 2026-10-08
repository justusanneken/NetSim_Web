import { maskToPrefix, parseIpv4, sameSubnet, type Ipv4Addr } from '@netsim/protocols';
import type { Iface } from './ifaces';
import type { L3Cfg } from './types';

export type RibType = 'C' | 'L' | 'S' | 'R' | 'O' | 'D' | 'B';

export interface RibEntry {
  type: RibType;
  /** Unterart (OSPF `IA`/`E2`, EIGRP `EX`, …). */
  sub?: string;
  /** Quelle bei dynamischen Routen (`ospf:1`, `rip`, …). */
  src?: string;
  prefix: Ipv4Addr;
  plen: number;
  ad: number;
  metric: number;
  nextHop?: Ipv4Addr;
  ifaceId?: string;
  since?: number;
  /** Ungleiche Lastverteilung (EIGRP-Variance): relatives Gewicht dieses Pfads. */
  share?: number;
}

export const prefixMask = (plen: number): string => {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
};

export const networkOf = (ip: Ipv4Addr, plen: number): Ipv4Addr => {
  const n = parseIpv4(ip) ?? 0;
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  const net = (n & m) >>> 0;
  return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.');
};

const contains = (e: RibEntry, ip: Ipv4Addr): boolean =>
  sameSubnet(e.prefix, ip, prefixMask(e.plen));

/** Baut die Routing-Tabelle: Connected/Local, Statics (installierbar) und dynamische Routen. */
export function buildRib(cfg: L3Cfg, ifaces: Iface[]): RibEntry[] {
  const rib: RibEntry[] = [];
  for (const i of ifaces) {
    const plen = maskToPrefix(i.mask);
    if (plen === undefined) continue;
    rib.push({ type: 'C', prefix: networkOf(i.ip, plen), plen, ad: 0, metric: 0, ifaceId: i.id });
    rib.push({ type: 'L', prefix: i.ip, plen: 32, ad: 0, metric: 0, ifaceId: i.id });
  }
  const connected = rib.filter((e) => e.type === 'C');
  for (const r of cfg.staticRoutes) {
    const plen = maskToPrefix(r.mask);
    if (plen === undefined) continue;
    const base = {
      type: 'S' as const,
      prefix: networkOf(r.prefix, plen),
      plen,
      ad: r.ad,
      metric: 0,
    };
    if (r.outIfaceId) {
      if (connected.some((c) => c.ifaceId === r.outIfaceId))
        rib.push({ ...base, ifaceId: r.outIfaceId });
    } else if (r.nextHop) {
      const via = connected
        .filter((c) => contains(c, r.nextHop as string))
        .sort((a, b) => b.plen - a.plen)[0];
      if (via) rib.push({ ...base, nextHop: r.nextHop, ifaceId: via.ifaceId });
    }
  }
  for (const d of cfg.dynRoutes) {
    if (!ifaces.some((i) => i.id === d.ifaceId)) continue;
    rib.push({
      type: d.proto,
      sub: d.sub,
      src: d.src,
      prefix: d.prefix,
      plen: d.plen,
      ad: d.ad,
      metric: d.metric,
      nextHop: d.nextHop,
      ifaceId: d.ifaceId,
      since: d.since,
      share: d.share,
    });
  }
  return rib;
}

/** Longest-Prefix-Match; bei Gleichstand niedrigere AD, dann Metrik. `L` wird nicht weitergeleitet. */
export function lookupRib(rib: RibEntry[], dst: Ipv4Addr): RibEntry | undefined {
  let best: RibEntry | undefined;
  for (const e of rib) {
    if (e.type === 'L' || !contains(e, dst)) continue;
    if (
      !best ||
      e.plen > best.plen ||
      (e.plen === best.plen && (e.ad < best.ad || (e.ad === best.ad && e.metric < best.metric)))
    )
      best = e;
  }
  return best;
}

/** Alle Pfade des besten Präfix (gleiche Länge/AD und gleiche Metrik bzw. Gewicht) – Basis für ECMP. */
export function lookupRibAll<T extends RibEntry>(
  rib: T[],
  dst: string,
  match: (e: T, dst: string) => boolean,
): T[] {
  let best: T | undefined;
  for (const e of rib) {
    if (e.type === 'L' || !match(e, dst)) continue;
    if (
      !best ||
      e.plen > best.plen ||
      (e.plen === best.plen && (e.ad < best.ad || (e.ad === best.ad && e.metric < best.metric)))
    )
      best = e;
  }
  if (!best) return [];
  const b = best;
  const out = rib.filter(
    (e) =>
      e.type !== 'L' &&
      e.prefix === b.prefix &&
      e.plen === b.plen &&
      e.ad === b.ad &&
      (e.metric === b.metric || (e.share !== undefined && b.share !== undefined)),
  );
  out.sort(
    (x, y) =>
      (x.nextHop ?? '').localeCompare(y.nextHop ?? '') ||
      (x.ifaceId ?? '').localeCompare(y.ifaceId ?? ''),
  );
  return out;
}

const hashStr = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Pro-Flow-Auswahl (Hash über Quelle/Ziel) unter gleichwertigen Pfaden; berücksichtigt `share`. */
export function pickPath<T extends RibEntry>(paths: T[], src: string | undefined, dst: string): T {
  if (paths.length === 1) return paths[0] as T;
  const weights = paths.map((p) => Math.max(1, p.share ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let h = (hashStr(`${src ?? ''}>${dst}`) % total) | 0;
  for (let i = 0; i < paths.length; i++) {
    h -= weights[i] as number;
    if (h < 0) return paths[i] as T;
  }
  return paths[0] as T;
}

/** IPv4: alle gleichwertigen Pfade zum Ziel. */
export const lookupRibPaths = (rib: RibEntry[], dst: Ipv4Addr): RibEntry[] =>
  lookupRibAll(rib, dst, contains);

/**
 * Tatsächlich installierte Routen: je Präfix nur die Quelle mit der niedrigsten AD, davon die
 * beste Metrik (gleichwertige Pfade und ungleiche Lastverteilung bleiben erhalten).
 */
export function installedRoutes(rib: RibEntry[]): RibEntry[] {
  const best = new Map<string, RibEntry>();
  for (const e of rib) {
    if (e.type === 'L') continue;
    const k = `${e.prefix}/${e.plen}`;
    const cur = best.get(k);
    if (!cur || e.ad < cur.ad || (e.ad === cur.ad && e.metric < cur.metric)) best.set(k, e);
  }
  return rib.filter((e) => {
    if (e.type === 'L') return true;
    const b = best.get(`${e.prefix}/${e.plen}`) as RibEntry;
    return (
      e.ad === b.ad && (e.metric === b.metric || (e.share !== undefined && b.share !== undefined))
    );
  });
}
