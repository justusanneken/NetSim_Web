import { ipv6Network, parseIpv4 } from '@netsim/protocols';
import { matchAddr } from '../acl';
import type { Acl } from '../types';
import type { RoutingCfg } from './types';

/**
 * Prefix-Lists, Community-Listen und Route-Maps (IOS-Semantik, vereinfacht):
 * Filter für BGP (`neighbor … route-map|prefix-list`), Redistribution und `distribute-list`.
 */

export interface PrefixListEntry {
  seq: number;
  action: 'permit' | 'deny';
  prefix: string;
  plen: number;
  ge?: number;
  le?: number;
}

export interface PrefixList {
  name: string;
  entries: PrefixListEntry[];
}

export interface CommunityList {
  name: string;
  entries: { action: 'permit' | 'deny'; values: string[] }[];
}

export interface RouteMapSet {
  localPref?: number;
  metric?: number;
  /** OSPF-Redistribution: externer Typ. */
  metricType?: 1 | 2;
  tag?: number;
  weight?: number;
  asPathPrepend?: number[];
  /** `set community …` (`additive`: an vorhandene anhängen). `none` löscht alle. */
  community?: { values: string[]; additive: boolean; none?: boolean };
  nextHop?: string;
  origin?: 'igp' | 'egp' | 'incomplete';
  /** EIGRP: `set metric BW DELAY …` (Bandbreite kbit/s, Delay in 10 µs). */
  eigrpMetric?: { bw: number; delay: number };
}

export interface RouteMapClause {
  seq: number;
  action: 'permit' | 'deny';
  matchPrefixLists: string[];
  matchAcls: string[];
  matchTags: number[];
  matchCommunities: string[];
  matchMetrics: number[];
  matchNextHopPrefixLists: string[];
  set: RouteMapSet;
}

export interface RouteMap {
  name: string;
  clauses: RouteMapClause[];
}

/** Eine Route, wie sie von Filtern betrachtet wird. */
export interface RouteInfo {
  prefix: string;
  plen: number;
  v6?: boolean;
  tag?: number;
  metric?: number;
  nextHop?: string;
  communities?: string[];
}

export const newRouteMapClause = (seq: number, action: 'permit' | 'deny'): RouteMapClause => ({
  seq,
  action,
  matchPrefixLists: [],
  matchAcls: [],
  matchTags: [],
  matchCommunities: [],
  matchMetrics: [],
  matchNextHopPrefixLists: [],
  set: {},
});

const inPrefix = (r: RouteInfo, base: string, plen: number): boolean =>
  r.v6
    ? ipv6Network(r.prefix, plen) === ipv6Network(base, plen)
    : v4Net(r.prefix, plen) === v4Net(base, plen);

const v4Net = (ip: string, plen: number): number => {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  return ((parseIpv4(ip) ?? 0) & m) >>> 0;
};

/** Prefix-List auswerten: `true` = permit, `false` = deny/kein Treffer (impliziertes deny). */
export function prefixListPermits(pl: PrefixList | undefined, r: RouteInfo): boolean {
  if (!pl) return true;
  const entries = [...pl.entries].sort((a, b) => a.seq - b.seq);
  for (const e of entries) {
    if (r.plen < e.plen || !inPrefix(r, e.prefix, e.plen)) continue;
    const lo = e.ge ?? (e.le !== undefined ? e.plen : e.plen);
    const hi = e.le ?? (e.ge !== undefined ? (r.v6 ? 128 : 32) : e.plen);
    if (r.plen >= lo && r.plen <= hi) return e.action === 'permit';
  }
  return false;
}

/** Standard-/Erweiterte ACL auf Routen: Quelle = Netz, bei erweiterten ACLs Ziel = Maske. */
export function aclPermitsRoute(acl: Acl | undefined, r: RouteInfo): boolean {
  if (!acl) return true;
  if (r.v6) return true;
  const mask = r.plen === 0 ? 0 : (0xffffffff << (32 - r.plen)) >>> 0;
  const maskIp = [mask >>> 24, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.');
  for (const e of acl.entries) {
    if (!matchAddr(e.src, r.prefix)) continue;
    if (acl.type === 'extended' && e.dst && !matchAddr(e.dst, maskIp)) continue;
    return e.action === 'permit';
  }
  return false;
}

export function communityListPermits(cl: CommunityList | undefined, comms: string[]): boolean {
  if (!cl) return false;
  for (const e of cl.entries) {
    if (e.values.some((v) => comms.includes(v))) return e.action === 'permit';
  }
  return false;
}

export interface MapResult {
  permit: boolean;
  set?: RouteMapSet;
}

export interface FilterEnv {
  routing: Pick<RoutingCfg, 'prefixLists' | 'prefixLists6' | 'routeMaps' | 'communityLists'>;
  acls: Record<string, Acl>;
}

/** Route-Map auswerten. Unbekannte Route-Map = alles erlaubt, keine Änderung. */
export function evalRouteMap(env: FilterEnv, name: string | undefined, r: RouteInfo): MapResult {
  if (!name) return { permit: true };
  const rm = env.routing.routeMaps[name];
  if (!rm) return { permit: true };
  const lists = r.v6 ? env.routing.prefixLists6 : env.routing.prefixLists;
  for (const c of [...rm.clauses].sort((a, b) => a.seq - b.seq)) {
    let ok = true;
    if (ok && c.matchPrefixLists.length)
      ok = c.matchPrefixLists.some((n) => prefixListPermits(lists[n], r) && lists[n] !== undefined);
    if (ok && c.matchAcls.length) ok = c.matchAcls.some((n) => aclPermitsRoute(env.acls[n], r));
    if (ok && c.matchTags.length) ok = c.matchTags.includes(r.tag ?? 0);
    if (ok && c.matchMetrics.length) ok = c.matchMetrics.includes(r.metric ?? 0);
    if (ok && c.matchCommunities.length)
      ok = c.matchCommunities.some((n) =>
        communityListPermits(env.routing.communityLists[n], r.communities ?? []),
      );
    if (ok && c.matchNextHopPrefixLists.length)
      ok = c.matchNextHopPrefixLists.some((n) =>
        prefixListPermits(lists[n], { prefix: r.nextHop ?? '0.0.0.0', plen: 32, v6: r.v6 }),
      );
    if (!ok) continue;
    return c.action === 'permit' ? { permit: true, set: c.set } : { permit: false };
  }
  return { permit: false };
}

/** Filter über `distribute-list`/Prefix-List-Name oder ACL-Name. */
export function filterPermits(
  env: FilterEnv,
  kind: 'acl' | 'prefix-list',
  name: string,
  r: RouteInfo,
): boolean {
  if (kind === 'acl') return aclPermitsRoute(env.acls[name], r);
  const lists = r.v6 ? env.routing.prefixLists6 : env.routing.prefixLists;
  return prefixListPermits(lists[name], r);
}

/** Wendet `set community` auf eine Community-Liste an. */
export function applyCommunities(
  cur: string[] | undefined,
  set: NonNullable<RouteMapSet['community']>,
): string[] | undefined {
  if (set.none) return undefined;
  return set.additive ? [...new Set([...(cur ?? []), ...set.values])] : [...set.values];
}
