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
import { nextEphemeral } from '../ports';

/**
 * Gemeinsames, wiederverwendbares simuliertes TCP für Geräte mit IP-Stack (Host, Router, Switch, Firewall).
 *
 * - Verbindungstabelle je Gerät: `appc.conns` (Schlüssel `lport>raddr:rport`), reines JSON.
 * - Dreiwege-Handshake, echte Sequenz-/Bestätigungsnummern, Nachrichtenstrom (`SvcPdu` je Segment).
 * - Zuverlässigkeit: Retransmission mit Timeout (RTO 1 s, verdoppelt bis 8 s) und begrenzten Wiederholungen,
 *   Duplikat-/Lückenerkennung beim Empfang, kumulative ACKs.
 * - Abbau per FIN bzw. RST (auch für Daten auf unbekannten Verbindungen).
 * - Alle Segmente laufen durch den normalen IP-Stack (ACL, NAT, Firewall sehen sie).
 */

/** Reservierte TCP-Ports der Dienste. */
export const TCP_PORT: Partial<Record<SvcProto, number>> = {
  ftp: 21,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  pop3: 110,
  tacacs: 49,
  bgp: 179,
};
const PORT_PROTO = new Map<number, SvcProto>(
  Object.entries(TCP_PORT).map(([p, n]) => [n as number, p as SvcProto]),
);

const SYN_RTO_US = 1_000_000;
const MAX_SYN_RETRIES = 3;
const REQ_TIMEOUT_US = 8_000_000;
const WINDOW = 8192;
/** Retransmission: Start-RTO 1 s, verdoppelt bis 8 s; nach 5 Wiederholungen (≈ 31 s) bricht die Verbindung ab. */
export const RTX_RTO_US = 1_000_000;
const RTX_MAX_RTO_US = 8_000_000;
export const RTX_MAX_TRIES = 5;

export type SvcReply =
  | {
      /** Leer = keine Anwendungsdaten (z. B. SYN-ACK ohne Banner). */
      op: string;
      args?: SvcPdu['args'];
      body?: string;
      close?: boolean;
      bgp?: SvcPdu['bgp'];
      encrypted?: boolean;
    }
  | undefined;

/** Meldet Öffnen (`open`), Nachricht (`reply`) bzw. Ende/Fehler (`fail`) einer Client-Verbindung an die Anwendung. */
export type ClientHook = (
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  event: 'open' | 'reply' | 'fail',
) => void;

/** Serverseitiges Verhalten eines TCP-Dienstes. */
export interface TcpServer {
  /** Banner (→ SYN-ACK) oder `'refuse'` (→ RST). */
  accept(ctx: DeviceCtx, dev: Device, node: IpNode, conn: AppConn): SvcReply | 'refuse';
  handle(ctx: DeviceCtx, dev: Device, node: IpNode, conn: AppConn, msg: SvcPdu): SvcReply;
  closed?(ctx: DeviceCtx, dev: Device, conn: AppConn): void;
}

export type TcpServers = Partial<Record<SvcProto, TcpServer>>;

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

/** Timername einer Verbindung (Hintergrund-Timer für BGP). */
const tn = (c: AppConn, kind: 'syn' | 'areq' | 'rtx'): string =>
  `${c.bg ? 'bg:' : ''}svc:${kind}:${connKey(c)}`;

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

/** Lokale Adresse einer Verbindung (explizit, sonst Adresse der Ausgangsschnittstelle). */
function localOf(node: IpNode, c: AppConn): Ipv4Addr | undefined {
  return c.laddr ?? node.lookup(c.raddr)?.iface.ip;
}

/** Segment auf einer Verbindung senden. */
function out(
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  f: Partial<TcpFlags>,
  seq: number,
  ack: number,
  app?: SvcPdu,
): boolean {
  const src = localOf(node, c);
  if (!src) return false;
  if (f.ack) c.sentAck = ack;
  seg(ctx, node, src, c.raddr, c, f, seq, ack, app);
  return true;
}

const svcMsg = (proto: SvcProto, r: NonNullable<SvcReply>): SvcPdu | undefined =>
  r.op === ''
    ? undefined
    : {
        kind: 'svc',
        proto,
        op: r.op,
        args: r.args ?? {},
        body: r.body,
        bgp: r.bgp,
        encrypted: r.encrypted ?? (proto === 'ssh' || undefined),
      };

// ---------------------------------------------------------------- Zuverlässige Datenübertragung

/** Anwendungsnachricht zuverlässig senden (Retransmission bis zur Bestätigung). */
export function sendData(
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  msg: SvcPdu | undefined,
  fin = false,
): boolean {
  const len = (msg ? pduSize(msg) : 0) + (fin ? 1 : 0);
  if (!out(ctx, node, c, { ack: true, psh: !!msg, fin }, c.seq, c.ack, msg)) return false;
  (c.rtx ??= []).push({ seq: c.seq, len, fin: fin || undefined, msg });
  c.seq += len;
  if (c.rtx.length === 1) {
    c.rto = RTX_RTO_US;
    c.tries = 0;
    ctx.setTimer(tn(c, 'rtx'), c.rto);
  }
  return true;
}

