import {
  ETHERTYPE,
  IP_PROTO,
  ALL_NODES_V6,
  ALL_ROUTERS_V6,
  ipv6Network,
  isLinkLocalIpv6,
  isMulticastIpv6,
  linkLocalFromMac,
  multicastMacV6,
  normalizeIpv6,
  pduSize,
  sameIpv6Prefix,
  slaacAddress,
  solicitedNode,
  summarizeFrame,
  type Frame,
  type Icmp6Pdu,
  type Ip6Payload,
  type Ipv6Addr,
  type Ipv6Pdu,
  type Mac,
} from '@netsim/protocols';
import type { DeviceCtx } from './ctx';
import { failPing } from './diag';
import { ifaceUp, isVirtualIface } from './ifaces';
import type { Base } from './l3';
import type { RibEntry } from './rib';
import { routingRx6 } from './routing';
import type {
  Device,
  HostConfig,
  IfaceCfg,
  IpCore,
  L3Cfg,
  PingResult,
  PingSession,
  V6Addr,
} from './types';

export const ND_RETRY_US = 1_000_000;
export const ND_MAX_ATTEMPTS = 3;
export const ND_TTL_US = 300_000_000;
const RA_INTERVAL_US = 200_000_000;

/** Laufzeitsicht einer IPv6-fähigen Schnittstelle. */
export interface Iface6 {
  id: string;
  kind: IfaceCfg['kind'];
  portId: string;
  vlan?: number;
  mac: Mac;
  ll: Ipv6Addr;
  /** Globale/ULA-Adressen (inkl. SLAAC und EUI-64). */
  addrs: V6Addr[];
  mtu: number;
  cfg: IfaceCfg;
}

export interface NextHop6 {
  nextHop: Ipv6Addr;
  iface: Iface6;
}

export interface Node6 {
  ifaces: Iface6[];
  forwarding: boolean;
  hopLimit: number;
  rib: RibEntry[];
  lookup(dst: Ipv6Addr): NextHop6 | undefined;
}

export type SendResult6 = { ok: true } | { ok: false; reason: 'noRoute' | 'tooBig' };

// ------------------------------------------------------------------ Schnittstellen

const effective = (a: V6Addr, mac: Mac): V6Addr =>
  a.eui64 ? { addr: slaacAddress(a.addr, mac), plen: a.plen } : a;

export function listIfaces6(
  dev: Device,
  cfg: L3Cfg,
  tunnelOk: (c: IfaceCfg) => boolean = () => true,
): Iface6[] {
  const out: Iface6[] = [];
  const baseMac = dev.ports[0]?.mac ?? '';
  for (const [id, c] of Object.entries(cfg.ifaces)) {
    const v6 = c.v6;
    if (!v6 || !(v6.enabled || v6.addrs.length > 0 || v6.autoconfig || v6.slaac.length > 0))
      continue;
    if (!ifaceUp(dev, cfg, id, c)) continue;
    if (c.kind === 'tunnel' && !tunnelOk(c)) continue;
    const port = dev.ports.find((p) => p.id === c.portId);
    const virtual = isVirtualIface(c.kind);
    const mac = virtual ? baseMac : (port?.mac ?? baseMac);
    if (!virtual && !port) continue;
    // Eindeutige Link-Local je Schnittstelle: MAC des Ports (virtuelle: Basis-MAC + Kennung)
    const ll = linkLocalFromMac(virtual ? macWithTag(baseMac, id) : mac);
    out.push({
      id,
      kind: c.kind,
      portId: virtual ? '' : (port?.id ?? ''),
      vlan: c.kind === 'sub' || c.kind === 'svi' ? c.vlan : undefined,
      mac,
      ll,
      addrs: [...v6.addrs.map((a) => effective(a, mac)), ...v6.slaac],
      mtu: c.kind === 'tunnel' ? 1476 : (port?.mtu ?? 1500),
      cfg: c,
    });
  }
  return out;
}

