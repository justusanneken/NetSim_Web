import type { BgpAttrs, BgpMsg } from '@netsim/protocols';
import { parseIpv4 } from '@netsim/protocols';
import {
  AD,
  SEC,
  cancelBg,
  dbg,
  installRoutes,
  redistSource,
  ribOf,
  rlog,
  rtOf,
  setBg,
  type Rt,
} from './core';
import { lookupRib } from '../rib';
import { buildRib6 } from '../l3v6';
import {
  applyCommunities,
  evalRouteMap,
  prefixListPermits,
  type RouteInfo,
  type RouteMapSet,
} from './routemap';
import {
  connClose,
  connKey,
  connOpen,
  connPush,
  type TcpServer,
  type ClientHook,
} from '../p5/conn';
import { appcOf } from '../p5/node';
import type { AppConn } from '../p5types';
import type { IpNode } from '../l3';
import type { L3Dev } from '../devices/l3dev';
import type { DeviceCtx } from '../ctx';
import { maxPathsOf, type BgpCfg, type BgpNbrCfg, type BgpPath } from './types';

const HOLD = 180;
const KEEPALIVE = 60;
const CONNECT_RETRY = 5_000_000; // nicht von SEC abgeleitet: Importzyklus (p5/dispatch → bgp → core)

export const newBgp = (asn: number): BgpCfg => ({
  asn,
  neighbors: {},
  networks: [],
  redistribute: [],
  locRib: {},
  defaultLocalPref: 100,
});

export const newBgpNbr = (ip: string, asn: number): BgpNbrCfg => ({
  ip,
  asn,
  nextHopSelf: false,
  shutdown: false,
  state: 'idle',
  holdSec: HOLD,
  lastRx: 0,
  lastTx: 0,
  prefixesRx: 0,
  advertised: {},
  ribIn: {},
  advertised6: {},
  ribIn6: {},
});

const ipNum = (ip: string): number => parseIpv4(ip) ?? 0;
const pkey = (prefix: string, plen: number): string => `${prefix}/${plen}`;
export const isEbgp = (c: BgpCfg, n: BgpNbrCfg): boolean => n.asn !== c.asn;

export function bgpRid(rt: Rt, c: BgpCfg): string {
  if (c.routerId) return c.routerId;
  if (c.rid) return c.rid;
  const loops = rt.node.ifaces.filter((i) => i.kind === 'loop').map((i) => i.ip);
  const all = loops.length ? loops : rt.node.ifaces.map((i) => i.ip);
  const rid = all.sort((a, b) => ipNum(a) - ipNum(b)).at(-1) ?? '0.0.0.0';
  c.rid = rid;
  return rid;
}

// ------------------------------------------------------------------ Hilfen

/** Quelladresse der Sitzung: `update-source` oder Adresse der Ausgangsschnittstelle. */
function sourceFor(rt: Rt, n: BgpNbrCfg): string | undefined {
  if (n.updateSource) return rt.node.ifaces.find((i) => i.id === n.updateSource)?.ip;
  return rt.node.lookup(n.ip)?.iface.ip;
}

const attrKey = (a: BgpAttrs): string =>
  `${a.origin}|${a.asPath.join(' ')}|${a.nextHop}|${a.med ?? ''}|${a.localPref ?? ''}|${(a.communities ?? []).join(',')}|${a.originatorId ?? ''}|${(a.clusterList ?? []).join(',')}|${a.nextHop6 ?? ''}`;

const clusterIdOf = (rt: Rt, c: BgpCfg): string => c.clusterId ?? bgpRid(rt, c);

/** Wendet `set`-Aktionen einer Route-Map auf Pfadattribute an. */
function applySet(attrs: BgpAttrs, set: RouteMapSet | undefined): BgpAttrs {
  if (!set) return attrs;
  const a: BgpAttrs = { ...attrs };
  if (set.localPref !== undefined) a.localPref = set.localPref;
  if (set.metric !== undefined) a.med = set.metric;
  if (set.asPathPrepend?.length) a.asPath = [...set.asPathPrepend, ...a.asPath];
  if (set.community) a.communities = applyCommunities(a.communities, set.community);
  if (set.nextHop) a.nextHop = set.nextHop;
  if (set.origin) a.origin = set.origin;
  return a;
}

const env = (rt: Rt): { routing: Rt['r']; acls: Rt['cfg']['acls'] } => ({
  routing: rt.r,
  acls: rt.cfg.acls,
});

