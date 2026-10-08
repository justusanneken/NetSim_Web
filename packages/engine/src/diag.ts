import { ICMP_UNREACH, type Ipv4Addr, type Ipv4Pdu } from '@netsim/protocols';
import type { DeviceCtx } from './ctx';
import { ipSend, newIpPacket, type IpNode } from './ip';
import type { PingResult, PingSession, Result, TraceProbe, TraceSession } from './types';

export const PING_TIMEOUT_US = 4_000_000;
export const TRACE_TIMEOUT_US = 2_000_000;
export const TRACE_PROBES = 3;
const TRACE_BASE = 10_000;
const MAX_PING_HISTORY = 500;

export interface PingOptions {
  count?: number;
  intervalUs?: number;
  dataSize?: number;
  df?: boolean;
  source?: Ipv4Addr;
  /** Wartezeit je Echo in µs (Default 4 s). */
  timeoutUs?: number;
}

const findPing = (node: IpNode, id: number, seq: number): PingResult | undefined =>
  node.cfg.pings.find((p) => p.id === id && p.seq === seq);

function errorNote(type: string, code: number): string {
  if (type === 'time-exceeded') return 'ping.ttlExpired';
  if (code === ICMP_UNREACH.net) return 'ping.netUnreachable';
  if (code === ICMP_UNREACH.host) return 'ping.hostUnreachable';
  if (code === ICMP_UNREACH.fragNeeded) return 'ping.fragNeeded';
  return 'ping.unreachableOther';
}

// ------------------------------------------------------------------ Ping

export function startPing(
  ctx: DeviceCtx,
  node: IpNode,
  dst: Ipv4Addr,
  opts: PingOptions = {},
): Result<number> {
  if (node.ifaces.length === 0) {
    ctx.log({ kind: 'error', proto: 'ICMP', status: 'error', msg: { key: 'ping.noIp' } });
    return { ok: false, error: 'ping.noIp' };
  }
  const id = node.cfg.nextPingId++;
  const s: PingSession = {
    id,
    dst,
    count: opts.count ?? 1,
    sent: 0,
    intervalUs: opts.intervalUs ?? 1_000_000,
    dataSize: opts.dataSize ?? 32,
    df: opts.df ?? false,
    source: opts.source,
    timeoutUs: opts.timeoutUs ?? PING_TIMEOUT_US,
  };
  node.cfg.pingSessions.push(s);
  sendPingSeq(ctx, node, id);
  if (s.count > 1) ctx.setTimer(`ping:${id}`, s.intervalUs, s.intervalUs);
  return { ok: true, value: id };
}

function sendPingSeq(ctx: DeviceCtx, node: IpNode, sessionId: number): void {
  const cfg = node.cfg;
  const idx = cfg.pingSessions.findIndex((x) => x.id === sessionId);
  const s = cfg.pingSessions[idx];
  if (!s) return;
  s.sent++;
  const seq = s.sent;
  const res: PingResult = { id: s.id, seq, dst: s.dst, sentAt: ctx.now, status: 'pending' };
  cfg.pings.push(res);
  if (cfg.pings.length > MAX_PING_HISTORY) cfg.pings.splice(0, cfg.pings.length - MAX_PING_HISTORY);
  if (s.sent >= s.count) {
    ctx.cancelTimer(`ping:${s.id}`);
    cfg.pingSessions.splice(idx, 1);
  }
  const hop = node.lookup(s.dst);
  if (!hop) return failPing(ctx, res, 'ping.noRoute', s.dst, undefined);
  const src = s.source ?? hop.iface.ip;
  ctx.setTimer(`ping-timeout:${s.id}:${seq}`, s.timeoutUs);
  const pkt = newIpPacket(
    node,
    src,
    s.dst,
    { kind: 'icmp', type: 'echo-request', code: 0, id: s.id, seq, dataSize: s.dataSize },
    { df: s.df },
  );
  const r = ipSend(ctx, node, pkt);
  if (!r.ok) {
    ctx.cancelTimer(`ping-timeout:${s.id}:${seq}`);
    failPing(ctx, res, r.reason === 'needFrag' ? 'ping.fragNeeded' : 'ping.noRoute', s.dst, hop.iface.ip);
  }
}

function failPing(
  ctx: DeviceCtx,
  res: PingResult,
  note: string,
  dst: Ipv4Addr,
  from: Ipv4Addr | undefined,
): void {
  if (res.status !== 'pending') return;
  res.status = 'unreachable';
  res.note = note;
  res.from = from;
  ctx.log({
    kind: 'ping',
    proto: 'ICMP',
    status: 'error',
    msg: { key: note, params: { ip: from ?? dst, dst } },
  });
}

// ------------------------------------------------------------------ Traceroute

export function startTrace(
  ctx: DeviceCtx,
  node: IpNode,
  dst: Ipv4Addr,
  maxHops = 30,
): Result<number> {
  if (node.ifaces.length === 0) return { ok: false, error: 'ping.noIp' };
  const tr: TraceSession = {
    id: node.cfg.nextTraceId++,
    dst,
    maxHops,
    ttl: 1,
    hops: [],
    done: false,
  };
  node.cfg.traces.push(tr);
  sendProbe(ctx, node, tr);
  return { ok: true, value: tr.id };
}