/** Unterscheidet Link-Local-Adressen virtueller Schnittstellen (SVI, Loopback, Tunnel) derselben Basis-MAC. */
function macWithTag(mac: Mac, id: string): Mac {
  const parts = mac.split(':');
  const tag = [...id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) & 0xff, 7);
  parts[5] = ((parseInt(parts[5] ?? '0', 16) ^ tag) & 0xff).toString(16).padStart(2, '0');
  return parts.join(':');
}

export function hostIfaces6(dev: Device, cfg: HostConfig): Iface6[] {
  const port = dev.ports[0];
  if (!port || !cfg.v6.enabled) return [];
  return [
    {
      id: port.id,
      kind: 'phys',
      portId: port.id,
      mac: port.mac,
      ll: linkLocalFromMac(port.mac),
      addrs: [...cfg.v6.addrs, ...cfg.v6.slaac],
      mtu: port.mtu,
      cfg: { kind: 'phys', portId: port.id },
    },
  ];
}

// ------------------------------------------------------------------ Routing-Tabelle

export function buildRib6(cfg: L3Cfg, ifaces: Iface6[]): RibEntry[] {
  const rib: RibEntry[] = [];
  for (const i of ifaces) {
    for (const a of i.addrs) {
      rib.push({
        type: 'C',
        prefix: ipv6Network(a.addr, a.plen),
        plen: a.plen,
        ad: 0,
        metric: 0,
        ifaceId: i.id,
      });
      rib.push({ type: 'L', prefix: a.addr, plen: 128, ad: 0, metric: 0, ifaceId: i.id });
    }
    rib.push({ type: 'L', prefix: i.ll, plen: 128, ad: 0, metric: 0, ifaceId: i.id });
  }
  const connected = rib.filter((e) => e.type === 'C');
  for (const r of cfg.staticRoutes6) {
    const base = {
      type: 'S' as const,
      prefix: ipv6Network(r.prefix, r.plen),
      plen: r.plen,
      ad: r.ad,
      metric: 0,
    };
    if (r.outIfaceId) {
      if (ifaces.some((i) => i.id === r.outIfaceId))
        rib.push({ ...base, nextHop: r.nextHop, ifaceId: r.outIfaceId });
    } else if (r.nextHop) {
      const via = connected
        .filter((c) => sameIpv6Prefix(c.prefix, r.nextHop as string, c.plen))
        .sort((a, b) => b.plen - a.plen)[0];
      if (via) rib.push({ ...base, nextHop: r.nextHop, ifaceId: via.ifaceId });
    }
  }
  for (const d of cfg.dynRoutes6) {
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

export function lookupRib6(rib: RibEntry[], dst: Ipv6Addr): RibEntry | undefined {
  let best: RibEntry | undefined;
  for (const e of rib) {
    if (e.type === 'L' || ipv6Network(dst, e.plen) !== e.prefix) continue;
    if (
      !best ||
      e.plen > best.plen ||
      (e.plen === best.plen && (e.ad < best.ad || (e.ad === best.ad && e.metric < best.metric)))
    )
      best = e;
  }
  return best;
}

export function routerNode6(ifaces: Iface6[], cfg: L3Cfg): Node6 {
  const rib = buildRib6(cfg, ifaces);
  const forwarding = cfg.ipv6Routing;
  return {
    ifaces,
    forwarding,
    hopLimit: 255,
    rib,
    lookup(dst) {
      if (isLinkLocalIpv6(dst) || isMulticastIpv6(dst)) {
        const i = ifaces[0];
        return i ? { nextHop: dst, iface: i } : undefined;
      }
      const e = lookupRib6(rib, dst);
      const iface = e?.ifaceId ? ifaces.find((i) => i.id === e.ifaceId) : undefined;
      if (!e || !iface) return undefined;
      return { nextHop: e.type === 'C' || !e.nextHop ? dst : e.nextHop, iface };
    },
  };
}

export function hostNode6(ifaces: Iface6[], cfg: HostConfig, now: number): Node6 {
  const iface = ifaces[0];
  return {
    ifaces,
    forwarding: false,
    hopLimit: 64,
    rib: [],
    lookup(dst) {
      if (!iface) return undefined;
      if (isLinkLocalIpv6(dst) || isMulticastIpv6(dst)) return { nextHop: dst, iface };
      if (iface.addrs.some((a) => sameIpv6Prefix(a.addr, dst, a.plen)))
        return { nextHop: dst, iface };
      const gw =
        cfg.v6.gateway ??
        (cfg.v6.raGateway && cfg.v6.raGateway.expiresAt > now ? cfg.v6.raGateway.addr : undefined);
      return gw ? { nextHop: gw, iface } : undefined;
    },
  };
}

// ------------------------------------------------------------------ Adressen / Pakete

export const eth6 = (src: Mac, dst: Mac, pkt: Ipv6Pdu): Frame => ({
  kind: 'ethernet',
  src,
  dst,
  etherType: ETHERTYPE.ipv6,
  payload: pkt,
});

function nextHeaderOf(p: Ip6Payload): number {
  switch (p.kind) {
    case 'icmp6':
      return IP_PROTO.icmp6;
    case 'tcp':
      return IP_PROTO.tcp;
    case 'udp':
      return IP_PROTO.udp;
    case 'gre':
      return IP_PROTO.gre;
    case 'routing':
      return p.proto === 'ospf'
        ? IP_PROTO.ospf
        : p.proto === 'eigrp'
          ? IP_PROTO.eigrp
          : IP_PROTO.tcp;
  }
}

export function newIp6(
  node: Node6,
  src: Ipv6Addr,
  dst: Ipv6Addr,
  payload: Ip6Payload,
  hopLimit?: number,
): Ipv6Pdu {
  return {
    kind: 'ipv6',
    src,
    dst,
    hopLimit: hopLimit ?? node.hopLimit,
    nextHeader: nextHeaderOf(payload),
    payload,
  };
}

const eqAddr = (a: Ipv6Addr, b: Ipv6Addr): boolean =>
  (normalizeIpv6(a) ?? a) === (normalizeIpv6(b) ?? b);

export function isLocal6(node: Node6, ip: Ipv6Addr): boolean {
  return node.ifaces.some((i) => eqAddr(i.ll, ip) || i.addrs.some((a) => eqAddr(a.addr, ip)));
}

/** Absenderadresse passend zum Ziel: Link-Local für Link-Local-/Multicast-Ziele, sonst erste globale Adresse. */
export function srcFor6(iface: Iface6, dst: Ipv6Addr): Ipv6Addr {
  if (isLinkLocalIpv6(dst) || isMulticastIpv6(dst)) return iface.ll;
  const same = iface.addrs.find((a) => sameIpv6Prefix(a.addr, dst, a.plen));
  return (same ?? iface.addrs[0])?.addr ?? iface.ll;
}

const isVirtualP2p = (i: Pick<Iface6, 'kind'>): boolean => i.kind === 'tunnel' || i.kind === 'loop';

// ------------------------------------------------------------------ Senden

export interface Ip6Host {
  dev?: Device;
  cfg: IpCore;
  v6: Node6;
  host?: HostConfig;
  xmit(ctx: DeviceCtx, iface: Iface6, frame: Frame): void;
}

function emit6(ctx: DeviceCtx, n: Ip6Host, hop: NextHop6, pkt: Ipv6Pdu): void {
  if (isVirtualP2p(hop.iface)) {
    n.xmit(ctx, hop.iface, eth6(hop.iface.mac, hop.iface.mac, pkt));
    return;
  }
  if (isMulticastIpv6(hop.nextHop)) {
    n.xmit(ctx, hop.iface, eth6(hop.iface.mac, multicastMacV6(hop.nextHop), pkt));
    return;
  }
  const key = normalizeIpv6(hop.nextHop) ?? hop.nextHop;
  const entry = n.cfg.nd[key];
  if (entry && entry.expiresAt > ctx.now) {
    n.xmit(ctx, hop.iface, eth6(hop.iface.mac, entry.mac, pkt));
    return;
  }
  let pend = n.cfg.ndPending[key];
  if (!pend) {
    pend = { attempts: 1, ifaceId: hop.iface.id, queue: [] };
    n.cfg.ndPending[key] = pend;
    sendNs(ctx, n, hop.iface, key);
    ctx.setTimer(`nd:${key}`, ND_RETRY_US);
  }
  pend.queue.push(pkt);
}

export function ip6SendVia(ctx: DeviceCtx, n: Ip6Host, hop: NextHop6, pkt: Ipv6Pdu): SendResult6 {
  if (pduSize(pkt) > hop.iface.mtu) return { ok: false, reason: 'tooBig' };
  emit6(ctx, n, hop, pkt);
  return { ok: true };
}

export function ip6Send(ctx: DeviceCtx, n: Ip6Host, pkt: Ipv6Pdu): SendResult6 {
  const hop = n.v6.lookup(pkt.dst);
  if (!hop) return { ok: false, reason: 'noRoute' };
  return ip6SendVia(ctx, n, hop, pkt);
}

/** Multicast (z. B. `ff02::5`) aus einer Schnittstelle, Hop Limit 1. */
export function sendMcast6(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  group: Ipv6Addr,
  payload: Ip6Payload,
): void {
  const pkt = newIp6(n.v6, iface.ll, group, payload, 1);
  n.xmit(ctx, iface, eth6(iface.mac, multicastMacV6(group), pkt));
}

/** Unicast an einen Nachbarn auf einer Schnittstelle (ND, Hop Limit 1). */
export function sendNbr6(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  dst: Ipv6Addr,
  payload: Ip6Payload,
): void {
  if (isMulticastIpv6(dst)) return sendMcast6(ctx, n, iface, dst, payload);
  const pkt = newIp6(n.v6, iface.ll, dst, payload, 1);
  ip6SendVia(ctx, n, { nextHop: dst, iface }, pkt);
}

function icmp6(type: Icmp6Pdu['type'], extra: Partial<Icmp6Pdu> = {}): Icmp6Pdu {
  return { kind: 'icmp6', type, code: 0, id: 0, seq: 0, dataSize: 0, ...extra };
}

function sendNs(ctx: DeviceCtx, n: Ip6Host, iface: Iface6, target: Ipv6Addr): void {
  const dst = solicitedNode(target);
  const pkt = newIp6(
    n.v6,
    srcFor6(iface, target),
    dst,
    icmp6('ns', { target, lladdr: iface.mac }),
    255,
  );
  n.xmit(ctx, iface, eth6(iface.mac, multicastMacV6(dst), pkt));
}

// ------------------------------------------------------------------ Empfang

export function ip6FrameRx(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  frame: Frame,
  fromId: string,
  port?: ReturnType<DeviceCtx['port']>,
): void {
  const pkt = frame.payload;
  if (pkt.kind !== 'ipv6') return;
  const { proto, info } = summarizeFrame(frame);
  const base: Base = { from: fromId, port, frame, summary: info, proto };
  if (frame.dst !== iface.mac && !isMulticastMacAddr(frame.dst)) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.l2.notForMe', params: { dst: frame.dst, mac: iface.mac } },
    });
    return;
  }
  const dst = pkt.dst;
  const mine = isLocal6(n.v6, dst) || isLocalMulticast6(n, iface, dst);
  if (mine) return deliverLocal6(ctx, n, iface, base, pkt, frame);
  if (isMulticastIpv6(dst)) return;
  if (!n.v6.forwarding) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'ip6.notMine', params: { dst } },
    });
    return;
  }
  forward6(ctx, n, iface, base, pkt);
}

