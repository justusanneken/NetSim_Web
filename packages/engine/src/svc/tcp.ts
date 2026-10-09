import type { HttpPdu, Ipv4Addr, Ipv4Pdu, TcpFlags, TcpPdu } from '@netsim/protocols';
import { isValidIpv4 } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import { ipSend, newIpPacket, type Base, type IpNode } from '../l3';
import type { HostConfig, HttpRequest, TcpConn } from '../types';
import { nextEphemeral } from '../ports';
import { dnsResolve } from './dns';

const RTO_US = 1_000_000;
const MAX_SYN_RETRIES = 3;
const WINDOW = 8192;

const flags = (f: Partial<TcpFlags>): TcpFlags => ({
  syn: false,
  ack: false,
  fin: false,
  rst: false,
  psh: false,
  ...f,
});

const key = (lport: number, raddr: Ipv4Addr, rport: number): string => `${lport}>${raddr}:${rport}`;

function segment(
  ctx: DeviceCtx,
  node: IpNode,
  src: Ipv4Addr,
  dst: Ipv4Addr,
  seg: Omit<TcpPdu, 'kind' | 'window' | 'dataSize'> & { dataSize?: number },
): void {
  const pkt = newIpPacket(node, src, dst, { kind: 'tcp', window: WINDOW, dataSize: 0, ...seg });
  ipSend(ctx, node, pkt);
}

function finish(h: HostConfig, req: HttpRequest | undefined, patch: Partial<HttpRequest>): void {
  if (req) Object.assign(req, patch);
  void h;
}

const reqOf = (h: HostConfig, id: number | undefined): HttpRequest | undefined =>
  h.requests.find((r) => r.id === id);

// ------------------------------------------------------------------ Client (HTTP)

export function parseUrl(url: string): {
  https: boolean;
  host: string;
  port: number;
  path: string;
} {
  const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url.trim());
  const https = m?.[1]?.toLowerCase() === 'https';
  return {
    https,
    host: m?.[2] ?? url,
    port: m?.[3] ? Number(m[3]) : https ? 443 : 80,
    path: m?.[4] ?? '/',
  };
}

export function httpGet(ctx: DeviceCtx, node: IpNode, h: HostConfig, url: string): number {
  const u = parseUrl(url);
  const req: HttpRequest = {
    id: h.nextReqId++,
    url,
    host: u.host,
    path: u.path,
    https: u.https,
    status: 'resolving',
    startedAt: ctx.now,
  };
  h.requests.push(req);
  if (h.requests.length > 20) h.requests.shift();
  if (isValidIpv4(u.host)) connect(ctx, node, h, req, u.host, u.port);
  else {
    const r = dnsResolve(ctx, node, h, u.host, req.id);
    if (r.error) Object.assign(req, { status: 'failed', error: r.error });
    else if (r.cached) connect(ctx, node, h, req, r.cached, u.port);
  }
  return req.id;
}

/** Namensauflösung abgeschlossen: weiterverbinden bzw. Fehler melden. */
export function onDnsDone(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  reqId: number | undefined,
  addr: Ipv4Addr | undefined,
  error: string | undefined,
): void {
  const req = reqOf(h, reqId);
  if (!req || req.status !== 'resolving') return;
  if (!addr) return finish(h, req, { status: 'failed', error: error ?? 'http.err.dns' });
  connect(ctx, node, h, req, addr, parseUrl(req.url).port);
}

function connect(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  req: HttpRequest,
  addr: Ipv4Addr,
  rport: number,
): void {
  req.addr = addr;
  req.status = 'connecting';
  const lport = nextEphemeral(h, (p) => Object.values(h.tcp).some((x) => x.lport === p));
  const c: TcpConn = {
    state: 'syn-sent',
    lport,
    raddr: addr,
    rport,
    seq: h.nextIsn,
    ack: 0,
    pending: { host: req.host, path: req.path, reqId: req.id },
    retries: 0,
  };
  h.nextIsn += 1000;
  h.tcp[key(lport, addr, rport)] = c;
  sendSyn(ctx, node, h, c);
}

function sendSyn(ctx: DeviceCtx, node: IpNode, h: HostConfig, c: TcpConn): void {
  const hop = node.lookup(c.raddr);
  if (!hop) {
    failConn(h, c, 'http.err.unreachable');
    return;
  }
  segment(ctx, node, hop.iface.ip, c.raddr, {
    srcPort: c.lport,
    dstPort: c.rport,
    flags: flags({ syn: true }),
    seq: c.seq,
    ack: 0,
  });
  ctx.setTimer(`tcp-syn:${key(c.lport, c.raddr, c.rport)}`, RTO_US);
}

function failConn(h: HostConfig, c: TcpConn, error: string): void {
  c.state = 'closed';
  delete h.tcp[key(c.lport, c.raddr, c.rport)];
  finish(h, reqOf(h, c.pending?.reqId), { status: 'failed', error });
}

export function tcpTimer(ctx: DeviceCtx, node: IpNode, h: HostConfig, name: string): boolean {
  if (!name.startsWith('tcp-syn:')) return false;
  const c = h.tcp[name.slice(8)];
  if (!c || c.state !== 'syn-sent') return true;
  if (++c.retries > MAX_SYN_RETRIES) failConn(h, c, 'http.err.timeout');
  else sendSyn(ctx, node, h, c);
  return true;
}