/** Bestätigungsnummer des Gegenübers verarbeiten: bestätigte Segmente aus der Warteschlange entfernen. */
function ackIn(ctx: DeviceCtx, c: AppConn, ack: number): void {
  if (!c.rtx?.length) return;
  const before = c.rtx.length;
  c.rtx = c.rtx.filter((r) => r.seq + r.len > ack);
  if (c.rtx.length === before) return;
  c.tries = 0;
  c.rto = RTX_RTO_US;
  if (c.rtx.length === 0) ctx.cancelTimer(tn(c, 'rtx'));
  else ctx.setTimer(tn(c, 'rtx'), RTX_RTO_US);
}

function pureAck(ctx: DeviceCtx, node: IpNode, c: AppConn): void {
  out(ctx, node, c, { ack: true }, c.seq, c.ack);
}

function tcpLog(ctx: DeviceCtx, key: string, params: Record<string, string | number>): void {
  ctx.log({ kind: 'info', proto: 'TCP', status: 'info', msg: { key, params } });
}

// ---------------------------------------------------------------- Client

/** Verbindung öffnen (SYN). Ergebnis später in `appc.conns[key]` (`state`, `banner`, `err`). */
export function connOpen(
  ctx: DeviceCtx,
  node: IpNode,
  o: { dst: Ipv4Addr; proto: SvcProto; port?: number; src?: Ipv4Addr; bg?: boolean },
): { ok: true; key: string; id: number } | { ok: false; error: string } {
  const core = appcOf(node.cfg);
  const hop = node.lookup(o.dst);
  if (!hop) return { ok: false, error: 'conn.unreachable' };
  const rport = o.port ?? TCP_PORT[o.proto] ?? 0;
  const lport = nextEphemeral(core, (p) => Object.values(core.conns).some((x) => x.lport === p));
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
    waiting: !o.bg,
    laddr: o.src ?? hop.iface.ip,
    bg: o.bg || undefined,
  };
  const key = connKey(c);
  core.conns[key] = c;
  sendSyn(ctx, node, c);
  return { ok: true, key, id: c.id };
}

function sendSyn(ctx: DeviceCtx, node: IpNode, c: AppConn): void {
  out(ctx, node, c, { syn: true }, c.seq, 0);
  ctx.setTimer(tn(c, 'syn'), SYN_RTO_US);
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
  if (!node.lookup(c.raddr)) {
    c.state = 'failed';
    c.err = 'conn.unreachable';
    return false;
  }
  const msg = svcMsg(c.proto, { op, args, body });
  c.waiting = true;
  c.reply = undefined;
  sendData(ctx, node, c, msg);
  // Telnet/SSH verlassen sich auf die Retransmission (Abbruch nach ≈ 31 s), die übrigen Dienste auf ein 8-s-Zeitlimit
  if (c.proto !== 'telnet' && c.proto !== 'ssh') ctx.setTimer(tn(c, 'areq'), REQ_TIMEOUT_US);
  return true;
}

/** Nachricht auf einer offenen Verbindung (Client oder Server) zuverlässig senden, ohne Antwort zu erwarten. */
export function connPush(
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  r: NonNullable<SvcReply>,
): boolean {
  if (c.state !== 'open') return false;
  return sendData(ctx, node, c, svcMsg(c.proto, r), !!r.close);
}

/** Antwort des Servers auf eine Anfrage nachträglich senden (z. B. nach RADIUS-Antwort). */
export function serverPush(
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  r: NonNullable<SvcReply>,
): void {
  sendData(ctx, node, c, svcMsg(c.proto, r), !!r.close);
}

function dropTimers(ctx: DeviceCtx, c: AppConn): void {
  ctx.cancelTimer(tn(c, 'areq'));
  ctx.cancelTimer(tn(c, 'syn'));
  ctx.cancelTimer(tn(c, 'rtx'));
}

/** Verbindung beenden (FIN). */
export function connClose(ctx: DeviceCtx, node: IpNode, key: string): void {
  const core = appcOf(node.cfg);
  const c = core.conns[key];
  if (!c) return;
  if (c.state === 'open') {
    const msg: SvcPdu = { kind: 'svc', proto: c.proto, op: 'quit', args: {} };
    out(ctx, node, c, { ack: true, fin: true }, c.seq, c.ack, msg);
  }
  dropTimers(ctx, c);
  delete core.conns[key];
}

