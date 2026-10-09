import {
  ETHERTYPE,
  isBroadcastMac,
  parseIpv4,
  summarizeFrame,
  type Frame,
  type Ipv4Addr,
  type PppMsg,
  type PppoePdu,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { IpNode, XmitIface } from '../l3';
import { eth, ifaceFrameRx } from '../l3';
import { PPPOE_MTU } from '../pppifaces';
import { newPppRuntime, type PppRuntime, type PppSession } from '../pppTypes';
import type { L3Cfg, Port } from '../types';
import { cancelBg, rtOf, setBg, type Rt } from './core';
import type { L3Dev } from '../devices/l3dev';

/**
 * PPPoE (RFC 2516) und PPP (LCP, CHAP, IPCP) – vereinfacht. Discovery (PADI/PADO/PADR/PADS/PADT) und die
 * PPP-Aushandlung laufen als echte Frames (EtherType 0x8863/0x8864) über den Port; die Aushandlung ist je
 * Protokoll auf wenige Nachrichten verkürzt (siehe docs/simplifications.md).
 */

/** (nicht aus `core` importiert: Importzyklus über l3dev) */
const SEC = 1_000_000;
const DISC_RETRY = 6 * SEC;
const FAIL_HOLDOFF = 10 * SEC;
const BCAST = 'ff:ff:ff:ff:ff:ff';

export const pppOf = (cfg: L3Cfg): PppRuntime => (cfg.ppp ??= newPppRuntime());

const num = (ip: string): number => parseIpv4(ip) ?? 0;
const ipStr = (n: number): Ipv4Addr =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Deterministischer „Hash“ (kein MD5): Digest der CHAP-Antwort. */
export function chapDigest(id: number, secret: string, challenge: string): string {
  let h1 = 2166136261;
  let h2 = 5381;
  for (const ch of `${id}|${secret}|${challenge}`) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + ch.charCodeAt(0)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

const portOf = (rt: Rt, id: string): Port | undefined => rt.dev.ports.find((p) => p.id === id);

// ------------------------------------------------------------------ Senden

function sendFrame(rt: Rt, portId: string, dst: string, pdu: PppoePdu): void {
  const port = portOf(rt, portId);
  if (!port?.operUp) return;
  const f: Frame = {
    kind: 'ethernet',
    src: port.mac,
    dst,
    etherType: pdu.code === 'SESSION' ? ETHERTYPE.pppoeSession : ETHERTYPE.pppoeDiscovery,
    payload: pdu,
  };
  rt.ctx.send(portId, f, rt.ctx.processingUs);
}

const sendPpp = (rt: Rt, s: PppSession, ppp: PppMsg): void =>
  sendFrame(rt, s.portId, s.peerMac, {
    kind: 'pppoe',
    code: 'SESSION',
    sessionId: s.sessionId,
    ppp,
  });

const lcpReq = (rt: Rt, s: PppSession): void =>
  sendPpp(rt, s, {
    proto: 'lcp',
    op: 'conf-req',
    mru: PPPOE_MTU,
    auth: s.role === 'server' ? 'chap' : undefined,
    magic: 0x1000 + s.sessionId,
  });

// ------------------------------------------------------------------ Logging

function log(
  rt: Rt,
  key: string,
  params: Record<string, string | number>,
  status: 'ok' | 'info' | 'error' = 'info',
): void {
  rt.ctx.log({ kind: 'info', proto: 'PPP', status, msg: { key, params } });
}

// ------------------------------------------------------------------ Sitzungen

function kill(rt: Rt, s: PppSession, padt: boolean, why: string, holdoffUs = 0): void {
  const st = pppOf(rt.cfg);
  if (padt && s.sessionId && s.peerMac)
    sendFrame(rt, s.portId, s.peerMac, { kind: 'pppoe', code: 'PADT', sessionId: s.sessionId });
  delete st.sessions[s.key];
  const wasUp = s.state === 'up';
  log(rt, wasUp ? 'ppp.down' : 'ppp.aborted', {
    iface: rt.ctx.deviceIfaceName(s.ifaceId),
    reason: why,
  });
  if (s.role === 'client') {
    s.lastError = why;
    (st.errors ??= {})[s.ifaceId] = why;
    if (holdoffUs) (st.holdoff ??= {})[s.ifaceId] = rt.ctx.now + holdoffUs;
    setBg(rt, `rt:ppp:disc:${s.ifaceId}`, Math.max(holdoffUs, 2 * SEC));
  }
  setBg(rt, 'rt:recompute', 1000);
  rt.ctx.requestRefresh();
}

function goUp(rt: Rt, s: PppSession): void {
  s.state = 'up';
  s.since = rt.ctx.now;
  if (s.role === 'client') cancelBg(rt, `rt:ppp:disc:${s.ifaceId}`);
  log(
    rt,
    'ppp.up',
    {
      iface: rt.ctx.deviceIfaceName(s.ifaceId),
      local: s.localIp ?? '',
      peer: s.peerIp ?? '',
      user: s.user ?? '',
    },
    'ok',
  );
  setBg(rt, 'rt:recompute', 1000);
  rt.ctx.requestRefresh();
}

/** Der Client-Dialer zu einem Port: Port mit `pppoe-client dial-pool-number N`, dazu der Dialer mit `dialer pool N`. */
function clientPortFor(rt: Rt, pool: number): Port | undefined {
  return rt.dev.ports.find(
    (p) => rt.cfg.ifaces[p.id]?.pppoeClientPool === pool && p.adminUp && p.operUp,
  );
}

function startDiscovery(rt: Rt, dialerId: string, port: Port): void {
  const st = pppOf(rt.cfg);
  const s: PppSession = {
    key: dialerId,
    role: 'client',
    portId: port.id,
    ifaceId: dialerId,
    peerMac: '',
    sessionId: 0,
    state: 'discovery',
    lcpOwn: false,
    lcpPeer: false,
    chapId: 0,
    since: rt.ctx.now,
    inPkts: 0,
    outPkts: 0,
  };
  st.sessions[dialerId] = s;
  sendFrame(rt, port.id, BCAST, {
    kind: 'pppoe',
    code: 'PADI',
    sessionId: 0,
    serviceName: '',
    hostUniq: `${rt.dev.name}-${dialerId}`,
  });
  setBg(rt, `rt:ppp:disc:${dialerId}`, DISC_RETRY);
}

/** Konfiguration/Link geändert: Clients starten bzw. beenden, Server-Sitzungen auf verschwundene Ports bereinigen. */
export function pppoeSync(rt: Rt): void {
  const st = rt.cfg.ppp;
  const dialers = Object.entries(rt.cfg.ifaces).filter(([, c]) => c.kind === 'dialer');
  if (!st && dialers.length === 0) return;
  const state = pppOf(rt.cfg);
  for (const [id, c] of dialers) {
    const d = c.dialer;
    const s = state.sessions[id];
    const port = d ? clientPortFor(rt, d.pool) : undefined;
    const want = !!d && !c.shutdown && !!port;
    if (!want || !port) {
      if (s) kill(rt, s, true, c.shutdown ? 'shutdown' : 'link down');
      continue;
    }
    if (s && s.portId !== port.id) kill(rt, s, true, 'port changed');
    if (!state.sessions[id] && (state.holdoff?.[id] ?? 0) <= rt.ctx.now)
      startDiscovery(rt, id, port);
  }
  for (const s of Object.values(state.sessions)) {
    const port = portOf(rt, s.portId);
    if (s.role === 'client' && !rt.cfg.ifaces[s.ifaceId]) kill(rt, s, true, 'removed');
    else if (s.role === 'server' && (!port?.operUp || !rt.cfg.ifaces[s.portId]?.pppoeGroup))
      kill(rt, s, !!port?.operUp, 'link down');
  }
}

export function pppoeStop(rt: Rt): void {
  for (const id of Object.keys(rt.cfg.ifaces)) cancelBg(rt, `rt:ppp:disc:${id}`);
}

export function pppoeReset(cfg: L3Cfg): void {
  cfg.ppp = undefined;
}

/** `clear pppoe all`: alle Sitzungen beenden (Clients wählen sich neu ein). */
export function pppoeClear(rt: Rt): void {
  for (const s of Object.values(pppOf(rt.cfg).sessions)) kill(rt, s, true, 'cleared');
}

export function pppTimer(rt: Rt, name: string): boolean {
  if (!name.startsWith('rt:ppp:')) return false;
  const id = name.slice('rt:ppp:disc:'.length);
  const s = rt.cfg.ppp?.sessions[id];
  if (s?.state === 'up') return true;
  if (s) kill(rt, s, true, 'timeout');
  if (rt.cfg.ppp?.holdoff) delete rt.cfg.ppp.holdoff[id];
  pppoeSync(rt);
  return true;
}

// ------------------------------------------------------------------ Server: Adressvergabe

function templateOf(rt: Rt, portId: string) {
  const group = rt.cfg.ifaces[portId]?.pppoeGroup;
  const bba = group ? rt.cfg.bba?.[group] : undefined;
  if (!bba?.template) return undefined;
  const ic = rt.cfg.ifaces[`vt${bba.template}`];
  return ic?.vtemplate ? { ...ic.vtemplate, ip: ic.ip } : undefined;
}

function localAddr(rt: Rt, t: NonNullable<ReturnType<typeof templateOf>>): Ipv4Addr {
  if (t.ip) return t.ip;
  const u = t.unnumbered ? rt.node.ifaces.find((i) => i.id === t.unnumbered) : undefined;
  return u?.ip ?? rt.node.ifaces[0]?.ip ?? '0.0.0.0';
}

function allocate(rt: Rt, poolName: string | undefined, self: PppSession): Ipv4Addr | undefined {
  const pool = poolName ? rt.cfg.ipPools?.[poolName] : undefined;
  if (!pool) return undefined;
  const used = new Set(
    Object.values(pppOf(rt.cfg).sessions)
      .filter((x) => x !== self && x.role === 'server' && x.peerIp)
      .map((x) => x.peerIp),
  );
  for (let n = num(pool.start); n <= num(pool.end); n++) if (!used.has(ipStr(n))) return ipStr(n);
  return undefined;
}

// ------------------------------------------------------------------ Empfang

const find = (rt: Rt, portId: string, sid: number, mac: string): PppSession | undefined =>
  Object.values(pppOf(rt.cfg).sessions).find(
    (s) => s.portId === portId && s.sessionId === sid && s.peerMac === mac,
  );

/** PPPoE-Frame an einem Router-Port. */
export function pppoeRx(
  ctx: DeviceCtx,
  dev: L3Dev,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const p = frame.payload;
  if (p.kind !== 'pppoe') return;
  const rt = rtOf(ctx, dev);
  const { proto, info } = summarizeFrame(frame);
  const logRx = (key: string, params: Record<string, string | number> = {}): void =>
    ctx.log({
      kind: 'rx',
      proto,
      status: 'ok',
      from: fromId,
      port: ctx.port(portId),
      frame,
      summary: info,
      msg: { key, params },
    });
  const st = pppOf(rt.cfg);

  // ---- Discovery
  if (p.code === 'PADI') {
    if (!templateOf(rt, portId) || !isBroadcastMac(frame.dst)) return;
    logRx('pppoe.padi', { mac: frame.src });
    sendFrame(rt, portId, frame.src, {
      kind: 'pppoe',
      code: 'PADO',
      sessionId: 0,
      serviceName: p.serviceName ?? '',
      acName: rt.dev.config.sys.hostname,
      hostUniq: p.hostUniq,
    });
    return;
  }
  if (p.code === 'PADO') {
    const s = Object.values(st.sessions).find(
      (x) => x.role === 'client' && x.portId === portId && x.state === 'discovery',
    );
    if (!s) return;
    logRx('pppoe.pado', { ac: p.acName ?? '' });
    s.peerMac = frame.src;
    s.state = 'padr';
    sendFrame(rt, portId, frame.src, {
      kind: 'pppoe',
      code: 'PADR',
      sessionId: 0,
      serviceName: p.serviceName ?? '',
      hostUniq: p.hostUniq,
    });
    return;
  }
  if (p.code === 'PADR') {
    const t = templateOf(rt, portId);
    if (!t) return;
    logRx('pppoe.padr', { mac: frame.src });
    for (const old of Object.values(st.sessions))
      if (old.role === 'server' && old.portId === portId && old.peerMac === frame.src)
        kill(rt, old, false, 'new session');
    const sid = st.nextSession++;
    const s: PppSession = {
      key: `s${sid}`,
      role: 'server',
      portId,
      ifaceId: `va${st.nextVa++}`,
      peerMac: frame.src,
      sessionId: sid,
      state: 'lcp',
      lcpOwn: false,
      lcpPeer: false,
      chapId: 0,
      since: ctx.now,
      inPkts: 0,
      outPkts: 0,
    };
    st.sessions[s.key] = s;
    sendFrame(rt, portId, frame.src, {
      kind: 'pppoe',
      code: 'PADS',
      sessionId: sid,
      serviceName: p.serviceName ?? '',
      hostUniq: p.hostUniq,
    });
    lcpReq(rt, s);
    return;
  }
  if (p.code === 'PADS') {
    const s = Object.values(st.sessions).find(
      (x) =>
        x.role === 'client' && x.portId === portId && x.state === 'padr' && x.peerMac === frame.src,
    );
    if (!s) return;
    logRx('pppoe.pads', { sid: p.sessionId });
    s.sessionId = p.sessionId;
    s.state = 'lcp';
    lcpReq(rt, s);
    return;
  }
  if (p.code === 'PADT') {
    const s = find(rt, portId, p.sessionId, frame.src);
    if (!s) return;
    logRx('pppoe.padt', { sid: p.sessionId });
    kill(rt, s, false, 'PADT received');
    return;
  }

  // ---- Session
  const s = find(rt, portId, p.sessionId, frame.src);
  const ppp = p.ppp;
  if (!s || !ppp) return;
  if (ppp.proto === 'ip') {
    if (s.state !== 'up') return;
    const iface = rt.node.ifaces.find((i) => i.id === s.ifaceId);
    if (!iface) return;
    s.inPkts++;
    ifaceFrameRx(
      ctx,
      rt.node,
      iface,
      eth(iface.mac, iface.mac, ppp.inner),
      fromId,
      ctx.port(portId),
    );
    return;
  }
  logRx(`ppp.${ppp.proto}`, { op: ppp.op });
  if (ppp.proto === 'lcp') {
    if (ppp.op === 'conf-req') {
      s.lcpPeer = true;
      sendPpp(rt, s, { ...ppp, op: 'conf-ack' });
    } else if (ppp.op === 'conf-ack') s.lcpOwn = true;
    else if (ppp.op === 'term-req') return kill(rt, s, false, 'LCP terminate');
    if (s.state === 'lcp' && s.lcpOwn && s.lcpPeer) {
      s.state = 'auth';
      if (s.role === 'server') {
        s.chapId = st.nextChap++;
        s.challenge = `ch${(s.sessionId * 7919 + s.chapId * 104729) % 1000003}`;
        sendPpp(rt, s, {
          proto: 'chap',
          op: 'challenge',
          id: s.chapId,
          value: s.challenge,
          name: rt.dev.config.sys.hostname,
        });
      }
    }
    return;
  }
  if (ppp.proto === 'chap') {
    if (s.role === 'client' && ppp.op === 'challenge') {
      const d = rt.cfg.ifaces[s.ifaceId]?.dialer;
      s.user = d?.chapUser ?? '';
      sendPpp(rt, s, {
        proto: 'chap',
        op: 'response',
        id: ppp.id,
        value: chapDigest(ppp.id, d?.chapPass ?? '', ppp.value ?? ''),
        name: s.user,
      });
    } else if (s.role === 'server' && ppp.op === 'response' && s.state === 'auth') {
      const user = ppp.name ?? '';
      const secret = rt.dev.config.sys.mgmt?.users[user]?.secret;
      const ok =
        secret !== undefined &&
        ppp.value === chapDigest(s.chapId, secret, s.challenge ?? '') &&
        s.chapId === ppp.id;
      if (ok) {
        s.user = user;
        s.state = 'ipcp';
        sendPpp(rt, s, { proto: 'chap', op: 'success', id: ppp.id });
      } else {
        sendPpp(rt, s, { proto: 'chap', op: 'failure', id: ppp.id });
        log(rt, 'ppp.authFailed', { user, iface: ctx.deviceIfaceName(s.ifaceId) }, 'error');
        kill(rt, s, true, 'authentication failed');
      }
    } else if (s.role === 'client' && ppp.op === 'success') {
      s.state = 'ipcp';
      sendPpp(rt, s, { proto: 'ipcp', op: 'conf-req', addr: '0.0.0.0' });
    } else if (s.role === 'client' && ppp.op === 'failure') {
      log(
        rt,
        'ppp.authFailed',
        { user: s.user ?? '', iface: ctx.deviceIfaceName(s.ifaceId) },
        'error',
      );
      kill(rt, s, false, 'authentication failed', FAIL_HOLDOFF);
    }
    return;
  }
  // IPCP
  if (s.role === 'server' && ppp.op === 'conf-req' && s.state === 'ipcp') {
    const t = templateOf(rt, portId);
    if (!t) return;
    const mine = localAddr(rt, t);
    s.localIp = mine;
    if (!s.peerIp) {
      s.peerIp = allocate(rt, t.pool, s);
      if (!s.peerIp) {
        log(rt, 'ppp.poolEmpty', { pool: t.pool ?? '' }, 'error');
        return kill(rt, s, true, 'no address available');
      }
    }
    if (ppp.addr === s.peerIp) {
      sendPpp(rt, s, { proto: 'ipcp', op: 'conf-ack', addr: s.peerIp, peer: mine });
      goUp(rt, s);
    } else sendPpp(rt, s, { proto: 'ipcp', op: 'conf-nak', addr: s.peerIp, peer: mine });
  } else if (s.role === 'client' && ppp.op === 'conf-nak') {
    s.localIp = ppp.addr;
    s.peerIp = ppp.peer;
    sendPpp(rt, s, { proto: 'ipcp', op: 'conf-req', addr: ppp.addr });
  } else if (s.role === 'client' && ppp.op === 'conf-ack' && s.state === 'ipcp') {
    s.localIp = ppp.addr;
    s.peerIp = ppp.peer ?? s.peerIp;
    goUp(rt, s);
  }
}

// ------------------------------------------------------------------ Senden von IP-Verkehr

/** IP-Paket über Dialer/Virtual-Access: als PPPoE-Session-Frame zum Peer. */
export function pppoeXmit(c: DeviceCtx, node: IpNode, iface: XmitIface, frame: Frame): void {
  const inner = frame.payload;
  const cfg = node.l3;
  if (inner.kind !== 'ipv4' || !cfg) return;
  const s = Object.values(cfg.ppp?.sessions ?? {}).find(
    (x) => x.ifaceId === iface.id && x.state === 'up',
  );
  if (!s) return;
  s.outPkts++;
  const f: Frame = {
    kind: 'ethernet',
    src: iface.mac,
    dst: s.peerMac,
    etherType: ETHERTYPE.pppoeSession,
    payload: {
      kind: 'pppoe',
      code: 'SESSION',
      sessionId: s.sessionId,
      ppp: { proto: 'ip', inner },
    },
  };
  c.send(s.portId, f, c.processingUs);
}