/** Eingehende Policy (Prefix-List, Route-Map); `undefined` = verworfen. */
function policyIn(rt: Rt, n: BgpNbrCfg, p: BgpPath, v6: boolean): BgpPath | undefined {
  const info: RouteInfo = {
    prefix: p.prefix,
    plen: p.plen,
    v6,
    metric: p.attrs.med,
    nextHop: v6 ? p.attrs.nextHop6 : p.attrs.nextHop,
    communities: p.attrs.communities,
  };
  const lists = v6 ? rt.r.prefixLists6 : rt.r.prefixLists;
  if (n.prefixListIn && lists[n.prefixListIn] && !prefixListPermits(lists[n.prefixListIn], info))
    return undefined;
  const res = evalRouteMap(env(rt), n.routeMapIn, info);
  if (!res.permit) return undefined;
  if (!res.set) return p;
  return {
    ...p,
    attrs: applySet(p.attrs, res.set),
    weight: res.set.weight ?? p.weight,
  };
}

/** Ausgehende Policy; `undefined` = nicht ankündigen. */
function policyOut(
  rt: Rt,
  n: BgpNbrCfg,
  attrs: BgpAttrs,
  prefix: string,
  plen: number,
  v6: boolean,
): BgpAttrs | undefined {
  const info: RouteInfo = {
    prefix,
    plen,
    v6,
    metric: attrs.med,
    nextHop: v6 ? attrs.nextHop6 : attrs.nextHop,
    communities: attrs.communities,
  };
  const lists = v6 ? rt.r.prefixLists6 : rt.r.prefixLists;
  if (n.prefixListOut && lists[n.prefixListOut] && !prefixListPermits(lists[n.prefixListOut], info))
    return undefined;
  const res = evalRouteMap(env(rt), n.routeMapOut, info);
  if (!res.permit) return undefined;
  return applySet(attrs, res.set);
}

/** Live-TCP-Verbindung (Port 179) des Nachbarn. */
function connOf(rt: Rt, n: BgpNbrCfg): AppConn | undefined {
  const c = n.connKey ? appcOf(rt.node.cfg).conns[n.connKey] : undefined;
  return c?.state === 'open' ? c : undefined;
}

/** BGP-Nachricht als TCP-Segment auf der Sitzungsverbindung senden. */
function send(rt: Rt, _c: BgpCfg, n: BgpNbrCfg, msg: BgpMsg): boolean {
  const conn = connOf(rt, n);
  if (!conn) return false;
  const ok = connPush(rt.ctx, rt.node, conn, { op: msg.type, bgp: msg });
  if (ok) {
    n.lastTx = rt.ctx.now;
    n.msgTx = (n.msgTx ?? 0) + 1;
  }
  dbg(rt, 'BGP', 'bgp', () => `BGP: ${n.ip} send ${msg.type.toUpperCase()}`);
  return ok;
}

/** Sitzungsverbindung verwerfen (ohne Rückmeldung an die Anwendung). */
function dropConn(rt: Rt, n: BgpNbrCfg): void {
  if (n.connKey) connClose(rt.ctx, rt.node, n.connKey);
  n.connKey = undefined;
}

/** Ist der Nachbar erreichbar (direkt verbunden bei eBGP ohne Multihop; sonst irgendeine Route)? */
function reachable(rt: Rt, c: BgpCfg, n: BgpNbrCfg): boolean {
  const hop = rt.node.lookup(n.ip);
  if (!hop) return false;
  if (isEbgp(c, n) && !n.ebgpMultihop) return hop.nextHop === n.ip;
  return true;
}

// ------------------------------------------------------------------ Sync

export function bgpSync(rt: Rt): void {
  const c = rt.r.bgp;
  if (!c) {
    cancelBg(rt, 'rt:bgp:tick');
    return;
  }
  if (!c.timersArmed) {
    c.timersArmed = true;
    setBg(rt, 'rt:bgp:tick', 2 * SEC, CONNECT_RETRY);
  }
  for (const n of Object.values(c.neighbors)) {
    if (n.shutdown && n.state !== 'idle') resetSession(rt, c, n, 'shutdown', true);
    else if (n.state !== 'idle' && !reachable(rt, c, n))
      resetSession(rt, c, n, 'neighbor unreachable', false);
  }
  sweepConns(rt, c);
}

/**
 * TCP-Verbindungen ohne zugehörigen Nachbarn (`no neighbor X`, `no router bgp`) werden mit einer
 * Cease-NOTIFICATION beendet, damit die Gegenstelle die Sitzung und ihre Routen sofort verwirft.
 */
