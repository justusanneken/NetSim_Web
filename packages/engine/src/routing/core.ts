import {
  isMulticastIpv4,
  multicastMacV4,
  parseIpv4,
  type IpPayload,
  type Ipv4Addr,
  type ProtoTag,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { L3Dev } from '../devices/l3dev';
import { l3Node } from '../devices/l3dev';
import type { Iface } from '../ifaces';
import { eth, ipSend, ipSendVia, newIpPacket, type IpNode } from '../l3';
import { buildRib, networkOf, type RibEntry } from '../rib';
import type { DynRoute, L3Cfg, Msg } from '../types';
import type { RedistCfg, RoutingCfg } from './types';

/** Arbeitskontext eines Routing-Schritts: Ereignis-Kontext + IP-Sicht des Geräts. */
export interface Rt {
  ctx: DeviceCtx;
  dev: L3Dev;
  node: IpNode;
  cfg: L3Cfg;
  r: RoutingCfg;
}

export function rtOf(ctx: DeviceCtx, dev: L3Dev): Rt {
  const node = l3Node(ctx, dev);
  return { ctx, dev, node, cfg: dev.config, r: dev.config.routing };
}

export const pfxKey = (prefix: string, plen: number): string => `${prefix}/${plen}`;

export const isRouterWide = (cfg: L3Cfg): boolean => 'sys' in cfg;

// ------------------------------------------------------------------ Adressen

const ipNum = (ip: string): number => parseIpv4(ip) ?? 0;

/** `ip` liegt in `base` unter dem Wildcard (0 = muss übereinstimmen). */
export function wildcardMatch(ip: Ipv4Addr, base: Ipv4Addr, wildcard: string): boolean {
  const wc = ipNum(wildcard);
  return (ipNum(ip) | wc) >>> 0 === (ipNum(base) | wc) >>> 0;
}

export function classfulPlen(ip: Ipv4Addr): number {
  const first = ipNum(ip) >>> 24;
  return first < 128 ? 8 : first < 192 ? 16 : 24;
}

export const classfulNet = (ip: Ipv4Addr): Ipv4Addr => networkOf(ip, classfulPlen(ip));

export function plenOfMask(mask: string): number {
  const n = ipNum(mask);
  let c = 0;
  for (let b = 31; b >= 0; b--) if (((n >>> b) & 1) === 1) c++;
  return c;
}

export const inNet = (ip: Ipv4Addr, prefix: Ipv4Addr, plen: number): boolean =>
  networkOf(ip, plen) === prefix;

// ------------------------------------------------------------------ Schnittstellen

/** Bandbreite einer Schnittstelle in kbit/s. */
export function ifaceBwKbps(rt: Rt, i: Iface): number {
  if (i.cfg.bandwidth) return i.cfg.bandwidth;
  if (i.kind === 'loop') return 8_000_000;
  if (i.kind === 'tunnel') return 100;
  if (i.kind === 'svi') return 1_000_000;
  const p = rt.dev.ports.find((x) => x.id === i.portId);
  return (p?.operSpeed ?? 100) * 1000;
}

/** EIGRP-Delay in Einheiten von 10 µs (FastEthernet 100 µs = 10, GigabitEthernet 10 µs = 1). */
export function ifaceDelay(rt: Rt, i: Iface): number {
  if (i.cfg.delay !== undefined) return i.cfg.delay;
  if (i.kind === 'loop') return 500;
  if (i.kind === 'tunnel') return 5000;
  const bw = ifaceBwKbps(rt, i);
  return bw <= 10_000 ? 100 : bw <= 100_000 ? 10 : 1;
}

export const ifaceById = (rt: Rt, id: string): Iface | undefined =>
  rt.node.ifaces.find((i) => i.id === id);

/** Multi-Access-Schnittstelle (Ethernet), keine Loopback/Tunnel. */
export const isBroadcastIface = (i: Iface): boolean => i.kind !== 'loop' && i.kind !== 'tunnel';

// ------------------------------------------------------------------ Senden

export function sendMcast(
  rt: Rt,
  iface: Iface,
  group: Ipv4Addr,
  payload: IpPayload,
  srcMac?: string,
): void {
  if (iface.kind === 'loop') return;
  const pkt = newIpPacket(rt.node, iface.ip, group, payload, { ttl: 1 });
  rt.node.xmit(rt.ctx, iface, eth(srcMac ?? iface.mac, multicastMacV4(group), pkt));
}

/** Unicast an einen direkt angeschlossenen Nachbarn (ARP, TTL 1). */
export function sendNbr(rt: Rt, iface: Iface, dst: Ipv4Addr, payload: IpPayload, ttl = 1): void {
  if (isMulticastIpv4(dst)) return sendMcast(rt, iface, dst, payload);
  const pkt = newIpPacket(rt.node, iface.ip, dst, payload, { ttl });
  ipSendVia(rt.ctx, rt.node, { nextHop: dst, iface }, pkt);
}

/** Geroutetes Unicast-Paket (BGP-Multihop, GRE). */
export function sendRouted(
  rt: Rt,
  src: Ipv4Addr,
  dst: Ipv4Addr,
  payload: IpPayload,
  ttl?: number,
): boolean {
  const pkt = newIpPacket(rt.node, src, dst, payload, ttl !== undefined ? { ttl } : {});
  return ipSend(rt.ctx, rt.node, pkt).ok;
}

// ------------------------------------------------------------------ Timer

/** Hintergrund-Timer (zählen nicht als „Vordergrundarbeit“). */
export const setBg = (rt: Rt, name: string, delayUs: number, repeatUs?: number): void =>
  rt.ctx.setTimer(`bg:${name}`, delayUs, repeatUs);
export const cancelBg = (rt: Rt, name: string): void => rt.ctx.cancelTimer(`bg:${name}`);

export const SEC = 1_000_000;

// ------------------------------------------------------------------ Logging

export function rlog(
  rt: Rt,
  proto: ProtoTag,
  msg: Msg,
  opts: {
    kind?: 'rx' | 'info' | 'error' | 'drop';
    status?: 'ok' | 'info' | 'error' | 'drop';
    debug?: { tag: string; text: () => string };
  } = {},
): void {
  const dbg = opts.debug && rt.r.debug.includes(opts.debug.tag) ? opts.debug : undefined;
  rt.ctx.log({
    kind: opts.kind ?? 'info',
    proto,
    status: opts.status ?? 'info',
    msg,
    debug: dbg ? { tag: dbg.tag, text: dbg.text() } : undefined,
  });
}

/** Nur Debug-Zeile (kein Event-Eintrag), wenn der Schalter aktiv ist. */
export function dbg(rt: Rt, proto: ProtoTag, tag: string, text: () => string): void {
  if (!rt.r.debug.includes(tag)) return;
  rt.ctx.log({
    kind: 'info',
    proto,
    status: 'info',
    msg: { key: 'rt.debug' },
    debug: { tag, text: text() },
  });
}

// ------------------------------------------------------------------ Routen

export const AD = {
  connected: 0,
  static: 1,
  ebgp: 20,
  eigrp: 90,
  eigrpExt: 170,
  ospf: 110,
  rip: 120,
  ibgp: 200,
} as const;

/** Ersetzt alle Routen einer Quelle; liefert `true` bei Änderung. */
export function installRoutes(rt: Rt, src: string, routes: Omit<DynRoute, 'src'>[]): boolean {
  const key = (r: Omit<DynRoute, 'src'>): string =>
    `${r.proto}${r.sub ?? ''}|${r.prefix}/${r.plen}|${r.nextHop ?? ''}|${r.ifaceId}|${r.metric}|${r.ad}`;
  const old = rt.cfg.dynRoutes.filter((r) => r.src === src);
  const same =
    old.length === routes.length &&
    old.map(key).sort().join(';') === routes.map(key).sort().join(';');
  if (same) return false;
  const oldSince = new Map(old.map((r) => [`${r.prefix}/${r.plen}|${r.nextHop ?? ''}`, r.since]));
  rt.cfg.dynRoutes = [
    ...rt.cfg.dynRoutes.filter((r) => r.src !== src),
    ...routes.map((r) => ({
      ...r,
      src,
      since: oldSince.get(`${r.prefix}/${r.plen}|${r.nextHop ?? ''}`) ?? rt.ctx.now,
    })),
  ];
  return true;
}

export function ribOf(rt: Rt): RibEntry[] {
  return buildRib(rt.cfg, rt.node.ifaces);
}

export interface RedistRoute {
  prefix: Ipv4Addr;
  plen: number;
  metric: number;
  nextHop?: Ipv4Addr;
  ifaceId?: string;
  tag?: number;
}

/** Routen, die laut `redistribute`-Eintrag in ein anderes Protokoll übernommen werden. */
export function redistSource(rt: Rt, red: RedistCfg, self: string): RedistRoute[] {
  const rib = ribOf(rt);
  const out: RedistRoute[] = [];
  for (const e of rib) {
    if (e.type === 'L') continue;
    if (e.src === self) continue;
    let ok = false;
    if (red.source === 'connected') ok = e.type === 'C';
    else if (red.source === 'static') ok = e.type === 'S';
    else {
      const t = { rip: 'R', ospf: 'O', eigrp: 'D', bgp: 'B' }[red.source];
      ok =
        e.type === t &&
        (red.id === undefined || e.src === `${red.source}:${red.id}` || e.src === red.source);
    }
    if (!ok) continue;
    // Default-Route nur über default-information originate
    out.push({
      prefix: e.prefix,
      plen: e.plen,
      metric: e.metric,
      nextHop: e.nextHop,
      ifaceId: e.ifaceId,
    });
  }
  return out;
}