const isMulticastMacAddr = (m: Mac): boolean => (parseInt(m.slice(0, 2), 16) & 1) === 1;

/** Eigene Multicast-Gruppen: all-nodes, all-routers (Router), Solicited-Node, Routing-Gruppen. */
function isLocalMulticast6(n: Ip6Host, iface: Iface6, dst: Ipv6Addr): boolean {
  if (!isMulticastIpv6(dst)) return false;
  const d = normalizeIpv6(dst) ?? dst;
  if (d === ALL_NODES_V6) return true;
  if (d === ALL_ROUTERS_V6) return n.v6.forwarding;
  if (d === 'ff02::5' || d === 'ff02::6') return n.v6.forwarding;
  const sn = (a: Ipv6Addr): boolean => (normalizeIpv6(solicitedNode(a)) ?? '') === d;
  return sn(iface.ll) || iface.addrs.some((a) => sn(a.addr));
}

function learn6(ctx: DeviceCtx, n: Ip6Host, ip: Ipv6Addr, mac: Mac): void {
  n.cfg.nd[normalizeIpv6(ip) ?? ip] = { mac, expiresAt: ctx.now + ND_TTL_US };
}

function flushPending(ctx: DeviceCtx, n: Ip6Host, ip: Ipv6Addr, mac: Mac): void {
  const key = normalizeIpv6(ip) ?? ip;
  const pend = n.cfg.ndPending[key];
  if (!pend) return;
  delete n.cfg.ndPending[key];
  ctx.cancelTimer(`nd:${key}`);
  const iface = n.v6.ifaces.find((i) => i.id === pend.ifaceId);
  if (!iface) return;
  for (const pkt of pend.queue) n.xmit(ctx, iface, eth6(iface.mac, mac, pkt));
}

