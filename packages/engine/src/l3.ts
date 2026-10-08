import {
  BROADCAST_MAC,
  ETHERTYPE,
  ICMP_UNREACH,
  IP_PROTO,
  broadcastAddress,
  isBroadcastMac,
  isMulticastMac,
  pduSize,
  summarizeFrame,
  type AppPdu,
  type ArpPdu,
  type EthernetPdu,
  type Frame,
  type IcmpPdu,
  type IpPayload,
  type Ipv4Addr,
  type Ipv4Pdu,
  type ProtoTag,
} from '@netsim/protocols';
import { aclEval } from './acl';
import type { DeviceCtx } from './ctx';
import { onEchoReply, onIcmpError } from './diag';
import { dhcpRx } from './svc/dhcp';
import { dnsRx } from './svc/dns';
import type { Iface } from './ifaces';
import { natInside2Outside, natOutside2Inside } from './nat';
import { tcpRx } from './svc/tcp';
import type { Device, HostConfig, IpCore, L3Cfg, Port } from './types';

export const ARP_RETRY_US = 1_000_000;
export const ARP_MAX_ATTEMPTS = 3;
export const REASM_TIMEOUT_US = 15_000_000;

export interface NextHop {
  nextHop: Ipv4Addr;
  iface: Iface;
}

/** Sicht auf ein IP-fähiges Gerät (Host, Router, L3-Switch) für einen Verarbeitungsschritt. */
export interface IpNode {
  dev: Device;
  cfg: IpCore;
  /** Router/L3-Switch: ACL, NAT, DHCP-Server/Relay. */
  l3?: L3Cfg;
  /** Host: Dienste (DHCP-Client, DNS, TCP, HTTP). */
  host?: HostConfig;
  forwarding: boolean;
  arpTtlUs: number;
  defaultTtl: number;
  ifaces: Iface[];
  lookup(dst: Ipv4Addr): NextHop | undefined;
  /** Sendet einen fertigen Frame aus der Schnittstelle (Tag/SVI-Besonderheiten inklusive). */
  xmit(ctx: DeviceCtx, iface: Iface, frame: Frame): void;
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'noRoute' }
  | { ok: false; reason: 'needFrag'; mtu: number };

export type Base = {
  readonly from: string;
  readonly port?: Port;
  readonly frame: Frame;
  readonly summary: string;
  readonly proto: ProtoTag;
};

export function eth(src: string, dst: string, payload: ArpPdu | Ipv4Pdu): Frame {
  return {
    kind: 'ethernet',
    src,
    dst,
    etherType: payload.kind === 'arp' ? ETHERTYPE.arp : ETHERTYPE.ipv4,
    payload,
  };
}

const protoOf = (p: IpPayload): number =>
  p.kind === 'icmp' ? IP_PROTO.icmp : p.kind === 'tcp' ? IP_PROTO.tcp : IP_PROTO.udp;

export function newIpPacket(
  node: IpNode,
  src: Ipv4Addr,
  dst: Ipv4Addr,
  payload: IpPayload,
  opts: { ttl?: number; df?: boolean } = {},
): Ipv4Pdu {
  return {
    kind: 'ipv4',
    src,
    dst,
    ttl: opts.ttl ?? node.defaultTtl,
    protocol: protoOf(payload),
    id: node.cfg.nextIpId++,
    df: opts.df ?? false,
    mf: false,
    fragOffset: 0,
    payload,
  };
}

export const isLocalIp = (node: IpNode, ip: Ipv4Addr): boolean => node.ifaces.some((i) => i.ip === ip);

// ------------------------------------------------------------------ Senden

export function sendArpRequest(ctx: DeviceCtx, node: IpNode, iface: Iface, target: Ipv4Addr): void {
  const req: ArpPdu = {
    kind: 'arp',
    op: 'request',
    senderMac: iface.mac,
    senderIp: iface.ip,
    targetMac: '00:00:00:00:00:00',
    targetIp: target,
  };
  node.xmit(ctx, iface, eth(iface.mac, BROADCAST_MAC, req));
}

function emit(ctx: DeviceCtx, node: IpNode, hop: NextHop, pkt: Ipv4Pdu): void {
  const entry = node.cfg.arpCache[hop.nextHop];
  if (entry && entry.expiresAt > ctx.now) {
    node.xmit(ctx, hop.iface, eth(hop.iface.mac, entry.mac, pkt));
    return;
  }
  let pend = node.cfg.arpPending[hop.nextHop];
  if (!pend) {
    pend = { attempts: 1, ifaceId: hop.iface.id, queue: [] };
    node.cfg.arpPending[hop.nextHop] = pend;
    sendArpRequest(ctx, node, hop.iface, hop.nextHop);
    ctx.setTimer(`arp:${hop.nextHop}`, ARP_RETRY_US);
  }
  pend.queue.push(pkt);
}