function sweepConns(rt: Rt, c: BgpCfg | undefined): void {
  const core = appcOf(rt.node.cfg);
  for (const [key, conn] of Object.entries(core.conns)) {
    if (conn.proto !== 'bgp') continue;
    const n = c?.neighbors[conn.raddr];
    if (n && n.connKey === key) continue;
    if (conn.state === 'open')
      connPush(rt.ctx, rt.node, conn, {
        op: 'notification',
        bgp: { type: 'notification', code: 6, text: 'Cease' },
      });
    connClose(rt.ctx, rt.node, key);
  }
}

export function bgpStop(rt: Rt): void {
  cancelBg(rt, 'rt:bgp:tick');
  sweepConns(rt, undefined);
}

export function bgpReset(c: BgpCfg): void {
  c.locRib = {};
  c.rid = undefined;
  c.timersArmed = false;
  for (const n of Object.values(c.neighbors)) {
    n.state = 'idle';
    n.connKey = undefined;
    n.ribIn = {};
    n.advertised = {};
    n.prefixesRx = 0;
    n.routerId = undefined;
    n.established = undefined;
    n.msgRx = undefined;
    n.msgTx = undefined;
    n.ribIn6 = {};
    n.advertised6 = {};
  }
  c.locRib6 = {};
}

function resetSession(rt: Rt, c: BgpCfg, n: BgpNbrCfg, why: string, notify: boolean): void {
  const was = n.state;
  if (notify && was !== 'idle')
    send(rt, c, n, { type: 'notification', code: 6, text: why === 'shutdown' ? 'Cease' : why });
  dropConn(rt, n);
  n.state = 'idle';
  n.ribIn = {};
  n.advertised = {};
  n.ribIn6 = {};
  n.advertised6 = {};
  n.prefixesRx = 0;
  n.routerId = undefined;
  n.established = undefined;
  if (was !== 'idle') {
    rlog(
      rt,
      'BGP',
      { key: 'bgp.state', params: { ip: n.ip, from: was, to: 'idle', reason: why } },
      {
        debug: {
          tag: 'bgp',
          text: () => `BGP: ${n.ip} went from ${was.toUpperCase()} to Idle (${why})`,
        },
      },
    );
    setBg(rt, 'rt:recompute', 1000);
  }
}

// ------------------------------------------------------------------ Timer

export function bgpTimer(rt: Rt, name: string): boolean {
  if (name !== 'rt:bgp:tick') return name.startsWith('rt:bgp:');
  const c = rt.r.bgp;
  if (!c) return true;
  for (const n of Object.values(c.neighbors)) {
    if (n.shutdown) continue;
    if (n.state === 'established' || n.state === 'openconfirm' || n.state === 'opensent') {
      if (rt.ctx.now - n.lastRx > n.holdSec * SEC) {
        resetSession(rt, c, n, 'hold timer expired', true);
        continue;
      }
      if (n.state !== 'opensent' && rt.ctx.now - n.lastTx >= KEEPALIVE * SEC)
        send(rt, c, n, { type: 'keepalive' });
      continue;
    }
    if (!reachable(rt, c, n)) continue;
    // Verbindungsaufbau: TCP-Verbindung zu Port 179 öffnen (Connect); schlägt sie fehl, folgt Active
    const live = n.connKey ? appcOf(rt.node.cfg).conns[n.connKey] : undefined;
    if (n.state !== 'idle' && live && (live.state === 'syn-sent' || live.state === 'open'))
      continue;
    // Idle mit bestehender Verbindung (z. B. nach `clear ip bgp`): Gegenseite per Cease informieren
    if (live?.state === 'open')
      send(rt, c, n, { type: 'notification', code: 6, text: 'Administrative Reset' });
    openTcp(rt, c, n);
  }
  return true;
}

function openTcp(rt: Rt, c: BgpCfg, n: BgpNbrCfg): void {
  dropConn(rt, n);
  const src = sourceFor(rt, n);
  if (!src) return;
  const r = connOpen(rt.ctx, rt.node, { dst: n.ip, proto: 'bgp', src, bg: true });
  if (r.ok) {
    n.connKey = r.key;
    setState(rt, c, n, 'connect');
  } else setState(rt, c, n, 'active');
}

function setState(rt: Rt, c: BgpCfg, n: BgpNbrCfg, to: BgpNbrCfg['state']): void {
  if (n.state === to) return;
  const from = n.state;
  n.state = to;
  rlog(
    rt,
    'BGP',
    { key: 'bgp.state', params: { ip: n.ip, from, to, reason: '' } },
    {
      status: to === 'established' ? 'ok' : 'info',
      debug: {
        tag: 'bgp',
        text: () => `BGP: ${n.ip} went from ${from.toUpperCase()} to ${to.toUpperCase()}`,
      },
    },
  );
  void c;
}