function deliverLocal6(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  base: Base,
  pkt: Ipv6Pdu,
  frame: Frame,
): void {
  const p = pkt.payload;
  if (p.kind === 'routing' || p.kind === 'gre') {
    routingRx6(ctx, n, iface, base, pkt);
    return;
  }
  if (p.kind !== 'icmp6') {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: {
        key: 'ip.noService',
        params: { port: p.kind === 'udp' || p.kind === 'tcp' ? p.dstPort : 0 },
      },
    });
    return;
  }
  switch (p.type) {
    case 'ns':
      return rxNs(ctx, n, iface, base, pkt, p, frame);
    case 'na':
      return rxNa(ctx, n, base, pkt, p, frame);
    case 'rs':
      return rxRs(ctx, n, iface, base, pkt, p);
    case 'ra':
      return rxRa(ctx, n, iface, base, pkt, p);
    case 'echo-request': {
      if (frame.src && !isMulticastIpv6(pkt.src)) learn6(ctx, n, pkt.src, frame.src);
      ctx.log({
        ...base,
        kind: 'rx',
        status: 'ok',
        msg: { key: 'ip6.echoRequest', params: { src: pkt.src, size: pduSize(pkt) } },
      });
      if (isMulticastIpv6(pkt.dst)) return;
      const reply = newIp6(n.v6, pkt.dst, pkt.src, { ...p, type: 'echo-reply' });
      const hop = isLinkLocalIpv6(pkt.src) ? { nextHop: pkt.src, iface } : n.v6.lookup(pkt.src);
      if (hop) ip6SendVia(ctx, n, hop, reply);
      return;
    }
    case 'echo-reply':
      ctx.log({
        ...base,
        kind: 'rx',
        status: 'ok',
        msg: { key: 'ip6.echoReply', params: { src: pkt.src, size: pduSize(pkt) } },
      });
      onEchoReply6(ctx, n, pkt, p);
      return;
    default:
      ctx.log({
        ...base,
        kind: 'rx',
        status: 'info',
        msg: { key: 'host.icmp.error', params: { src: pkt.src, type: p.type, code: p.code } },
      });
      onIcmp6Error(ctx, n, pkt, p);
  }
}