export function fragment(pkt: Ipv4Pdu, mtu: number): Ipv4Pdu[] {
  const data = pkt.dataLen ?? pduSize(pkt.payload);
  const base = pkt.fragOffset * 8;
  const maxData = Math.floor((mtu - 20) / 8) * 8;
  const out: Ipv4Pdu[] = [];
  for (let off = 0; off < data; off += maxData) {
    const len = Math.min(maxData, data - off);
    const last = off + len >= data;
    out.push({
      ...structuredClone(pkt),
      fragOffset: (base + off) / 8,
      dataLen: len,
      mf: last ? pkt.mf : true,
    });
  }
  return out;
}

/** MTU-Prüfung/Fragmentierung und Auslieferung über einen bereits bestimmten Next-Hop. */
export function ipSendVia(ctx: DeviceCtx, node: IpNode, hop: NextHop, pkt: Ipv4Pdu): SendResult {
  const mtu = hop.iface.mtu;
  if (pduSize(pkt) <= mtu) {
    emit(ctx, node, hop, pkt);
    return { ok: true };
  }
  if (pkt.df) return { ok: false, reason: 'needFrag', mtu };
  const frags = fragment(pkt, mtu);
  ctx.log({
    kind: 'info',
    proto: 'ICMP',
    status: 'info',
    msg: {
      key: 'ip.fragment',
      params: { size: pduSize(pkt), mtu, count: frags.length, dst: pkt.dst },
    },
  });
  for (const f of frags) emit(ctx, node, hop, f);
  return { ok: true };
}

/** Routet ein lokal erzeugtes Paket: Lookup → MTU/Fragmentierung → ARP → Senden. */
export function ipSend(ctx: DeviceCtx, node: IpNode, pkt: Ipv4Pdu): SendResult {
  const hop = node.lookup(pkt.dst);
  if (!hop) return { ok: false, reason: 'noRoute' };
  return ipSendVia(ctx, node, hop, pkt);
}

/** Broadcast (255.255.255.255) aus einer Schnittstelle, ohne ARP. */
export function sendBroadcast(ctx: DeviceCtx, node: IpNode, iface: Iface, pkt: Ipv4Pdu): void {
  node.xmit(ctx, iface, eth(iface.mac, BROADCAST_MAC, pkt));
}

/** Unicast direkt an eine bekannte MAC (z. B. DHCP-Antwort an einen Client ohne IP). */
export function sendDirect(ctx: DeviceCtx, node: IpNode, iface: Iface, dstMac: string, pkt: Ipv4Pdu): void {
  node.xmit(ctx, iface, eth(iface.mac, dstMac, pkt));
}

export interface UdpSend {
  src?: Ipv4Addr;
  dst: Ipv4Addr;
  sport: number;
  dport: number;
  app?: AppPdu;
  dataSize?: number;
}

/** Sendet ein UDP-Datagramm per Routing (Quelle = Adresse der Ausgangsschnittstelle). */
export function sendUdp(ctx: DeviceCtx, node: IpNode, o: UdpSend): SendResult {
  const hop = node.lookup(o.dst);
  if (!hop) return { ok: false, reason: 'noRoute' };
  const pkt = newIpPacket(node, o.src ?? hop.iface.ip, o.dst, {
    kind: 'udp',
    srcPort: o.sport,
    dstPort: o.dport,
    dataSize: o.dataSize ?? 0,
    app: o.app,
  });
  return ipSendVia(ctx, node, hop, pkt);
}