// ------------------------------------------------------------------ Empfang

/** Empfangene BGP-Nachricht einer TCP-Verbindung. */
export function bgpMessage(rt: Rt, conn: AppConn, msg: BgpMsg): void {
  const c = rt.r.bgp;
  if (!c) return;
  const n = c.neighbors[conn.raddr];
  if (!n || n.shutdown || n.state === 'idle' || n.connKey !== connKey(conn)) return;
  rlog(
    rt,
    'BGP',
    { key: 'bgp.rx', params: { type: msg.type, src: n.ip } },
    {
      kind: 'rx',
      status: 'ok',
      debug: { tag: 'bgp', text: () => `BGP: ${n.ip} rcv ${msg.type.toUpperCase()}` },
    },
  );
  n.lastRx = rt.ctx.now;
  n.msgRx = (n.msgRx ?? 0) + 1;
  switch (msg.type) {
    case 'open': {
      if (msg.asn !== n.asn) {
        send(rt, c, n, { type: 'notification', code: 2, text: 'bad peer AS' });
        resetSession(rt, c, n, 'bad peer AS', false);
        return;
      }
      if (n.state === 'established') {
        // RFC 4271: OPEN im Zustand Established (Gegenseite neu gestartet, z. B. `clear ip bgp`) →
        // FSM-Fehler, Sitzung samt gelernten Routen verwerfen und neu aufbauen
        resetSession(rt, c, n, 'FSM error', true);
        return;
      }
      n.routerId = msg.routerId;
      n.holdSec = Math.min(HOLD, msg.holdSec);
      if (n.state !== 'opensent') {
        send(rt, c, n, { type: 'open', asn: c.asn, holdSec: HOLD, routerId: bgpRid(rt, c) });
      }
      send(rt, c, n, { type: 'keepalive' });
      setState(rt, c, n, 'openconfirm');
      break;
    }
    case 'keepalive':
      if (n.state === 'openconfirm') {
        n.established = rt.ctx.now;
        setState(rt, c, n, 'established');
        setBg(rt, 'rt:recompute', 1000);
      }
      break;
    case 'notification':
      resetSession(rt, c, n, `notification: ${msg.text}`, false);
      break;
    case 'update':
      if (n.state !== 'established') return;
      rxUpdate(rt, c, n, msg);
      setBg(rt, 'rt:recompute', 1000);
      break;
  }
}

/** Die TCP-Verbindung der Sitzung ist weg (FIN, RST, Retransmission-Abbruch, Verbindungsaufbau gescheitert). */
function connLost(rt: Rt, conn: AppConn): void {
  const c = rt.r.bgp;
  const n = c?.neighbors[conn.raddr];
  if (!c || !n || n.connKey !== connKey(conn)) return;
  n.connKey = undefined;
  if (n.state === 'connect' || n.state === 'active' || n.state === 'idle') {
    setState(rt, c, n, 'active');
    return;
  }
  resetSession(rt, c, n, conn.err === 'conn.timeout' ? 'TCP timeout' : 'connection closed', false);
}

const rtFor = (ctx: DeviceCtx): Rt | undefined =>
  ctx.device.config.kind === 'router' || ctx.device.config.kind === 'switch'
    ? rtOf(ctx, ctx.device as L3Dev)
    : undefined;

/** TCP-Dienst Port 179 (passive Seite der Sitzung, inkl. einfacher Collision Detection). */
export const bgpServer: TcpServer = {
  accept(ctx, _dev, _node, conn) {
    const rt = rtFor(ctx);
    const c = rt?.r.bgp;
    const n = c?.neighbors[conn.raddr];
    if (!rt || !c || !n || n.shutdown) return 'refuse';
    const cur = n.connKey ? appcOf(rt.node.cfg).conns[n.connKey] : undefined;
    if (cur) {
      // Kollision: beide Seiten bauen gleichzeitig auf. Gewinner ist die Verbindung der Seite mit der
      // höheren Quelladresse; eine bestehende Sitzung (OpenConfirm/Established) bleibt unberührt.
      const src = sourceFor(rt, n);
      const keepOurs =
        n.state === 'openconfirm' ||
        n.state === 'established' ||
        (cur.role === 'c' && ipNum(src ?? '0.0.0.0') > ipNum(n.ip));
      if (keepOurs) return 'refuse';
      dropConn(rt, n);
    }
    n.connKey = connKey(conn);
    if (n.state === 'idle' || n.state === 'connect') setState(rt, c, n, 'active');
    n.lastRx = rt.ctx.now;
    return { op: '' };
  },
  handle(ctx, _dev, _node, conn, msg) {
    const rt = rtFor(ctx);
    if (rt && msg.bgp) bgpMessage(rt, conn, msg.bgp);
    return undefined;
  },
  closed(ctx, _dev, conn) {
    const rt = rtFor(ctx);
    if (rt) connLost(rt, conn);
  },
};