function rxNs(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  base: Base,
  pkt: Ipv6Pdu,
  p: Icmp6Pdu,
  frame: Frame,
): void {
  const target = p.target;
  if (!target || pkt.hopLimit !== 255) return;
  const mine = eqAddr(iface.ll, target) || iface.addrs.some((a) => eqAddr(a.addr, target));
  if (!mine) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.arp.notMine', params: { ip: target } },
    });
    return;
  }
  const unspecified = pkt.src === '::';
  if (!unspecified) learn6(ctx, n, pkt.src, p.lladdr ?? frame.src);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'nd.ns', params: { target, sender: pkt.src } },
  });
  if (unspecified) return;
  const na = newIp6(
    n.v6,
    target,
    pkt.src,
    icmp6('na', {
      target,
      lladdr: iface.mac,
      naFlags: { router: n.v6.forwarding, solicited: true, override: true },
    }),
    255,
  );
  n.xmit(ctx, iface, eth6(iface.mac, p.lladdr ?? frame.src, na));
}

function rxNa(
  ctx: DeviceCtx,
  n: Ip6Host,
  base: Base,
  pkt: Ipv6Pdu,
  p: Icmp6Pdu,
  frame: Frame,
): void {
  const target = p.target;
  if (!target) return;
  const mac = p.lladdr ?? frame.src;
  learn6(ctx, n, target, mac);
  ctx.log({ ...base, kind: 'rx', status: 'ok', msg: { key: 'nd.na', params: { target, mac } } });
  flushPending(ctx, n, target, mac);
  void pkt;
}

