import {
  pduSize,
  type Ipv4Addr,
  type Ipv4Pdu,
  type SvcPdu,
  type SvcProto,
  type TcpFlags,
  type TcpPdu,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import { ipSend, newIpPacket, type Base, type IpNode } from '../l3';
import type { AppConn } from '../p5types';
import type { Device } from '../types';
import { appcOf } from './node';

/** Reservierte TCP-Ports der Dienste. */
export const TCP_PORT: Partial<Record<SvcProto, number>> = {
  ftp: 21,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  pop3: 110,
};
const PORT_PROTO = new Map<number, SvcProto>(
  Object.entries(TCP_PORT).map(([p, n]) => [n as number, p as SvcProto]),
);

const SYN_RTO_US = 1_000_000;
const MAX_SYN_RETRIES = 3;
const REQ_TIMEOUT_US = 8_000_000;
const WINDOW = 8192;

export type SvcReply =
  { op: string; args?: SvcPdu['args']; body?: string; close?: boolean } | undefined;

/** Serverseitiges Verhalten eines TCP-Dienstes. */
/** Meldet Abschluss (`reply`) bzw. Fehler (`fail`) einer Client-Verbindung an die Anwendung. */
export type ClientHook = (
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  event: 'reply' | 'fail',
) => void;

export interface TcpServer {
  /** Banner (→ SYN-ACK) oder `'refuse'` (→ RST). */
  accept(ctx: DeviceCtx, dev: Device, node: IpNode, conn: AppConn): SvcReply | 'refuse';
  handle(ctx: DeviceCtx, dev: Device, node: IpNode, conn: AppConn, msg: SvcPdu): SvcReply;
  closed?(ctx: DeviceCtx, dev: Device, conn: AppConn): void;
}

const flags = (f: Partial<TcpFlags>): TcpFlags => ({
  syn: false,
  ack: false,
  fin: false,
  rst: false,
  psh: false,
  ...f,
});

const keyOf = (lport: number, raddr: Ipv4Addr, rport: number): string =>
  `${lport}>${raddr}:${rport}`;
export const connKey = (c: AppConn): string => keyOf(c.lport, c.raddr, c.rport);

function seg(
  ctx: DeviceCtx,
  node: IpNode,
  src: Ipv4Addr,
  dst: Ipv4Addr,
  c: Pick<AppConn, 'lport' | 'rport'>,
  f: Partial<TcpFlags>,
  seq: number,
  ack: number,
  app?: SvcPdu,
): void {
  const pkt = newIpPacket(node, src, dst, {
    kind: 'tcp',
    srcPort: c.lport,
    dstPort: c.rport,
    flags: flags(f),
    seq,
    ack,
    window: WINDOW,
    dataSize: 0,
    app,
  });
  ipSend(ctx, node, pkt);
}

const svcMsg = (proto: SvcProto, r: NonNullable<SvcReply>): SvcPdu => ({
  kind: 'svc',
  proto,
  op: r.op,
  args: r.args ?? {},
  body: r.body,
});

// ---------------------------------------------------------------- Client

/** Verbindung öffnen (SYN). Ergebnis später in `appc.conns[key]` (`state`, `banner`, `err`). */
export function connOpen(
  ctx: DeviceCtx,
  node: IpNode,
  o: { dst: Ipv4Addr; proto: SvcProto; port?: number },
): { ok: true; key: string; id: number } | { ok: false; error: string } {
  const core = appcOf(node.cfg);
  const hop = node.lookup(o.dst);
  if (!hop) return { ok: false, error: 'conn.unreachable' };
  const rport = o.port ?? TCP_PORT[o.proto] ?? 0;
  const lport = core.nextPort++;
  const c: AppConn = {
    id: core.nextConn++,
    role: 'c',
    proto: o.proto,
    state: 'syn-sent',
    lport,
    raddr: o.dst,
    rport,
    seq: 1000 + core.nextConn * 100,
    ack: 0,
    retries: 0,
    replySeq: 0,
    waiting: true,
  };
  const key = connKey(c);
  core.conns[key] = c;
  sendSyn(ctx, node, c, hop.iface.ip);
  return { ok: true, key, id: c.id };
}

function sendSyn(ctx: DeviceCtx, node: IpNode, c: AppConn, src: Ipv4Addr): void {
  seg(ctx, node, src, c.raddr, c, { syn: true }, c.seq, 0);
  ctx.setTimer(`svc:syn:${connKey(c)}`, SYN_RTO_US);
}

/** Anfrage auf einer offenen Verbindung senden; die Antwort landet in `conn.reply`. */
export function connSend(
  ctx: DeviceCtx,
  node: IpNode,
  key: string,
  op: string,
  args: SvcPdu['args'] = {},
  body?: string,
): boolean {
  const c = appcOf(node.cfg).conns[key];
  if (c?.state !== 'open' || c.role !== 'c') return false;
  const hop = node.lookup(c.raddr);
  if (!hop) {
    c.state = 'failed';
    c.err = 'conn.unreachable';
    return false;
  }
  const msg: SvcPdu = { kind: 'svc', proto: c.proto, op, args, body };
  c.waiting = true;
  c.reply = undefined;
  seg(ctx, node, hop.iface.ip, c.raddr, c, { ack: true, psh: true }, c.seq, c.ack, msg);
  c.seq += pduSize(msg);
  ctx.setTimer(`svc:areq:${key}`, REQ_TIMEOUT_US);
  return true;
}

/** Antwort des Servers auf eine Anfrage nachträglich senden (z. B. nach RADIUS-Antwort). */
export function serverPush(
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  r: NonNullable<SvcReply>,
): void {
  const hop = node.lookup(c.raddr);
  if (!hop) return;
  const msg = svcMsg(c.proto, r);
  seg(
    ctx,
    node,
    hop.iface.ip,
    c.raddr,
    c,
    { ack: true, psh: true, fin: r.close },
    c.seq,
    c.ack,
    msg,
  );
  c.seq += pduSize(msg);
}

/** Verbindung beenden (FIN). */
export function connClose(ctx: DeviceCtx, node: IpNode, key: string): void {
  const core = appcOf(node.cfg);
  const c = core.conns[key];
  if (!c) return;
  const hop = node.lookup(c.raddr);
  if (c.state === 'open' && hop) {
    const msg: SvcPdu = { kind: 'svc', proto: c.proto, op: 'quit', args: {} };
    seg(ctx, node, hop.iface.ip, c.raddr, c, { ack: true, fin: true }, c.seq, c.ack, msg);
  }
  ctx.cancelTimer(`svc:areq:${key}`);
  ctx.cancelTimer(`svc:syn:${key}`);
  delete core.conns[key];
}

/** Timer `syn:<key>` / `areq:<key>`. */
export function connTimer(ctx: DeviceCtx, node: IpNode, name: string, hook?: ClientHook): boolean {
  const core = appcOf(node.cfg);
  if (name.startsWith('syn:')) {
    const c = core.conns[name.slice(4)];
    if (c?.state !== 'syn-sent') return true;
    if (++c.retries > MAX_SYN_RETRIES) {
      c.state = 'failed';
      c.err = 'conn.timeout';
      c.waiting = false;
      hook?.(ctx, node, c, 'fail');
    } else {
      const hop = node.lookup(c.raddr);
      if (hop) sendSyn(ctx, node, c, hop.iface.ip);
      else {
        c.state = 'failed';
        c.err = 'conn.unreachable';
        c.waiting = false;
        hook?.(ctx, node, c, 'fail');
      }
    }
    return true;
  }
  if (name.startsWith('areq:')) {
    const c = core.conns[name.slice(5)];
    if (c?.waiting && c.state === 'open') {
      c.state = 'failed';
      c.err = 'conn.timeout';
      c.waiting = false;
      hook?.(ctx, node, c, 'fail');
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- Empfang

/** TCP-Segment verarbeiten; `true` = von der Dienstschicht verbraucht. */
export function tcpRxSvc(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  t: TcpPdu,
  servers: Partial<Record<SvcProto, TcpServer>>,
  hook?: ClientHook,
): boolean {
  const core = appcOf(node.cfg);
  const key = keyOf(t.dstPort, ip.src, t.srcPort);
  const c = core.conns[key];
  const dev = ctx.device;
  const app = t.app?.kind === 'svc' ? t.app : undefined;
  const log = (
    k: string,
    status: 'ok' | 'drop' | 'info' = 'ok',
    params: Record<string, string | number> = {},
  ): void =>
    ctx.log({ ...base, kind: status === 'drop' ? 'drop' : 'rx', status, msg: { key: k, params } });
  const self = ip.dst;
  const me = { lport: t.dstPort, rport: t.srcPort };

  // --- Client-Verbindung
  if (c?.role === 'c') {
    if (c.state === 'syn-sent') {
      if (t.flags.rst) {
        ctx.cancelTimer(`svc:syn:${key}`);
        c.state = 'failed';
        c.err = 'conn.refused';
        c.waiting = false;
        log('tcp.refused', 'drop', { port: t.srcPort });
        hook?.(ctx, node, c, 'fail');
        return true;
      }
      if (t.flags.syn && t.flags.ack) {
        ctx.cancelTimer(`svc:syn:${key}`);
        c.state = 'open';
        c.seq = t.ack;
        c.ack = t.seq + 1;
        c.banner = app;
        c.waiting = false;
        log('tcp.established', 'ok', { peer: ip.src, port: t.srcPort });
        seg(ctx, node, self, ip.src, me, { ack: true }, c.seq, c.ack);
        if (c.first) connSend(ctx, node, key, c.first.op, c.first.args, c.first.body);
        return true;
      }
      return true;
    }
    if (t.flags.rst || t.flags.fin) {
      c.state = 'failed';
      c.err = 'conn.closed';
      c.waiting = false;
      ctx.cancelTimer(`svc:areq:${key}`);
      hook?.(ctx, node, c, 'fail');
      return true;
    }
    if (c.state === 'open' && app) {
      c.reply = app;
      c.replySeq++;
      c.waiting = false;
      c.ack = t.seq + pduSize(app);
      ctx.cancelTimer(`svc:areq:${key}`);
      log('svc.reply', 'ok', { proto: app.proto.toUpperCase(), op: app.op });
      hook?.(ctx, node, c, 'reply');
      return true;
    }
    return true;
  }

  // --- Server-Verbindung
  if (c?.role === 's') {
    const server = servers[c.proto];
    if (t.flags.fin || t.flags.rst) {
      server?.closed?.(ctx, dev, c);
      delete core.conns[key];
      log('tcp.closed', 'info', { peer: ip.src });
      if (t.flags.fin && !t.flags.rst)
        seg(ctx, node, self, ip.src, me, { ack: true, fin: true }, c.seq, t.seq + 1);
      return true;
    }
    if (app && server) {
      c.ack = t.seq + pduSize(app);
      log('svc.request', 'ok', { proto: app.proto.toUpperCase(), op: app.op });
      const r = server.handle(ctx, dev, node, c, app);
      if (r) {
        const msg = svcMsg(c.proto, r);
        seg(ctx, node, self, ip.src, me, { ack: true, psh: true, fin: r.close }, c.seq, c.ack, msg);
        c.seq += pduSize(msg);
        if (r.close) {
          server.closed?.(ctx, dev, c);
          delete core.conns[key];
        }
      }
      return true;
    }
    return true;
  }

  // --- Neue Verbindung zu einem Dienst-Port
  const proto = PORT_PROTO.get(t.dstPort);
  if (!proto || !(t.flags.syn && !t.flags.ack)) return false;
  const server = servers[proto];
  const conn: AppConn = {
    id: core.nextConn++,
    role: 's',
    proto,
    state: 'open',
    lport: t.dstPort,
    raddr: ip.src,
    rport: t.srcPort,
    seq: 5000 + core.nextConn * 100,
    ack: t.seq + 1,
    retries: 0,
    replySeq: 0,
    waiting: false,
  };
  const banner = server ? server.accept(ctx, dev, node, conn) : 'refuse';
  if (banner === 'refuse' || !banner) {
    log('tcp.rst', 'drop', { port: t.dstPort });
    seg(ctx, node, self, ip.src, me, { rst: true, ack: true }, 0, t.seq + 1);
    return true;
  }
  core.conns[key] = conn;
  log('tcp.syn', 'ok', { peer: ip.src, port: t.dstPort });
  const msg = svcMsg(proto, banner);
  seg(ctx, node, self, ip.src, me, { syn: true, ack: true }, conn.seq, conn.ack, msg);
  conn.seq += 1;
  return true;
}