/** ICMP-Fehlermeldung an den Absender von `off` (RFC 1812: nie als Antwort auf Fehler/Fragmente). */
export function sendIcmpError(
  ctx: DeviceCtx,
  node: IpNode,
  type: 'dest-unreachable' | 'time-exceeded',
  code: number,
  off: Ipv4Pdu,
  srcIp: Ipv4Addr,
  nextHopMtu?: number,
): void {
  const p = off.payload;
  if (p.kind === 'icmp' && (p.type === 'dest-unreachable' || p.type === 'time-exceeded')) return;
  if (off.fragOffset > 0) return;
  const icmp: IcmpPdu = {
    kind: 'icmp',
    type,
    code,
    id: 0,
    seq: 0,
    dataSize: 28,
    orig: {
      src: off.src,
      dst: off.dst,
      ipId: off.id,
      protocol: off.protocol,
      icmpId: p.kind === 'icmp' ? p.id : 0,
      icmpSeq: p.kind === 'icmp' ? p.seq : 0,
      sport: p.kind === 'tcp' || p.kind === 'udp' ? p.srcPort : undefined,
      dport: p.kind === 'tcp' || p.kind === 'udp' ? p.dstPort : undefined,
    },
    nextHopMtu,
  };
  const pkt = newIpPacket(node, srcIp, off.src, icmp, { ttl: node.forwarding ? 255 : node.defaultTtl });
  ipSend(ctx, node, pkt);
}

// ------------------------------------------------------------------ Empfang

/** Frame an einer bereits bestimmten Schnittstelle verarbeiten (ARP/IPv4). */
export function ifaceFrameRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  frame: Frame,
  fromId: string,
  port?: Port,
): void {
  const { proto, info } = summarizeFrame(frame);
  const base: Base = { from: fromId, port, frame, summary: info, proto };
  if (frame.dst !== iface.mac && !isBroadcastMac(frame.dst) && !isMulticastMac(frame.dst)) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.l2.notForMe', params: { dst: frame.dst, mac: iface.mac } },
    });
    return;
  }
  if (frame.payload.kind === 'arp') arpRx(ctx, node, iface, base, frame.payload);
  else if (frame.payload.kind === 'ipv4') ipRx(ctx, node, iface, base, frame.payload, frame);
}

export function learn(ctx: DeviceCtx, node: IpNode, ip: Ipv4Addr, mac: string): void {
  node.cfg.arpCache[ip] = { mac, expiresAt: ctx.now + node.arpTtlUs };
}

function arpRx(ctx: DeviceCtx, node: IpNode, iface: Iface, base: Base, a: ArpPdu): void {
  const gratuitous = a.op === 'request' && a.senderIp === a.targetIp;
  if (a.op === 'request') {
    if (gratuitous && a.senderIp !== iface.ip) {
      if (node.cfg.arpCache[a.senderIp]) learn(ctx, node, a.senderIp, a.senderMac);
      ctx.log({
        ...base,
        kind: 'rx',
        status: 'info',
        msg: { key: 'host.arp.gratuitous', params: { ip: a.senderIp, mac: a.senderMac } },
      });
      return;
    }
    if (a.targetIp !== iface.ip) {
      ctx.log({
        ...base,
        kind: 'drop',
        status: 'drop',
        msg: { key: 'host.arp.notMine', params: { ip: a.targetIp } },
      });
      return;
    }
    if (gratuitous) {
      ctx.log({
        ...base,
        kind: 'error',
        status: 'error',
        msg: { key: 'host.arp.conflict', params: { ip: a.senderIp, mac: a.senderMac } },
      });
      return;
    }
    learn(ctx, node, a.senderIp, a.senderMac);
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'ok',
      msg: { key: 'host.arp.request', params: { ip: a.targetIp, sender: a.senderIp } },
    });
    const reply: ArpPdu = {
      kind: 'arp',
      op: 'reply',
      senderMac: iface.mac,
      senderIp: iface.ip,
      targetMac: a.senderMac,
      targetIp: a.senderIp,
    };
    node.xmit(ctx, iface, eth(iface.mac, a.senderMac, reply));
    return;
  }
  learn(ctx, node, a.senderIp, a.senderMac);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'host.arp.reply', params: { ip: a.senderIp, mac: a.senderMac } },
  });
  const pend = node.cfg.arpPending[a.senderIp];
  if (pend) {
    delete node.cfg.arpPending[a.senderIp];
    ctx.cancelTimer(`arp:${a.senderIp}`);
    const out = node.ifaces.find((i) => i.id === pend.ifaceId) ?? iface;
    for (const pkt of pend.queue) node.xmit(ctx, out, eth(out.mac, a.senderMac, pkt));
  }
}

function ipRx(ctx: DeviceCtx, node: IpNode, iface: Iface, base: Base, ip: Ipv4Pdu, frame: Frame): void {
  const bcast = ip.dst === '255.255.255.255' || ip.dst === broadcastAddress(iface.ip, iface.mask);
  if (isLocalIp(node, ip.dst) || bcast) {
    deliverLocal(ctx, node, iface, base, ip, frame, bcast && !isLocalIp(node, ip.dst));
    return;
  }
  if (!node.forwarding) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.ip.notMine', params: { dst: ip.dst } },
    });
    return;
  }
  forward(ctx, node, iface, base, ip);
}