/** Verbindung abbrechen (RST), z. B. wenn die Anwendung die Sitzung verwirft. */
export function connAbort(ctx: DeviceCtx, node: IpNode, key: string): void {
  const core = appcOf(node.cfg);
  const c = core.conns[key];
  if (!c) return;
  if (c.state === 'open' || c.state === 'syn-sent')
    out(ctx, node, c, { rst: true, ack: true }, c.seq, c.ack);
  dropTimers(ctx, c);
  delete core.conns[key];
}

function failClient(
  ctx: DeviceCtx,
  node: IpNode,
  c: AppConn,
  err: string,
  hook: ClientHook | undefined,
): void {
  c.state = 'failed';
  c.err = err;
  c.waiting = false;
  dropTimers(ctx, c);
  hook?.(ctx, node, c, 'fail');
}

/** Timer `syn:<key>` / `areq:<key>` / `rtx:<key>`. */
export function connTimer(
  ctx: DeviceCtx,
  node: IpNode,
  name: string,
  hook?: ClientHook,
  servers?: TcpServers,
): boolean {
  const core = appcOf(node.cfg);
  if (name.startsWith('syn:')) {
    const c = core.conns[name.slice(4)];
    if (c?.state !== 'syn-sent') return true;
    if (++c.retries > MAX_SYN_RETRIES) failClient(ctx, node, c, 'conn.timeout', hook);
    else if (node.lookup(c.raddr)) sendSyn(ctx, node, c);
    else failClient(ctx, node, c, 'conn.unreachable', hook);
    return true;
  }
  if (name.startsWith('areq:')) {
    const c = core.conns[name.slice(5)];
    if (c?.waiting && c.state === 'open') failClient(ctx, node, c, 'conn.timeout', hook);
    return true;
  }
  if (name.startsWith('rtx:')) {
    const key = name.slice(4);
    const c = core.conns[key];
    if (!c?.rtx?.length || c.state !== 'open') return true;
    c.tries = (c.tries ?? 0) + 1;
    if (c.tries > RTX_MAX_TRIES) {
      tcpLog(ctx, 'tcp.abort', { peer: c.raddr, port: c.rport });
      if (c.role === 'c') failClient(ctx, node, c, 'conn.timeout', hook);
      else {
        servers?.[c.proto]?.closed?.(ctx, ctx.device, c);
        dropTimers(ctx, c);
        delete core.conns[key];
      }
      return true;
    }
    c.rto = Math.min((c.rto ?? RTX_RTO_US) * 2, RTX_MAX_RTO_US);
    tcpLog(ctx, 'tcp.retransmit', { peer: c.raddr, port: c.rport, n: c.tries });
    for (const r of c.rtx)
      out(ctx, node, c, { ack: true, psh: !!r.msg, fin: !!r.fin }, r.seq, c.ack, r.msg);
    ctx.setTimer(tn(c, 'rtx'), c.rto);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- Empfang

/** TCP-Segment verarbeiten; `true` = von der Dienstschicht verbraucht. */
export function tcpRxSvc(
  ctx: DeviceCtx,
  node: IpNode,
  _iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  t: TcpPdu,
  servers: TcpServers,
  hook?: ClientHook,
): boolean {
  const core = appcOf(node.cfg);
  const key = keyOf(t.dstPort, ip.src, t.srcPort);
  let c: AppConn | undefined = core.conns[key];
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
  if (c && t.flags.ack && !t.flags.syn && !t.flags.rst) ackIn(ctx, c, t.ack);
  // Neuer SYN (andere Sequenznummer) auf dem Tupel einer verwaisten Serververbindung (Gegenstelle ohne FIN
  // verschwunden, lokaler Port nach dem Umlauf wiederverwendet): alte Verbindung verwerfen, neu annehmen
  if (c?.role === 's' && t.flags.syn && !t.flags.ack && t.seq + 1 !== c.ack) {
    servers[c.proto]?.closed?.(ctx, dev, c);
    dropTimers(ctx, c);
    delete core.conns[key];
    log('tcp.closed', 'info', { peer: ip.src });
    c = undefined;
  }

  // --- Client-Verbindung
  if (c?.role === 'c') {
    if (c.state === 'syn-sent') {
      if (t.flags.rst) {
        log('tcp.refused', 'drop', { port: t.srcPort });
        failClient(ctx, node, c, 'conn.refused', hook);
        return true;
      }
      if (t.flags.syn && t.flags.ack) {
        ctx.cancelTimer(tn(c, 'syn'));
        c.state = 'open';
        c.seq = t.ack;
        c.ack = t.seq + 1;
        c.banner = app;
        c.waiting = false;
        log('tcp.established', 'ok', { peer: ip.src, port: t.srcPort });
        out(ctx, node, c, { ack: true }, c.seq, c.ack);
        hook?.(ctx, node, c, 'open');
        if (c.first) connSend(ctx, node, key, c.first.op, c.first.args, c.first.body);
        return true;
      }
      return true;
    }
    if (c.state === 'open') {
      if (t.flags.rst) {
        failClient(ctx, node, c, 'conn.closed', hook);
        return true;
      }
      if (t.flags.syn && t.flags.ack) {
        pureAck(ctx, node, c); // SYN-ACK wiederholt: unser ACK ging verloren
        return true;
      }
      if (app || t.flags.fin) {
        if (t.seq !== c.ack) {
          pureAck(ctx, node, c); // Duplikat oder Lücke: aktuelle Bestätigung wiederholen
          return true;
        }
        const quit = app?.op === 'quit'; // FIN der Gegenseite (connClose) ohne Nutzdaten
        if (app) {
          c.ack = t.seq + pduSize(app);
          if (!quit) c.reply = app;
          c.replySeq++;
          c.waiting = false;
          ctx.cancelTimer(tn(c, 'areq'));
          if (!quit) log('svc.reply', 'ok', { proto: app.proto.toUpperCase(), op: app.op });
        }
        if (t.flags.fin) {
          c.ack += 1;
          c.state = 'closed';
          c.err = 'conn.closed';
          c.waiting = false;
          ctx.cancelTimer(tn(c, 'areq'));
        }
        if (app && !quit) hook?.(ctx, node, c, 'reply');
        else hook?.(ctx, node, c, 'fail');
        if (core.conns[key] === c && c.sentAck !== c.ack) pureAck(ctx, node, c);
      }
      return true;
    }
    if (t.flags.rst || t.flags.fin) failClient(ctx, node, c, 'conn.closed', hook);
    return true;
  }

  // --- Server-Verbindung
  if (c?.role === 's') {
    const server = servers[c.proto];
    if (t.flags.fin || t.flags.rst) {
      server?.closed?.(ctx, dev, c);
      dropTimers(ctx, c);
      delete core.conns[key];
      log('tcp.closed', 'info', { peer: ip.src });
      if (t.flags.fin && !t.flags.rst)
        seg(ctx, node, c.laddr ?? self, ip.src, me, { ack: true, fin: true }, c.seq, t.seq + 1);
      return true;
    }
    if (t.flags.syn && !t.flags.ack) {
      // SYN wiederholt: SYN-ACK noch einmal senden (solange noch nichts Weiteres gesendet wurde)
      if (c.rtx === undefined)
        out(ctx, node, c, { syn: true, ack: true }, c.seq - 1, c.ack, c.banner);
      return true;
    }
    if (app && server) {
      if (t.seq !== c.ack) {
        pureAck(ctx, node, c);
        return true;
      }
      c.ack = t.seq + pduSize(app);
      log('svc.request', 'ok', { proto: app.proto.toUpperCase(), op: app.op });
      const r = server.handle(ctx, dev, node, c, app);
      if (r) {
        sendData(ctx, node, c, svcMsg(c.proto, r), !!r.close);
        if (r.close) {
          server.closed?.(ctx, dev, c);
          dropTimers(ctx, c);
          delete core.conns[key];
        }
      } else if (core.conns[key] === c && c.sentAck !== c.ack) pureAck(ctx, node, c);
      return true;
    }
    return true;
  }

  // --- Neue Verbindung zu einem Dienst-Port
  const proto = PORT_PROTO.get(t.dstPort);
  if (!proto || !(t.flags.syn && !t.flags.ack)) {
    if (!t.flags.syn && (PORT_PROTO.has(t.dstPort) || PORT_PROTO.has(t.srcPort))) {
      // RST/FIN/reines ACK auf eine nicht (mehr) bestehende Dienstverbindung: still verwerfen
      if (!app || t.flags.rst || t.flags.fin) return true;
      // Daten für eine unbekannte Verbindung (Gegenstelle neu gestartet/Sitzung verworfen): RST
      log('tcp.rst', 'drop', { port: t.dstPort });
      seg(ctx, node, self, ip.src, me, { rst: true, ack: true }, t.ack, t.seq + pduSize(app));
      return true;
    }
    return false;
  }
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
    laddr: self,
    bg: proto === 'bgp' || undefined,
  };
  const banner = server ? server.accept(ctx, dev, node, conn) : 'refuse';
  if (banner === 'refuse' || !banner) {
    log('tcp.rst', 'drop', { port: t.dstPort });
    seg(ctx, node, self, ip.src, me, { rst: true, ack: true }, 0, t.seq + 1);
    return true;
  }
  core.conns[key] = conn;
  log('tcp.syn', 'ok', { peer: ip.src, port: t.dstPort });
  conn.banner = svcMsg(proto, banner);
  out(ctx, node, conn, { syn: true, ack: true }, conn.seq, conn.ack, conn.banner);
  conn.seq += 1;
  return true;
}
