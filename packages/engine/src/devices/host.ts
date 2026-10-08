import {
  BROADCAST_MAC,
  ETHERTYPE,
  IP_PROTO,
  broadcastAddress,
  isBroadcastMac,
  isMulticastMac,
  sameSubnet,
  summarizeFrame,
  type ArpPdu,
  type Frame,
  type Ipv4Addr,
  type Ipv4Pdu,
  type ProtoTag,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { HostConfig, PingResult, Result } from '../types';

export const HOST_ARP_TTL_US = 120_000_000;
export const ARP_RETRY_US = 1_000_000;
export const ARP_MAX_ATTEMPTS = 3;
export const PING_TIMEOUT_US = 4_000_000;
export const DEFAULT_TTL = 128;
const MAX_PING_HISTORY = 500;

function eth(src: string, dst: string, payload: ArpPdu | Ipv4Pdu): Frame {
  return {
    kind: 'ethernet',
    src,
    dst,
    etherType: payload.kind === 'arp' ? ETHERTYPE.arp : ETHERTYPE.ipv4,
    payload,
  };
}

function findPing(cfg: HostConfig, id: number, seq: number): PingResult | undefined {
  return cfg.pings.find((p) => p.id === id && p.seq === seq);
}

// ------------------------------------------------------------------ Empfang

export function hostRx(
  ctx: DeviceCtx,
  cfg: HostConfig,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const port = ctx.port(portId);
  const { proto, info } = summarizeFrame(frame);
  const base = { from: fromId, port, frame, summary: info, proto } as const;

  const forMe = frame.dst === port.mac;
  if (!forMe && !isBroadcastMac(frame.dst) && !isMulticastMac(frame.dst)) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.l2.notForMe', params: { dst: frame.dst, mac: port.mac } },
    });
    return;
  }
  if (frame.payload.kind === 'arp') arpRx(ctx, cfg, base, frame.payload);
  else ipRx(ctx, cfg, base, frame.payload, frame);
}

type Base = {
  readonly from: string;
  readonly port: ReturnType<DeviceCtx['port']>;
  readonly frame: Frame;
  readonly summary: string;
  readonly proto: ProtoTag;
};

function learn(ctx: DeviceCtx, cfg: HostConfig, ip: Ipv4Addr, mac: string): void {
  cfg.arpCache[ip] = { mac, expiresAt: ctx.now + HOST_ARP_TTL_US };
}

function arpRx(ctx: DeviceCtx, cfg: HostConfig, base: Base, a: ArpPdu): void {
  if (!cfg.ip) {
    ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'host.noIp' } });
    return;
  }
  const gratuitous = a.op === 'request' && a.senderIp === a.targetIp;
  if (a.op === 'request') {
    if (gratuitous && a.senderIp !== cfg.ip) {
      // Gratuitous ARP: nur vorhandene Einträge aktualisieren.
      if (cfg.arpCache[a.senderIp]) learn(ctx, cfg, a.senderIp, a.senderMac);
      ctx.log({
        ...base,
        kind: 'rx',
        status: 'info',
        msg: { key: 'host.arp.gratuitous', params: { ip: a.senderIp, mac: a.senderMac } },
      });
      return;
    }
    if (a.targetIp !== cfg.ip) {
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
    learn(ctx, cfg, a.senderIp, a.senderMac);
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
      senderIp: cfg.ip,
      targetMac: a.senderMac,
      targetIp: a.senderIp,
    };
    ctx.send(base.port.id, eth(base.port.mac, a.senderMac, reply), ctx.processingUs);
    return;
  }

  // Reply
  learn(ctx, cfg, a.senderIp, a.senderMac);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'host.arp.reply', params: { ip: a.senderIp, mac: a.senderMac } },
  });
  const pend = cfg.arpPending[a.senderIp];
  if (pend) {
    delete cfg.arpPending[a.senderIp];
    ctx.cancelTimer(`arp:${a.senderIp}`);
    for (const pkt of pend.queue) {
      ctx.send(base.port.id, eth(base.port.mac, a.senderMac, pkt), ctx.processingUs);
    }
  }
}