function sendProbe(ctx: DeviceCtx, node: IpNode, tr: TraceSession): void {
  const hop = (tr.hops[tr.ttl - 1] ??= { ttl: tr.ttl, probes: [] });
  const p = hop.probes.length;
  const probe: TraceProbe = { status: 'pending', sentAt: ctx.now };
  hop.probes.push(probe);
  const route = node.lookup(tr.dst);
  if (!route) {
    probe.status = 'timeout';
    tr.done = true;
    return;
  }
  ctx.setTimer(`trace-timeout:${tr.id}:${tr.ttl}:${p}`, TRACE_TIMEOUT_US);
  const pkt = newIpPacket(
    node,
    route.iface.ip,
    tr.dst,
    {
      kind: 'icmp',
      type: 'echo-request',
      code: 0,
      id: TRACE_BASE + tr.id,
      seq: tr.ttl * 100 + p,
      dataSize: 32,
    },
    { ttl: tr.ttl },
  );
  ipSend(ctx, node, pkt);
}

function advanceTrace(ctx: DeviceCtx, node: IpNode, tr: TraceSession): void {
  const hop = tr.hops[tr.ttl - 1];
  if (!hop || tr.done) return;
  if (hop.probes.length < TRACE_PROBES) return sendProbe(ctx, node, tr);
  if (hop.probes.some((p) => p.outcome === 'reached' || p.outcome === 'unreachable')) {
    tr.done = true;
    return;
  }
  if (tr.ttl >= tr.maxHops) {
    tr.done = true;
    return;
  }
  tr.ttl++;
  sendProbe(ctx, node, tr);
}

function traceResponse(
  ctx: DeviceCtx,
  node: IpNode,
  icmpId: number,
  icmpSeq: number,
  from: Ipv4Addr,
  outcome: NonNullable<TraceProbe['outcome']>,
): void {
  const tr = node.cfg.traces.find((t) => t.id === icmpId - TRACE_BASE);
  if (!tr || tr.done) return;
  const ttl = Math.floor(icmpSeq / 100);
  const p = icmpSeq % 100;
  const probe = tr.hops[ttl - 1]?.probes[p];
  if (!probe || probe.status !== 'pending') return;
  probe.status = 'reply';
  probe.from = from;
  probe.outcome = outcome;
  probe.rttUs = ctx.now - probe.sentAt;
  ctx.cancelTimer(`trace-timeout:${tr.id}:${ttl}:${p}`);
  if (ttl === tr.ttl) advanceTrace(ctx, node, tr);
}

// ------------------------------------------------------------------ Antworten

export function onEchoReply(ctx: DeviceCtx, node: IpNode, ip: Ipv4Pdu): void {
  const icmp = ip.payload;
  if (icmp.id >= TRACE_BASE) {
    traceResponse(ctx, node, icmp.id, icmp.seq, ip.src, 'reached');
    return;
  }
  const res = findPing(node, icmp.id, icmp.seq);
  if (!res || res.status !== 'pending') return;
  res.status = 'reply';
  res.rttUs = ctx.now - res.sentAt;
  res.from = ip.src;
  res.ttl = ip.ttl;
  res.bytes = icmp.dataSize;
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

/**
 * ICMP-Fehler (Unreachable/Time Exceeded) zu einem eigenen Paket.
 * `local`: ARP-Fehlschlag – `ip` ist dann das nicht zustellbare eigene Paket.
 */
export function onIcmpError(
  ctx: DeviceCtx,
  node: IpNode,
  ip: Ipv4Pdu,
  local?: 'local-host-unreachable',
): void {
  if (local) {
    const own = ip.payload;
    const from = node.ifaces[0]?.ip ?? ip.src;
    if (own.id >= TRACE_BASE) {
      const tr = node.cfg.traces.find((t) => t.id === own.id - TRACE_BASE);
      if (tr) tr.done = true;
      return;
    }
    const res = findPing(node, own.id, own.seq);
    if (res) {
      ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
      failPing(ctx, res, 'ping.hostUnreachable', ip.dst, from);
    }
    return;
  }
  const icmp = ip.payload;
  if (!icmp.orig) return;
  const { icmpId, icmpSeq } = icmp.orig;
  if (icmpId >= TRACE_BASE) {
    traceResponse(
      ctx,
      node,
      icmpId,
      icmpSeq,
      ip.src,
      icmp.type === 'time-exceeded' ? 'hop' : 'unreachable',
    );
    return;
  }
  const res = findPing(node, icmpId, icmpSeq);
  if (!res || res.status !== 'pending') return;
  ctx.cancelTimer(`ping-timeout:${res.id}:${res.seq}`);
  failPing(ctx, res, errorNote(icmp.type, icmp.code), res.dst, ip.src);
}

// ------------------------------------------------------------------ Timer

export function diagTimer(ctx: DeviceCtx, node: IpNode, name: string): boolean {
  const cfg = node.cfg;
  if (name.startsWith('ping-timeout:')) {
    const [, id, seq] = name.split(':');
    const res = findPing(node, Number(id), Number(seq));
    if (res && res.status === 'pending') {
      res.status = 'timeout';
      ctx.log({
        kind: 'ping',
        proto: 'ICMP',
        status: 'error',
        msg: { key: 'ping.timeout', params: { ip: res.dst, seq: res.seq } },
      });
    }
    return true;
  }
  if (name.startsWith('ping:')) {
    const id = Number(name.slice(5));
    if (cfg.pingSessions.some((x) => x.id === id)) sendPingSeq(ctx, node, id);
    else ctx.cancelTimer(name);
    return true;
  }
  if (name.startsWith('trace-timeout:')) {
    const [, id, ttl, p] = name.split(':').map(Number);
    const tr = cfg.traces.find((t) => t.id === id);
    const probe = tr?.hops[(ttl as number) - 1]?.probes[p as number];
    if (tr && probe && probe.status === 'pending') {
      probe.status = 'timeout';
      if (ttl === tr.ttl) advanceTrace(ctx, node, tr);
    }
    return true;
  }
  return false;
}