/** Client-Seite (aktiver Verbindungsaufbau) der BGP-Sitzung. */
export const bgpClientHook: ClientHook = (ctx: DeviceCtx, _node: IpNode, conn: AppConn, event) => {
  const rt = rtFor(ctx);
  const c = rt?.r.bgp;
  if (!rt || !c) return;
  if (event === 'fail') {
    connLost(rt, conn);
    // Eintrag der gescheiterten Verbindung entfernen
    connClose(ctx, rt.node, connKey(conn));
    return;
  }
  const n = c.neighbors[conn.raddr];
  if (!n || n.connKey !== connKey(conn)) return;
  if (event === 'open') {
    if (send(rt, c, n, { type: 'open', asn: c.asn, holdSec: HOLD, routerId: bgpRid(rt, c) })) {
      setState(rt, c, n, 'opensent');
      n.lastRx = rt.ctx.now;
    }
  } else if (conn.reply?.bgp) bgpMessage(rt, conn, conn.reply.bgp);
};

function rxUpdate(rt: Rt, c: BgpCfg, n: BgpNbrCfg, m: Extract<BgpMsg, { type: 'update' }>): void {
  for (const w of m.withdrawn) delete n.ribIn[pkey(w.prefix, w.plen)];
  for (const w of m.withdrawn6 ?? []) delete n.ribIn6?.[pkey(w.prefix, w.plen)];
  if (m.attrs) {
    const a = m.attrs;
    const ebgp = isEbgp(c, n);
    if (ebgp && a.asPath.includes(c.asn)) {
      // AS-Pfad-Schleife
      dbg(rt, 'BGP', 'bgp', () => `BGP: ${n.ip} rejected NLRI, AS path loop`);
    } else if (
      !ebgp &&
      (a.originatorId === bgpRid(rt, c) || a.clusterList?.includes(clusterIdOf(rt, c)))
    ) {
      // Route-Reflection-Schleife (eigene Router-ID bzw. Cluster-ID)
      dbg(rt, 'BGP', 'bgp', () => `BGP: ${n.ip} rejected NLRI, originator/cluster loop`);
    } else {
      const mk = (p: { prefix: string; plen: number }): BgpPath => ({
        prefix: p.prefix,
        plen: p.plen,
        attrs: { ...a, localPref: ebgp ? undefined : (a.localPref ?? c.defaultLocalPref) },
        from: n.ip,
        ebgp,
        fromRid: n.routerId ?? n.ip,
        weight: n.weight ?? 0,
        local: false,
      });
      for (const p of m.nlri) n.ribIn[pkey(p.prefix, p.plen)] = mk(p);
      if (n.activate6) {
        n.ribIn6 ??= {};
        for (const p of m.nlri6 ?? []) n.ribIn6[pkey(p.prefix, p.plen)] = mk(p);
      }
    }
  }
  n.prefixesRx = Object.keys(n.ribIn).length;
}

// ------------------------------------------------------------------ Entscheidungsprozess

const ORIGIN = { igp: 0, egp: 1, incomplete: 2 } as const;

function igpMetric(rt: Rt, nh: string): number | undefined {
  const rib = ribOf(rt).filter((e) => e.type !== 'B');
  const e = lookupRib(rib, nh);
  return e ? e.metric : undefined;
}

/** Besserer Pfad (true, wenn a besser als b). */
function betterPath(rt: Rt, c: BgpCfg, a: BgpPath, b: BgpPath): boolean {
  if (a.weight !== b.weight) return a.weight > b.weight;
  const lpA = a.attrs.localPref ?? c.defaultLocalPref;
  const lpB = b.attrs.localPref ?? c.defaultLocalPref;
  if (lpA !== lpB) return lpA > lpB;
  if (a.local !== b.local) return a.local;
  if (a.attrs.asPath.length !== b.attrs.asPath.length)
    return a.attrs.asPath.length < b.attrs.asPath.length;
  if (a.attrs.origin !== b.attrs.origin) return ORIGIN[a.attrs.origin] < ORIGIN[b.attrs.origin];
  const mA = a.attrs.med ?? 0;
  const mB = b.attrs.med ?? 0;
  if (mA !== mB) return mA < mB;
  if (a.ebgp !== b.ebgp) return a.ebgp;
  const gA = igpMetric(rt, a.attrs.nextHop) ?? 0;
  const gB = igpMetric(rt, b.attrs.nextHop) ?? 0;
  if (gA !== gB) return gA < gB;
  if (a.fromRid !== b.fromRid) return ipNum(a.fromRid) < ipNum(b.fromRid);
  return ipNum(a.from) < ipNum(b.from);
}