/** ICMP-Fehler zu einem eigenen TCP-Segment. */
export function tcpIcmpError(
  h: HostConfig,
  orig: { dst: Ipv4Addr; sport?: number; dport?: number },
  blocked: boolean,
): void {
  if (orig.sport === undefined || orig.dport === undefined) return;
  const c = h.tcp[key(orig.sport, orig.dst, orig.dport)];
  if (c) failConn(h, c, blocked ? 'http.err.blocked' : 'http.err.unreachable');
}

// ------------------------------------------------------------------ Empfang (Client + Server)

export function tcpRx(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  t: TcpPdu,
): void {
  const k = key(t.dstPort, ip.src, t.srcPort);
  const c = h.tcp[k];
  const ta = t.app?.kind === 'http' ? t.app : undefined;
  const log = (
    kk: string,
    status: 'ok' | 'drop' | 'info' = 'ok',
    params: Record<string, string | number> = {},
  ): void =>
    ctx.log({ ...base, kind: status === 'drop' ? 'drop' : 'rx', status, msg: { key: kk, params } });
  const reply = (f: Partial<TcpFlags>, seq: number, ack: number, app?: HttpPdu): void =>
    segment(ctx, node, iface.ip, ip.src, {
      srcPort: t.dstPort,
      dstPort: t.srcPort,
      flags: flags(f),
      seq,
      ack,
      app,
    });

  // Aktive Verbindung (Client) --------------------------------------------------
  if (c?.state === 'syn-sent') {
    if (t.flags.rst) {
      ctx.cancelTimer(`tcp-syn:${k}`);
      log('tcp.refused', 'drop', { port: t.srcPort });
      failConn(h, c, 'http.err.refused');
      return;
    }
    if (t.flags.syn && t.flags.ack) {
      ctx.cancelTimer(`tcp-syn:${k}`);
      c.state = 'established';
      c.seq = t.ack;
      c.ack = t.seq + 1;
      log('tcp.established', 'ok', { peer: ip.src, port: t.srcPort });
      const req = reqOf(h, c.pending?.reqId);
      if (req) req.status = 'waiting';
      const get: HttpPdu = {
        kind: 'http',
        method: 'GET',
        path: c.pending?.path ?? '/',
        host: c.pending?.host ?? '',
      };
      segment(ctx, node, iface.ip, ip.src, {
        srcPort: c.lport,
        dstPort: c.rport,
        flags: flags({ ack: true, psh: true }),
        seq: c.seq,
        ack: c.ack,
        app: get,
        dataSize: 0,
      });
      return;
    }
  }
  if (c?.state === 'established') {
    if (ta && ta.status !== undefined && !ta.method) {
      const req = reqOf(h, c.pending?.reqId);
      finish(h, req, { status: 'done', code: ta.status, body: ta.body ?? '' });
      log('http.response', 'ok', { code: ta.status });
      reply({ ack: true, fin: true }, t.ack, t.seq + 1);
      delete h.tcp[k];
      return;
    }
    if (ta?.method === 'GET' && c.pending === undefined) {
      serveHttp(ctx, node, h, iface, ip, t, c, log);
      return;
    }
    if (t.flags.fin) {
      reply({ ack: true }, t.ack, t.seq + 1);
      delete h.tcp[k];
      log('tcp.closed', 'info', { peer: ip.src });
      return;
    }
    return;
  }

  // Passive Seite (Server) -------------------------------------------------------
  const svc = h.services.http;
  const listening = svc.enabled && (t.dstPort === 80 || (t.dstPort === 443 && svc.https));
  if (t.flags.syn && !t.flags.ack) {
    if (!listening) {
      log('tcp.rst', 'drop', { port: t.dstPort });
      reply({ rst: true, ack: true }, 0, t.seq + 1);
      return;
    }
    const isn = h.nextIsn;
    h.nextIsn += 1000;
    h.tcp[k] = {
      state: 'established',
      lport: t.dstPort,
      raddr: ip.src,
      rport: t.srcPort,
      seq: isn + 1,
      ack: t.seq + 1,
      retries: 0,
    };
    log('tcp.syn', 'ok', { peer: ip.src, port: t.dstPort });
    reply({ syn: true, ack: true }, isn, t.seq + 1);
    return;
  }
  if (t.flags.rst) return;
  log('tcp.unknown', 'drop', { peer: ip.src });
  reply({ rst: true }, t.ack, 0);
}

function serveHttp(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  iface: Iface,
  ip: Ipv4Pdu,
  t: TcpPdu,
  c: TcpConn,
  log: (k: string, s?: 'ok' | 'drop' | 'info', p?: Record<string, string | number>) => void,
): void {
  const path = (t.app?.kind === 'http' ? t.app.path : undefined) ?? '/';
  const page =
    h.services.http.pages[path] ??
    (path === '/index.html' ? h.services.http.pages['/'] : undefined);
  const resp: HttpPdu =
    page !== undefined
      ? { kind: 'http', status: 200, body: page }
      : { kind: 'http', status: 404, body: '<h1>404 Not Found</h1>' };
  log('http.request', 'ok', { path, code: resp.status ?? 0 });
  segment(ctx, node, iface.ip, ip.src, {
    srcPort: t.dstPort,
    dstPort: t.srcPort,
    flags: flags({ ack: true, psh: true, fin: true }),
    seq: c.seq,
    ack: t.seq + 1,
    app: resp,
  });
}