function ipRx(ctx: DeviceCtx, cfg: HostConfig, base: Base, ip: Ipv4Pdu, frame: Frame): void {
  if (!cfg.ip || !cfg.mask) {
    ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'host.noIp' } });
    return;
  }
  const bcast = ip.dst === '255.255.255.255' || ip.dst === broadcastAddress(cfg.ip, cfg.mask);
  if (ip.dst !== cfg.ip && !bcast) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.ip.notMine', params: { dst: ip.dst } },
    });
    return;
  }
  const icmp = ip.payload;
  if (icmp.type === 'echo-request') {
    if (bcast) {
      ctx.log({
        ...base,
        kind: 'drop',
        status: 'drop',
        msg: { key: 'host.icmp.broadcastIgnored' },
      });
      return;
    }
    // Quelle direkt aus dem Frame lernen, damit die Antwort ohne eigenes ARP rausgeht.
    learn(ctx, cfg, ip.src, frame.src);
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'ok',
      msg: { key: 'host.icmp.echoRequest', params: { src: ip.src } },
    });
    const reply: Ipv4Pdu = {
      kind: 'ipv4',
      src: cfg.ip,
      dst: ip.src,
      ttl: DEFAULT_TTL,
      protocol: IP_PROTO.icmp,
      id: cfg.nextIpId++,
      df: false,
      payload: { ...icmp, type: 'echo-reply' },
    };
    outputIp(ctx, cfg, reply);
    return;
  }
  // echo-reply
  const res = findPing(cfg, icmp.id, icmp.seq);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'host.icmp.echoReply', params: { src: ip.src } },
  });
  if (res && res.status === 'pending') {
    res.status = 'reply';
    res.rttUs = ctx.now - res.sentAt;
    ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
    ctx.log({
      kind: 'ping',
      proto: 'ICMP',
      status: 'ok',
      msg: {
        key: 'ping.reply',
        params: { ip: ip.src, bytes: icmp.dataSize, rttUs: res.rttUs, ttl: ip.ttl, seq: icmp.seq },
      },
    });
  }
}

// ------------------------------------------------------------------ Senden

function sendArpRequest(ctx: DeviceCtx, cfg: HostConfig, target: Ipv4Addr): void {
  const port = ctx.device.ports[0];
  if (!port || !cfg.ip) return;
  const req: ArpPdu = {
    kind: 'arp',
    op: 'request',
    senderMac: port.mac,
    senderIp: cfg.ip,
    targetMac: '00:00:00:00:00:00',
    targetIp: target,
  };
  ctx.send(port.id, eth(port.mac, BROADCAST_MAC, req), ctx.processingUs);
}

/** Routet ein IP-Paket: On-Link direkt, sonst Gateway; ARP-Auflösung mit Warteschlange. */
export function outputIp(ctx: DeviceCtx, cfg: HostConfig, pkt: Ipv4Pdu): void {
  const port = ctx.device.ports[0];
  if (!port || !cfg.ip || !cfg.mask) return;
  const nextHop = sameSubnet(pkt.dst, cfg.ip, cfg.mask) ? pkt.dst : cfg.gateway;
  if (!nextHop) {
    failPacket(ctx, cfg, pkt, 'ping.noRoute');
    return;
  }
  const entry = cfg.arpCache[nextHop];
  if (entry && entry.expiresAt > ctx.now) {
    ctx.send(port.id, eth(port.mac, entry.mac, pkt), ctx.processingUs);
    return;
  }
  let pend = cfg.arpPending[nextHop];
  if (!pend) {
    pend = { attempts: 1, queue: [] };
    cfg.arpPending[nextHop] = pend;
    sendArpRequest(ctx, cfg, nextHop);
    ctx.setTimer(`arp:${nextHop}`, ARP_RETRY_US);
  }
  pend.queue.push(pkt);
}

function failPacket(ctx: DeviceCtx, cfg: HostConfig, pkt: Ipv4Pdu, key: string): void {
  const icmp = pkt.payload;
  if (icmp.type !== 'echo-request') return;
  const res = findPing(cfg, icmp.id, icmp.seq);
  if (res && res.status === 'pending') {
    res.status = 'unreachable';
    ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
    ctx.log({
      kind: 'ping',
      proto: 'ICMP',
      status: 'error',
      msg: { key, params: { ip: pkt.dst } },
    });
  }
}

// ------------------------------------------------------------------ Timer