export function bgpRecompute(rt: Rt): boolean {
  const c = rt.r.bgp;
  if (!c) {
    return installRoutes(rt, 'bgp', []);
  }
  const rib = ribOf(rt).filter((e) => e.type !== 'B');
  // Kandidaten sammeln
  const cand = new Map<string, BgpPath[]>();
  const add = (p: BgpPath): void => {
    const k = pkey(p.prefix, p.plen);
    const list = cand.get(k) ?? [];
    list.push(p);
    cand.set(k, list);
  };
  const localAttrs = (origin: BgpAttrs['origin']): BgpAttrs => ({
    origin,
    asPath: [],
    nextHop: '0.0.0.0',
  });
  for (const nw of c.networks) {
    if (rib.some((e) => e.prefix === nw.prefix && e.plen === nw.plen && e.type !== 'L')) {
      add({
        prefix: nw.prefix,
        plen: nw.plen,
        attrs: localAttrs('igp'),
        from: 'local',
        ebgp: false,
        fromRid: bgpRid(rt, c),
        weight: 32768,
        local: true,
      });
    }
  }
  for (const red of c.redistribute) {
    for (const s of redistSource(rt, red, 'bgp')) {
      if (s.plen === 0) continue;
      add({
        prefix: s.prefix,
        plen: s.plen,
        attrs: { ...localAttrs('incomplete'), med: red.metric },
        from: 'local',
        ebgp: false,
        fromRid: bgpRid(rt, c),
        weight: 32768,
        local: true,
      });
    }
  }
  for (const n of Object.values(c.neighbors)) {
    if (n.state !== 'established') continue;
    for (const p0 of Object.values(n.ribIn)) {
      const p = policyIn(rt, n, p0, false);
      if (!p) continue;
      if (igpMetric(rt, p.attrs.nextHop) === undefined) continue; // Next-Hop unerreichbar
      add({ ...p, weight: p.weight !== p0.weight ? p.weight : (n.weight ?? p.weight) });
    }
  }
  const loc: Record<string, BgpPath> = {};
  const multi: Record<string, BgpPath[]> = {};
  for (const [k, list] of cand) {
    let best = list[0] as BgpPath;
    for (const p of list.slice(1)) if (betterPath(rt, c, p, best)) best = p;
    loc[k] = best;
    const max = maxPathsOf(c, 1);
    if (max > 1 && !best.local) {
      const eq = list.filter(
        (p) =>
          p !== best &&
          !p.local &&
          p.weight === best.weight &&
          (p.attrs.localPref ?? c.defaultLocalPref) ===
            (best.attrs.localPref ?? c.defaultLocalPref) &&
          p.attrs.asPath.length === best.attrs.asPath.length &&
          p.attrs.origin === best.attrs.origin &&
          (p.attrs.med ?? 0) === (best.attrs.med ?? 0) &&
          p.ebgp === best.ebgp &&
          p.attrs.nextHop !== best.attrs.nextHop,
      );
      if (eq.length) multi[k] = [best, ...eq.slice(0, max - 1)];
    }
  }
  const locChanged = JSON.stringify(loc) !== JSON.stringify(c.locRib);
  c.locRib = loc;

  // Routen installieren
  const routes = [];
  for (const [k, best] of Object.entries(loc)) {
    for (const p of multi[k] ?? [best]) {
      if (p.local) continue;
      const e = lookupRib(rib, p.attrs.nextHop);
      if (!e?.ifaceId) continue;
      routes.push({
        proto: 'B' as const,
        sub: undefined,
        prefix: p.prefix,
        plen: p.plen,
        ad: p.ebgp ? AD.ebgp : AD.ibgp,
        metric: p.attrs.med ?? 0,
        nextHop: e.type === 'C' ? p.attrs.nextHop : (e.nextHop ?? p.attrs.nextHop),
        bgpNextHop: p.attrs.nextHop,
        ifaceId: e.ifaceId,
      });
    }
  }
  let changed = installRoutes(rt, 'bgp', routes);
  if (recompute6(rt, c)) changed = true;
  if (advertise(rt, c)) changed = true;
  return changed || locChanged;
}

// ------------------------------------------------------------------ Advertise