// ------------------------------------------------------------------ Router Advertisement / SLAAC

function rxRs(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  base: Base,
  pkt: Ipv6Pdu,
  p: Icmp6Pdu,
): void {
  if (!n.v6.forwarding) return;
  if (p.lladdr && pkt.src !== '::') learn6(ctx, n, pkt.src, p.lladdr);
  ctx.log({ ...base, kind: 'rx', status: 'ok', msg: { key: 'nd.rs', params: { src: pkt.src } } });
  sendRa(ctx, n, iface);
}

function rxRa(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  base: Base,
  pkt: Ipv6Pdu,
  p: Icmp6Pdu,
): void {
  const host = n.host;
  if (!host || !host.v6.autoconfig) return;
  if (p.lladdr) learn6(ctx, n, pkt.src, p.lladdr);
  ctx.log({ ...base, kind: 'rx', status: 'ok', msg: { key: 'nd.ra', params: { src: pkt.src } } });
  for (const pf of p.prefixes ?? []) {
    if (!pf.autonomous || pf.plen !== 64) continue;
    const addr = slaacAddress(pf.prefix, iface.mac);
    if (!host.v6.slaac.some((a) => a.addr === addr)) {
      host.v6.slaac.push({ addr, plen: 64 });
      ctx.log({
        kind: 'info',
        proto: 'ND',
        status: 'ok',
        msg: { key: 'nd.slaac', params: { addr } },
      });
    }
  }
  if ((p.routerLifetime ?? 0) > 0)
    host.v6.raGateway = {
      addr: pkt.src,
      expiresAt: ctx.now + (p.routerLifetime as number) * 1_000_000,
    };
  ctx.cancelTimer('rs');
}

export function sendRa(ctx: DeviceCtx, n: Ip6Host, iface: Iface6): void {
  if (
    !n.v6.forwarding ||
    iface.cfg.v6?.raSuppress ||
    iface.kind === 'loop' ||
    iface.kind === 'tunnel'
  )
    return;
  const prefixes = [
    ...new Map(
      iface.addrs.map((a) => [`${ipv6Network(a.addr, a.plen)}/${a.plen}`, a] as const),
    ).values(),
  ].map((a) => ({
    prefix: ipv6Network(a.addr, a.plen),
    plen: a.plen,
    onLink: true,
    autonomous: a.plen === 64,
  }));
  if (prefixes.length === 0) return;
  const pkt = newIp6(
    n.v6,
    iface.ll,
    ALL_NODES_V6,
    icmp6('ra', { lladdr: iface.mac, prefixes, routerLifetime: 1800 }),
    255,
  );
  n.xmit(ctx, iface, eth6(iface.mac, multicastMacV6(ALL_NODES_V6), pkt));
}

export function sendRs(ctx: DeviceCtx, n: Ip6Host, iface: Iface6): void {
  const pkt = newIp6(n.v6, iface.ll, ALL_ROUTERS_V6, icmp6('rs', { lladdr: iface.mac }), 255);
  n.xmit(ctx, iface, eth6(iface.mac, multicastMacV6(ALL_ROUTERS_V6), pkt));
}

/** Router: RA-Timer je Schnittstelle armieren/entfernen. */
export function syncRa(ctx: DeviceCtx, cfg: L3Cfg, ifaces: Iface6[]): void {
  const want = cfg.ipv6Routing
    ? ifaces
        .filter(
          (i) =>
            i.addrs.length > 0 && i.kind !== 'loop' && i.kind !== 'tunnel' && !i.cfg.v6?.raSuppress,
        )
        .map((i) => i.id)
    : [];
  for (const id of [...cfg.raIfs]) {
    if (!want.includes(id)) {
      ctx.cancelTimer(`bg:ra:${id}`);
      cfg.raIfs = cfg.raIfs.filter((x) => x !== id);
    }
  }
  for (const id of want) {
    if (cfg.raIfs.includes(id)) continue;
    cfg.raIfs.push(id);
    ctx.setTimer(`bg:ra:${id}`, 500_000 + ctx.rand(2_000_000), RA_INTERVAL_US);
  }
}

