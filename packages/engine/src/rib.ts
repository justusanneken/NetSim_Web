import { parseIpv4, sameSubnet, maskToPrefix, type Ipv4Addr } from '@netsim/protocols';
import type { Port, RouterConfig } from './types';

export interface RibEntry {
  /** C = connected, L = local, S = static. */
  type: 'C' | 'L' | 'S';
  prefix: Ipv4Addr;
  plen: number;
  ad: number;
  metric: number;
  nextHop?: Ipv4Addr;
  portId?: string;
}

export const networkOf = (ip: Ipv4Addr, plen: number): Ipv4Addr => {
  const n = parseIpv4(ip) ?? 0;
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  const net = (n & m) >>> 0;
  return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.');
};

const contains = (e: RibEntry, ip: Ipv4Addr): boolean =>
  sameSubnet(e.prefix, ip, prefixMask(e.plen));

export function prefixMask(plen: number): string {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
}

/** Baut die Routing-Tabelle: Connected/Local (nur bei aktiver Schnittstelle) + installierbare Statics. */
export function buildRib(cfg: RouterConfig, ports: Port[]): RibEntry[] {
  const rib: RibEntry[] = [];
  for (const p of ports) {
    const i = cfg.ifaces[p.id];
    if (!i?.ip || !i.mask || !p.operUp) continue;
    const plen = maskToPrefix(i.mask);
    if (plen === undefined) continue;
    rib.push({ type: 'C', prefix: networkOf(i.ip, plen), plen, ad: 0, metric: 0, portId: p.id });
    rib.push({ type: 'L', prefix: i.ip, plen: 32, ad: 0, metric: 0, portId: p.id });
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
    if (r.outPortId) {
      if (connected.some((c) => c.portId === r.outPortId))
        rib.push({ ...base, portId: r.outPortId });
    } else if (r.nextHop) {
      // Rekursion nur über direkt verbundene Netze (längster Präfix)
      const via = connected
        .filter((c) => contains(c, r.nextHop as string))
        .sort((a, b) => b.plen - a.plen)[0];
      if (via) rib.push({ ...base, nextHop: r.nextHop, portId: via.portId });
    }
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