function exportAttrs(
  rt: Rt,
  c: BgpCfg,
  n: BgpNbrCfg,
  p: BgpPath,
  v6 = false,
): BgpAttrs | undefined {
  const ebgp = isEbgp(c, n);
  if (p.from === n.ip) return undefined; // nicht zurück zum Absender
  const comms = p.attrs.communities ?? [];
  if (comms.includes('no-advertise')) return undefined;
  if (ebgp && (comms.includes('no-export') || comms.includes('local-AS'))) return undefined;
  let reflect = false;
  if (!ebgp && !p.local && !p.ebgp) {
    // iBGP → iBGP nur als Route Reflector (Quelle oder Ziel ist Client)
    const from = c.neighbors[p.from];
    if (!(from?.rrClient || n.rrClient)) return undefined;
    reflect = true;
  }
  if (ebgp && p.attrs.asPath.includes(n.asn)) return undefined;
  const self = sourceFor(rt, n) ?? '0.0.0.0';
  let out: BgpAttrs;
  if (ebgp) {
    out = {
      origin: p.attrs.origin,
      asPath: [c.asn, ...p.attrs.asPath],
      nextHop: self,
      med: p.local ? p.attrs.med : undefined,
      communities: p.attrs.communities,
    };
  } else {
    out = {
      origin: p.attrs.origin,
      asPath: p.attrs.asPath,
      nextHop: p.local || n.nextHopSelf ? self : p.attrs.nextHop,
      med: p.attrs.med,
      localPref: p.attrs.localPref ?? c.defaultLocalPref,
      communities: p.attrs.communities,
    };
    if (reflect) {
      out.originatorId = p.attrs.originatorId ?? p.fromRid;
      out.clusterList = [clusterIdOf(rt, c), ...(p.attrs.clusterList ?? [])];
    }
  }
  const pol = policyOut(rt, n, out, p.prefix, p.plen, v6);
  if (!pol) return undefined;
  if (!n.sendCommunity) pol.communities = undefined;
  else if (!pol.communities?.length) pol.communities = undefined;
  return pol;
}

/** Adj-RIB-Out abgleichen und Updates/Withdraws senden. Liefert `true`, wenn etwas gesendet wurde. */
function advertise(rt: Rt, c: BgpCfg): boolean {
  let sent = false;
  for (const n of Object.values(c.neighbors)) {
    if (n.state !== 'established') continue;
    const want = new Map<string, { attrs: BgpAttrs; prefix: string; plen: number }>();
    for (const [k, p] of Object.entries(c.locRib)) {
      const a = exportAttrs(rt, c, n, p);
      if (a) want.set(k, { attrs: a, prefix: p.prefix, plen: p.plen });
    }
    const withdraw: { prefix: string; plen: number }[] = [];
    for (const k of Object.keys(n.advertised)) {
      if (!want.has(k)) {
        const [prefix, plen] = k.split('/') as [string, string];
        withdraw.push({ prefix, plen: Number(plen) });
        delete n.advertised[k];
      }
    }
    if (withdraw.length) {
      send(rt, c, n, { type: 'update', withdrawn: withdraw, nlri: [] });
      sent = true;
    }
    if (advertise6(rt, c, n)) sent = true;
    const groups = new Map<string, { attrs: BgpAttrs; nlri: { prefix: string; plen: number }[] }>();
    for (const [k, w] of want) {
      const ak = attrKey(w.attrs);
      if (n.advertised[k] === ak) continue;
      n.advertised[k] = ak;
      const g = groups.get(ak) ?? { attrs: w.attrs, nlri: [] };
      g.nlri.push({ prefix: w.prefix, plen: w.plen });
      groups.set(ak, g);
    }
    for (const g of groups.values()) {
      send(rt, c, n, { type: 'update', withdrawn: [], attrs: g.attrs, nlri: g.nlri });
      sent = true;
    }
  }
  return sent;
}

// ------------------------------------------------------------------ IPv6-Adressfamilie (MP-BGP, vereinfacht)

/** Eigene globale IPv6-Adresse an der Schnittstelle, über die die Sitzung läuft. */
function selfAddr6(rt: Rt, n: BgpNbrCfg): string | undefined {
  const src = sourceFor(rt, n);
  const v4 = rt.node.ifaces.find((i) => i.ip === src);
  const v6 = rt.node.v6?.ifaces.find((i) => i.id === v4?.id);
  return v6 ? (v6.addrs[0]?.addr ?? v6.ll) : undefined;
}