/** Host: Router Solicitation senden (mit Wiederholung), solange SLAAC aktiv und kein Router bekannt ist. */
export function hostV6Start(ctx: DeviceCtx, cfg: HostConfig): void {
  if (cfg.v6.autoconfig && cfg.v6.enabled) {
    cfg.v6.rsSent = 0;
    ctx.setTimer('rs', 500_000 + ctx.rand(500_000));
  }
}

// ------------------------------------------------------------------ Weiterleiten

function forward6(ctx: DeviceCtx, n: Ip6Host, ifaceIn: Iface6, base: Base, pkt: Ipv6Pdu): void {
  if (isLinkLocalIpv6(pkt.dst)) return;
  if (pkt.hopLimit <= 1) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'router.ttlExpired', params: { dst: pkt.dst } },
    });
    sendIcmp6Error(ctx, n, 'time-exceeded', 0, pkt, srcFor6(ifaceIn, pkt.src));
    return;
  }
  const hop = n.v6.lookup(pkt.dst);
  if (!hop) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'router.noRoute', params: { dst: pkt.dst } },
    });
    sendIcmp6Error(ctx, n, 'dest-unreachable', 0, pkt, srcFor6(ifaceIn, pkt.src));
    return;
  }
  const out: Ipv6Pdu = { ...structuredClone(pkt), hopLimit: pkt.hopLimit - 1 };
  const r = ip6SendVia(ctx, n, hop, out);
  if (!r.ok) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: {
        key: 'router.needFrag',
        params: { size: pduSize(out), mtu: hop.iface.mtu, port: ctx.deviceIfaceName(hop.iface.id) },
      },
    });
    return;
  }
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: {
      key: 'router.forward',
      params: {
        dst: pkt.dst,
        via: hop.nextHop,
        port: ctx.deviceIfaceName(hop.iface.id),
        ttl: out.hopLimit,
      },
    },
  });
}

export function sendIcmp6Error(
  ctx: DeviceCtx,
  n: Ip6Host,
  type: 'dest-unreachable' | 'time-exceeded',
  code: number,
  off: Ipv6Pdu,
  srcIp: Ipv6Addr,
): void {
  const p = off.payload;
  if (p.kind === 'icmp6' && (p.type === 'dest-unreachable' || p.type === 'time-exceeded')) return;
  if (isMulticastIpv6(off.dst) || off.src === '::') return;
  const err = icmp6(type, {
    code,
    id: p.kind === 'icmp6' ? p.id : 0,
    seq: p.kind === 'icmp6' ? p.seq : 0,
    dataSize: 40,
    orig: { src: off.src, dst: off.dst },
  });
  ip6Send(ctx, n, newIp6(n.v6, srcIp, off.src, err, 255));
}

// ------------------------------------------------------------------ Ping

/** Wird von `diag.startPing` aufgerufen (IPv6-Ziel). */
export function sendPing6(
  ctx: DeviceCtx,
  n: Ip6Host,
  s: PingSession,
  res: PingResult,
  seq: number,
): void {
  const hop = n.v6.lookup(s.dst);
  if (!hop) return failPing(ctx, res, 'ping.noRoute', s.dst, undefined);
  const src = srcFor6(hop.iface, s.dst);
  ctx.setTimer(`ping-timeout:${s.id}:${seq}`, s.timeoutUs);
  const pkt = newIp6(
    n.v6,
    src,
    s.dst,
    icmp6('echo-request', { id: s.id, seq, dataSize: s.dataSize }),
  );
  // Eigene Adresse: lokal zustellen
  if (isLocal6(n.v6, s.dst)) {
    const body = pkt.payload as Icmp6Pdu;
    onEchoReply6(ctx, n, { ...pkt, src: s.dst, dst: src }, { ...body, type: 'echo-reply' });
    return;
  }
  const r = ip6Send(ctx, n, pkt);
  if (!r.ok) {
    ctx.cancelTimer(`ping-timeout:${s.id}:${seq}`);
    failPing(
      ctx,
      res,
      r.reason === 'tooBig' ? 'ping.fragNeeded' : 'ping.noRoute',
      s.dst,
      hop.iface.ll,
    );
  }
}