export function hostTimer(ctx: DeviceCtx, cfg: HostConfig, name: string): void {
  if (name.startsWith('arp:')) {
    const ip = name.slice(4);
    const pend = cfg.arpPending[ip];
    if (!pend) return;
    if (pend.attempts >= ARP_MAX_ATTEMPTS) {
      delete cfg.arpPending[ip];
      ctx.log({
        kind: 'error',
        proto: 'ARP',
        status: 'error',
        msg: { key: 'host.arp.failed', params: { ip } },
      });
      for (const pkt of pend.queue) failPacket(ctx, cfg, pkt, 'ping.hostUnreachable');
      return;
    }
    pend.attempts++;
    sendArpRequest(ctx, cfg, ip);
    ctx.setTimer(name, ARP_RETRY_US);
  } else if (name.startsWith('ping-timeout:')) {
    const [, id, seq] = name.split(':');
    const res = findPing(cfg, Number(id), Number(seq));
    if (res && res.status === 'pending') {
      res.status = 'timeout';
      ctx.log({
        kind: 'ping',
        proto: 'ICMP',
        status: 'error',
        msg: { key: 'ping.timeout', params: { ip: res.dst, seq: res.seq } },
      });
    }
  } else if (name.startsWith('ping:')) {
    const id = Number(name.slice(5));
    const s = cfg.pingSessions.find((x) => x.id === id);
    if (!s) {
      ctx.cancelTimer(name);
      return;
    }
    sendPingSeq(ctx, cfg, s.id);
  }
}

// ------------------------------------------------------------------ Befehle

export interface PingOptions {
  count?: number;
  intervalUs?: number;
  dataSize?: number;
}

export function startPing(
  ctx: DeviceCtx,
  cfg: HostConfig,
  dst: Ipv4Addr,
  opts: PingOptions = {},
): Result<number> {
  if (!cfg.ip || !cfg.mask) {
    ctx.log({ kind: 'error', proto: 'ICMP', status: 'error', msg: { key: 'ping.noIp' } });
    return { ok: false, error: 'ping.noIp' };
  }
  const id = cfg.nextPingId++;
  const count = opts.count ?? 1;
  cfg.pingSessions.push({
    id,
    dst,
    count,
    sent: 0,
    intervalUs: opts.intervalUs ?? 1_000_000,
    dataSize: opts.dataSize ?? 32,
  });
  sendPingSeq(ctx, cfg, id);
  const s = cfg.pingSessions.find((x) => x.id === id);
  if (s && count > 1) ctx.setTimer(`ping:${id}`, s.intervalUs, s.intervalUs);
  return { ok: true, value: id };
}

function sendPingSeq(ctx: DeviceCtx, cfg: HostConfig, sessionId: number): void {
  const idx = cfg.pingSessions.findIndex((x) => x.id === sessionId);
  const s = cfg.pingSessions[idx];
  if (!s || !cfg.ip) return;
  s.sent++;
  const seq = s.sent;
  cfg.pings.push({ id: s.id, seq, dst: s.dst, sentAt: ctx.now, status: 'pending' });
  if (cfg.pings.length > MAX_PING_HISTORY) cfg.pings.splice(0, cfg.pings.length - MAX_PING_HISTORY);
  ctx.setTimer(`ping-timeout:${s.id}:${seq}`, PING_TIMEOUT_US);
  const pkt: Ipv4Pdu = {
    kind: 'ipv4',
    src: cfg.ip,
    dst: s.dst,
    ttl: DEFAULT_TTL,
    protocol: IP_PROTO.icmp,
    id: cfg.nextIpId++,
    df: false,
    payload: { kind: 'icmp', type: 'echo-request', code: 0, id: s.id, seq, dataSize: s.dataSize },
  };
  if (s.sent >= s.count) {
    ctx.cancelTimer(`ping:${s.id}`);
    cfg.pingSessions.splice(idx, 1);
  }
  outputIp(ctx, cfg, pkt);
}

/** Gratuitous ARP nach IP-Änderung. */
export function announce(ctx: DeviceCtx, cfg: HostConfig): void {
  const port = ctx.device.ports[0];
  if (!port || !cfg.ip) return;
  sendArpRequest(ctx, cfg, cfg.ip);
}

/** Setzt flüchtigen Laufzeitzustand zurück (Ausschalten / IP-Änderung). */
export function resetHostRuntime(cfg: HostConfig): void {
  cfg.arpCache = {};
  cfg.arpPending = {};
  cfg.pingSessions = [];
}