function recompute6(rt: Rt, c: BgpCfg): boolean {
  if (!rt.node.v6 && !(c.networks6?.length ?? 0)) {
    c.locRib6 = {};
    return installRoutes(rt, 'bgp', [], true);
  }
  const cand = new Map<string, BgpPath[]>();
  const add = (p: BgpPath): void => {
    const k = pkey(p.prefix, p.plen);
    cand.set(k, [...(cand.get(k) ?? []), p]);
  };
  const rib6 = rt.node.v6 ? buildRib6(rt.cfg, rt.node.v6.ifaces) : [];
  for (const nw of c.networks6 ?? []) {
    if (
      rib6.some(
        (e) => e.type !== 'L' && e.type !== 'B' && e.prefix === nw.prefix && e.plen === nw.plen,
      )
    )
      add({
        prefix: nw.prefix,
        plen: nw.plen,
        attrs: { origin: 'igp', asPath: [], nextHop: '0.0.0.0', nextHop6: '::' },
        from: 'local',
        ebgp: false,
        fromRid: bgpRid(rt, c),
        weight: 32768,
        local: true,
      });
  }
  {
    for (const n of Object.values(c.neighbors)) {
      if (n.state !== 'established' || !n.activate6) continue;
      for (const p0 of Object.values(n.ribIn6 ?? {})) {
        const p = policyIn(rt, n, p0, true);
        if (!p || !p.attrs.nextHop6 || !rt.node.v6?.lookup(p.attrs.nextHop6)) continue;
        add({ ...p, weight: p.weight !== p0.weight ? p.weight : (n.weight ?? p.weight) });
      }
    }
  }
  const loc: Record<string, BgpPath> = {};
  for (const [k, list] of cand) {
    let best = list[0] as BgpPath;
    for (const p of list.slice(1)) if (betterPath(rt, c, p, best)) best = p;
    loc[k] = best;
  }
  c.locRib6 = loc;
  const routes = [];
  for (const p of Object.values(loc)) {
    if (p.local || !p.attrs.nextHop6) continue;
    const hop = rt.node.v6?.lookup(p.attrs.nextHop6);
    if (!hop) continue;
    routes.push({
      proto: 'B' as const,
      sub: undefined,
      prefix: p.prefix,
      plen: p.plen,
      ad: p.ebgp ? AD.ebgp : AD.ibgp,
      metric: p.attrs.med ?? 0,
      nextHop: hop.nextHop,
      ifaceId: hop.iface.id,
    });
  }
  return installRoutes(rt, 'bgp', routes, true);
}

/** IPv6-Präfixe an aktivierte Nachbarn ankündigen (im selben Update-Nachrichtentyp). */
function advertise6(rt: Rt, c: BgpCfg, n: BgpNbrCfg): boolean {
  if (!n.activate6 || n.state !== 'established') return false;
  n.advertised6 ??= {};
  const ebgp = isEbgp(c, n);
  const self6 = selfAddr6(rt, n);
  const want = new Map<string, { attrs: BgpAttrs; prefix: string; plen: number }>();
  for (const [k, p] of Object.entries(c.locRib6 ?? {})) {
    const base = exportAttrs(rt, c, n, { ...p, attrs: { ...p.attrs } }, true);
    if (!base || !self6) continue;
    const nh6 = ebgp || p.local || n.nextHopSelf ? self6 : (p.attrs.nextHop6 ?? self6);
    want.set(k, { attrs: { ...base, nextHop6: nh6 }, prefix: p.prefix, plen: p.plen });
  }
  const withdraw: { prefix: string; plen: number }[] = [];
  for (const k of Object.keys(n.advertised6)) {
    if (!want.has(k)) {
      const [prefix, plen] = k.split('/') as [string, string];
      withdraw.push({ prefix, plen: Number(plen) });
      delete n.advertised6[k];
    }
  }
  let sent = false;
  if (withdraw.length) {
    send(rt, c, n, { type: 'update', withdrawn: [], nlri: [], withdrawn6: withdraw });
    sent = true;
  }
  const groups = new Map<string, { attrs: BgpAttrs; nlri6: { prefix: string; plen: number }[] }>();
  for (const [k, w] of want) {
    const ak = attrKey(w.attrs);
    if (n.advertised6[k] === ak) continue;
    n.advertised6[k] = ak;
    const g = groups.get(ak) ?? { attrs: w.attrs, nlri6: [] };
    g.nlri6.push({ prefix: w.prefix, plen: w.plen });
    groups.set(ak, g);
  }
  for (const g of groups.values()) {
    send(rt, c, n, { type: 'update', withdrawn: [], attrs: g.attrs, nlri: [], nlri6: g.nlri6 });
    sent = true;
  }
  return sent;
}