function forward(ctx: DeviceCtx, node: IpNode, ifaceIn: Iface, base: Base, ipIn: Ipv4Pdu): void {
  const l3 = node.l3;
  let ip = ipIn;
  // 1) Eingehende ACL
  if (l3 && ifaceIn.cfg.aclIn) {
    const r = aclEval(l3.acls[ifaceIn.cfg.aclIn], ip);
    if (r.action === 'deny') {
      ctx.log({
        ...base,
        kind: 'drop',
        proto: 'ACL',
        status: 'drop',
        msg: { key: 'acl.deny', params: { acl: ifaceIn.cfg.aclIn, dir: 'in', src: ip.src, dst: ip.dst } },
      });
      sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.admin, ip, ifaceIn.ip);
      return;
    }
  }
  // 2) NAT outside → inside (vor dem Routing)
  if (l3 && ifaceIn.cfg.natSide === 'outside' && l3.nat.rules.length > 0) {
    const r = natOutside2Inside(l3, ip, ctx.now);
    if (r.entry) {
      ctx.log({
        ...base,
        kind: 'rx',
        proto: 'NAT',
        status: 'info',
        msg: {
          key: 'nat.in',
          params: { global: r.entry.insideGlobal.ip, local: r.entry.insideLocal.ip, src: ip.src },
        },
      });
      ip = r.pkt;
    }
  }
  if (ip.ttl <= 1) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'router.ttlExpired', params: { dst: ip.dst, src: ip.src } },
    });
    sendIcmpError(ctx, node, 'time-exceeded', 0, ip, ifaceIn.ip);
    return;
  }
  const hop = node.lookup(ip.dst);
  if (!hop) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'router.noRoute', params: { dst: ip.dst } },
    });
    sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.net, ip, ifaceIn.ip);
    return;
  }
  let out: Ipv4Pdu = { ...structuredClone(ip), ttl: ip.ttl - 1 };
  // 3) NAT inside → outside (nach dem Routing)
  if (l3 && ifaceIn.cfg.natSide === 'inside' && hop.iface.cfg.natSide === 'outside') {
    const r = natInside2Outside(l3, out, hop.iface, ctx.now);
    if (r.entry) {
      ctx.log({
        ...base,
        kind: 'rx',
        proto: 'NAT',
        status: 'info',
        msg: {
          key: 'nat.out',
          params: { local: r.entry.insideLocal.ip, global: r.entry.insideGlobal.ip, dst: ip.dst },
        },
      });
      out = r.pkt;
    }
  }
  // 4) Ausgehende ACL
  if (l3 && hop.iface.cfg.aclOut) {
    const r = aclEval(l3.acls[hop.iface.cfg.aclOut], out);
    if (r.action === 'deny') {
      ctx.log({
        ...base,
        kind: 'drop',
        proto: 'ACL',
        status: 'drop',
        msg: {
          key: 'acl.deny',
          params: { acl: hop.iface.cfg.aclOut, dir: 'out', src: out.src, dst: out.dst },
        },
      });
      sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.admin, ip, ifaceIn.ip);
      return;
    }
  }
  const r = ipSendVia(ctx, node, hop, out);
  if (!r.ok && r.reason === 'needFrag') {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: {
        key: 'router.needFrag',
        params: { size: pduSize(ip), mtu: r.mtu, port: ctx.deviceIfaceName(hop.iface.id) },
      },
    });
    sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.fragNeeded, ip, ifaceIn.ip, r.mtu);
    return;
  }
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: {
      key: 'router.forward',
      params: {
        dst: ip.dst,
        via: hop.nextHop,
        port: ctx.deviceIfaceName(hop.iface.id),
        ttl: out.ttl,
      },
    },
  });
}

function reassemble(ctx: DeviceCtx, cfg: IpCore, ip: Ipv4Pdu): Ipv4Pdu | undefined {
  if (!ip.mf && ip.fragOffset === 0) return ip;
  for (const [k, e] of Object.entries(cfg.reasm)) {
    if (ctx.now - e.firstSeen > REASM_TIMEOUT_US) delete cfg.reasm[k];
  }
  const key = `${ip.src}>${ip.dst}:${ip.id}:${ip.protocol}`;
  const e = (cfg.reasm[key] ??= { firstSeen: ctx.now, parts: [], payload: ip.payload });
  const len = ip.dataLen ?? 0;
  e.parts.push({ off: ip.fragOffset * 8, len });
  if (!ip.mf) e.total = ip.fragOffset * 8 + len;
  if (e.total === undefined) return undefined;
  let cur = 0;
  for (const p of [...e.parts].sort((a, b) => a.off - b.off)) {
    if (p.off > cur) return undefined;
    cur = Math.max(cur, p.off + p.len);
  }
  if (cur < e.total) return undefined;
  delete cfg.reasm[key];
  return { ...structuredClone(ip), mf: false, fragOffset: 0, dataLen: undefined, payload: e.payload };
}

