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
