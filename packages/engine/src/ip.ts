import {
  BROADCAST_MAC,
  ETHERTYPE,
  IP_PROTO,
  ICMP_UNREACH,
  broadcastAddress,
  isBroadcastMac,
  isMulticastMac,
  pduSize,
  summarizeFrame,
  type ArpPdu,
  type Frame,
  type IcmpPdu,
  type Ipv4Addr,
  type Ipv4Pdu,
  type ProtoTag,
} from '@netsim/protocols';
import type { DeviceCtx } from './ctx';
import { onEchoReply, onIcmpError } from './diag';
import type { IpCore } from './types';

export const ARP_RETRY_US = 1_000_000;
export const ARP_MAX_ATTEMPTS = 3;
export const REASM_TIMEOUT_US = 15_000_000;

export interface Iface {
  portId: string;
  ip: Ipv4Addr;
  mask: string;
}

export interface NextHop {
  nextHop: Ipv4Addr;
  iface: Iface;
}

/** Sicht auf ein IP-fähiges Gerät (Host oder Router) für einen Verarbeitungsschritt. */
export interface IpNode {
  cfg: IpCore;
  forwarding: boolean;
  arpTtlUs: number;
  defaultTtl: number;
  ifaces: Iface[];
  lookup(dst: Ipv4Addr): NextHop | undefined;
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'noRoute' }
  | { ok: false; reason: 'needFrag'; mtu: number };

type Base = {
  readonly from: string;
  readonly port: ReturnType<DeviceCtx['port']>;
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

export function newIpPacket(
  node: IpNode,
  src: Ipv4Addr,
  dst: Ipv4Addr,
  payload: IcmpPdu,
  opts: { ttl?: number; df?: boolean } = {},
): Ipv4Pdu {
  return {
    kind: 'ipv4',
    src,
    dst,
    ttl: opts.ttl ?? node.defaultTtl,
    protocol: IP_PROTO.icmp,
    id: node.cfg.nextIpId++,
    df: opts.df ?? false,
    mf: false,
    fragOffset: 0,
    payload,
  };
}

export function isLocalIp(node: IpNode, ip: Ipv4Addr): boolean {
  return node.ifaces.some((i) => i.ip === ip);
}

// ------------------------------------------------------------------ Senden

export function sendArpRequest(
  ctx: DeviceCtx,
  iface: Iface,
  target: Ipv4Addr,
): void {
  const port = ctx.port(iface.portId);
  const req: ArpPdu = {
    kind: 'arp',
    op: 'request',
    senderMac: port.mac,
    senderIp: iface.ip,
    targetMac: '00:00:00:00:00:00',
    targetIp: target,
  };
  ctx.send(port.id, eth(port.mac, BROADCAST_MAC, req), ctx.processingUs);
}

function emit(ctx: DeviceCtx, node: IpNode, hop: NextHop, pkt: Ipv4Pdu): void {
  const port = ctx.port(hop.iface.portId);
  const entry = node.cfg.arpCache[hop.nextHop];
  if (entry && entry.expiresAt > ctx.now) {
    ctx.send(port.id, eth(port.mac, entry.mac, pkt), ctx.processingUs);
    return;
  }
  let pend = node.cfg.arpPending[hop.nextHop];
  if (!pend) {
    pend = { attempts: 1, portId: port.id, queue: [] };
    node.cfg.arpPending[hop.nextHop] = pend;
    sendArpRequest(ctx, hop.iface, hop.nextHop);
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

/** Routet ein Paket: Lookup → MTU/Fragmentierung → ARP → Senden. */
export function ipSend(ctx: DeviceCtx, node: IpNode, pkt: Ipv4Pdu): SendResult {
  const hop = node.lookup(pkt.dst);
  if (!hop) return { ok: false, reason: 'noRoute' };
  const mtu = ctx.port(hop.iface.portId).mtu;
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
  const t = off.payload.type;
  if (t === 'dest-unreachable' || t === 'time-exceeded' || off.fragOffset > 0) return;
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
      icmpId: off.payload.id,
      icmpSeq: off.payload.seq,
    },
    nextHopMtu,
  };
  const pkt = newIpPacket(node, srcIp, off.src, icmp, { ttl: node.forwarding ? 255 : node.defaultTtl });
  ipSend(ctx, node, pkt);
}

// ------------------------------------------------------------------ Empfang

export function ipFrameRx(
  ctx: DeviceCtx,
  node: IpNode,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const port = ctx.port(portId);
  const { proto, info } = summarizeFrame(frame);
  const base: Base = { from: fromId, port, frame, summary: info, proto };
  if (frame.dst !== port.mac && !isBroadcastMac(frame.dst) && !isMulticastMac(frame.dst)) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.l2.notForMe', params: { dst: frame.dst, mac: port.mac } },
    });
    return;
  }
  const iface = node.ifaces.find((i) => i.portId === portId);
  if (!iface) {
    ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'host.noIp' } });
    return;
  }
  if (frame.payload.kind === 'arp') arpRx(ctx, node, iface, base, frame.payload);
  else ipRx(ctx, node, iface, base, frame.payload, frame);
}

function learn(ctx: DeviceCtx, node: IpNode, ip: Ipv4Addr, mac: string): void {
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
      senderMac: base.port.mac,
      senderIp: iface.ip,
      targetMac: a.senderMac,
      targetIp: a.senderIp,
    };
    ctx.send(base.port.id, eth(base.port.mac, a.senderMac, reply), ctx.processingUs);
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
    for (const pkt of pend.queue) {
      ctx.send(pend.portId, eth(ctx.port(pend.portId).mac, a.senderMac, pkt), ctx.processingUs);
    }
  }
}

function ipRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  frame: Frame,
): void {
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

function forward(ctx: DeviceCtx, node: IpNode, iface: Iface, base: Base, ip: Ipv4Pdu): void {
  if (ip.ttl <= 1) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'router.ttlExpired', params: { dst: ip.dst, src: ip.src } },
    });
    sendIcmpError(ctx, node, 'time-exceeded', 0, ip, iface.ip);
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
    sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.net, ip, iface.ip);
    return;
  }
  const out: Ipv4Pdu = { ...structuredClone(ip), ttl: ip.ttl - 1 };
  const r = ipSend(ctx, node, out);
  if (!r.ok && r.reason === 'needFrag') {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: {
        key: 'router.needFrag',
        params: { size: pduSize(ip), mtu: r.mtu, port: ctx.port(hop.iface.portId).name },
      },
    });
    sendIcmpError(ctx, node, 'dest-unreachable', ICMP_UNREACH.fragNeeded, ip, iface.ip, r.mtu);
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
        port: ctx.port(hop.iface.portId).name,
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
  const icmp = ip.payload;
  if (icmp.type === 'echo-request') {
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
    const reply = newIpPacket(node, ip.dst, ip.src, { ...icmp, type: 'echo-reply' });
    ipSend(ctx, node, reply);
    return;
  }
  if (icmp.type === 'echo-reply') {
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
    msg: {
      key: 'host.icmp.error',
      params: { src: ip.src, type: icmp.type, code: icmp.code },
    },
  });
  onIcmpError(ctx, node, ip);
  void iface;
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
  const iface = node.ifaces.find((i) => i.portId === pend.portId);
  if (iface) sendArpRequest(ctx, iface, ip);
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