function deliverLocal(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ipIn: Ipv4Pdu,
  frame: Frame,
  broadcast: boolean,
): void {
  const ip = reassemble(ctx, node.cfg, ipIn);
  if (!ip) {
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'info',
      msg: { key: 'ip.fragmentHeld', params: { src: ipIn.src, offset: ipIn.fragOffset * 8 } },
    });
    return;
  }
  const reassembled = ip !== ipIn;
  const l4 = ip.payload;
  if (l4.kind === 'udp') {
    udpIn(ctx, node, iface, base, ip, frame, broadcast);
    return;
  }
  if (l4.kind === 'tcp') {
    if (node.host && !broadcast) tcpRx(ctx, node, node.host, iface, base, ip, l4);
    else ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'ip.noService', params: { port: l4.dstPort } } });
    return;
  }
  if (l4.type === 'echo-request') {
    if (broadcast) {
      ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'host.icmp.broadcastIgnored' } });
      return;
    }
    learn(ctx, node, ip.src, frame.src);
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'ok',
      msg: {
        key: reassembled ? 'ip.reassembled' : 'host.icmp.echoRequest',
        params: { src: ip.src, size: pduSize(ip) },
      },
    });
    const reply = newIpPacket(node, ip.dst, ip.src, { ...l4, type: 'echo-reply' });
    ipSend(ctx, node, reply);
    return;
  }
  if (l4.type === 'echo-reply') {
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'ok',
      msg: {
        key: reassembled ? 'ip.reassembled' : 'host.icmp.echoReply',
        params: { src: ip.src, size: pduSize(ip) },
      },
    });
    onEchoReply(ctx, node, ip);
    return;
  }
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'info',
    msg: { key: 'host.icmp.error', params: { src: ip.src, type: l4.type, code: l4.code } },
  });
  onIcmpError(ctx, node, ip);
}

function udpIn(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  frame: Frame,
  broadcast: boolean,
): void {
  const udp = ip.payload;
  if (udp.kind !== 'udp') return;
  const app = udp.app;
  if (app?.kind === 'dhcp' && dhcpRx(ctx, node, iface, base, ip, udp, app, frame)) return;
  if (app?.kind === 'dns' && dnsRx(ctx, node, iface, base, ip, udp, app)) return;
  ctx.log({
    ...base,
    kind: 'drop',
    status: 'drop',
    msg: { key: 'ip.noService', params: { port: udp.dstPort } },
  });
  if (!broadcast) sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.port, ip, iface.ip);
}

// ------------------------------------------------------------------ Timer

export function ipTimer(ctx: DeviceCtx, node: IpNode, name: string): boolean {
  if (!name.startsWith('arp:')) return false;
  const ip = name.slice(4);
  const pend = node.cfg.arpPending[ip];
  if (!pend) return true;
  if (pend.attempts >= ARP_MAX_ATTEMPTS) {
    delete node.cfg.arpPending[ip];
    ctx.log({
      kind: 'error',
      proto: 'ARP',
      status: 'error',
      msg: { key: 'host.arp.failed', params: { ip } },
    });
    for (const pkt of pend.queue) undeliverable(ctx, node, pkt);
    return true;
  }
  pend.attempts++;
  const iface = node.ifaces.find((i) => i.id === pend.ifaceId);
  if (iface) sendArpRequest(ctx, node, iface, ip);
  ctx.setTimer(name, ARP_RETRY_US);
  return true;
}

/** ARP blieb ohne Antwort: lokales Paket → Fehler im Diagnose-Kontext, fremdes → ICMP Host Unreachable. */
function undeliverable(ctx: DeviceCtx, node: IpNode, pkt: Ipv4Pdu): void {
  if (isLocalIp(node, pkt.src)) {
    onIcmpError(ctx, node, pkt, 'local-host-unreachable');
    return;
  }
  const back = node.lookup(pkt.src);
  if (back) sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.host, pkt, back.iface.ip);
}

export type { EthernetPdu };