function onEchoReply6(ctx: DeviceCtx, n: Ip6Host, pkt: Ipv6Pdu, p: Icmp6Pdu): void {
  const res = n.cfg.pings.find((x) => x.id === p.id && x.seq === p.seq);
  if (!res || res.status !== 'pending') return;
  res.status = 'reply';
  res.rttUs = ctx.now - res.sentAt;
  res.from = pkt.src;
  res.ttl = pkt.hopLimit;
  res.bytes = p.dataSize;
  ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
  ctx.log({
    kind: 'ping',
    proto: 'ICMP6',
    status: 'ok',
    msg: {
      key: 'ping.reply',
      params: { ip: pkt.src, bytes: p.dataSize, rttUs: res.rttUs, ttl: pkt.hopLimit, seq: p.seq },
    },
  });
}

function onIcmp6Error(ctx: DeviceCtx, n: Ip6Host, pkt: Ipv6Pdu, p: Icmp6Pdu): void {
  const res = n.cfg.pings.find((x) => x.id === p.id && x.seq === p.seq);
  if (!res || res.status !== 'pending') return;
  ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
  const note =
    p.type === 'time-exceeded'
      ? 'ping.ttlExpired'
      : p.code === 3
        ? 'ping.hostUnreachable'
        : 'ping.netUnreachable';
  failPing(ctx, res, note, res.dst, pkt.src);
}

// ------------------------------------------------------------------ Timer

export function ip6Timer(ctx: DeviceCtx, n: Ip6Host, name: string): boolean {
  if (name.startsWith('nd:')) {
    const ip = name.slice(3);
    const pend = n.cfg.ndPending[ip];
    if (!pend) return true;
    const iface = n.v6.ifaces.find((i) => i.id === pend.ifaceId);
    if (pend.attempts >= ND_MAX_ATTEMPTS || !iface) {
      delete n.cfg.ndPending[ip];
      ctx.log({
        kind: 'error',
        proto: 'ND',
        status: 'error',
        msg: { key: 'nd.failed', params: { ip } },
      });
      for (const q of pend.queue) undeliverable6(ctx, n, q, iface);
      return true;
    }
    pend.attempts++;
    sendNs(ctx, n, iface, ip);
    ctx.setTimer(name, ND_RETRY_US);
    return true;
  }
  if (name.startsWith('ra:')) {
    const iface = n.v6.ifaces.find((i) => i.id === name.slice(3));
    if (iface) sendRa(ctx, n, iface);
    return true;
  }
  if (name === 'rs') {
    const host = n.host;
    const iface = n.v6.ifaces[0];
    if (!host || !iface || !host.v6.autoconfig) return true;
    if (host.v6.raGateway && host.v6.raGateway.expiresAt > ctx.now) return true;
    if (host.v6.rsSent >= 3) return true;
    host.v6.rsSent++;
    sendRs(ctx, n, iface);
    ctx.setTimer('rs', 4_000_000);
    return true;
  }
  return false;
}

function undeliverable6(ctx: DeviceCtx, n: Ip6Host, pkt: Ipv6Pdu, iface?: Iface6): void {
  if (isLocal6(n.v6, pkt.src)) {
    const p = pkt.payload;
    if (p.kind === 'icmp6') {
      const res = n.cfg.pings.find((x) => x.id === p.id && x.seq === p.seq);
      if (res) {
        ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
        failPing(ctx, res, 'ping.hostUnreachable', pkt.dst, iface?.ll);
      }
    }
    return;
  }
  const back = n.v6.lookup(pkt.src);
  if (back) sendIcmp6Error(ctx, n, 'dest-unreachable', 3, pkt, srcFor6(back.iface, pkt.src));
}
