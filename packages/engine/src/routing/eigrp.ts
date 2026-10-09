import type { EigrpMsg, EigrpRoute, Ipv4Pdu } from '@netsim/protocols';
import type { Iface } from '../ifaces';
import type { Base } from '../l3';
import { sendMcast6, sendNbr6 } from '../l3v6';
import { pseudoIface } from './ospf';
import {
  AD,
  SEC,
  cancelBg,
  classfulNet,
  classfulPlen,
  dbg,
  distPermits,
  ifaceBwKbps,
  ifaceDelay,
  inNet,
  installRoutes,
  redistSource,
  redistSource6,
  rlog,
  sendMcast,
  sendNbr,
  setBg,
  wildcardMatch,
  type Rt,
} from './core';
import {
  isPassive,
  maxPathsOf,
  type EigrpCfg,
  type EigrpNbr,
  type EigrpPath,
  type EigrpTopo,
} from './types';

export const EIGRP_GROUP = '224.0.0.10';
const HELLO = 5;
const HOLD = 15;
const RTO = 2 * SEC;
const MAX_TRIES = 16;
/** Stuck-in-Active-Timer (3 Minuten). */
export const SIA_SEC = 180;

export const EIGRP_GROUP6 = 'ff02::a';

/** Neuer EIGRP-Prozess; `v6`: EIGRP für IPv6 (startet wie bei IOS im Zustand `shutdown`, kein Auto-Summary). */
export const newEigrp = (asn: number, v6 = false): EigrpCfg => ({
  asn,
  networks: [],
  passive: [],
  unpassive: [],
  passiveDefault: false,
  autoSummary: !v6,
  ...(v6 ? { v6: true, shutdown: true } : {}),
  variance: 1,
  redistribute: [],
  neighbors: {},
  topology: {},
  advQueue: [],
  helloIfs: [],
});

/** Klassische zusammengesetzte Metrik (K1 = K3 = 1): 256 · (10⁷ / BW_min + Delay_Summe). */
export const metricOf = (bwKbps: number, delay: number): number =>
  256 * (Math.floor(1e7 / Math.max(1, bwKbps)) + delay);

const key = (prefix: string, plen: number): string => `${prefix}/${plen}`;
/** Beim Neuankündigen nach `distribute-list`-Änderung gefilterte Ziele als unreachable melden. */
let withdrawDenied = false;
const nameOf = (rt: Rt, id: string): string => rt.ctx.deviceIfaceName(id);

/** Alle EIGRP-Prozesse (IPv4 und IPv6). */
export const eigrpProcs = (rt: Rt): EigrpCfg[] => [
  ...Object.values(rt.r.eigrp),
  ...Object.values(rt.r.eigrp6 ?? {}),
];
const procOf = (rt: Rt, asn: number, v6: boolean): EigrpCfg | undefined =>
  (v6 ? rt.r.eigrp6 : rt.r.eigrp)?.[asn];
/** Timer-Präfix: `rt:eigrp` bzw. `rt:eigrp6`. */
const tp = (c: EigrpCfg): string => (c.v6 ? 'rt:eigrp6' : 'rt:eigrp');
/** Quelle der installierten Routen. */
export const eigrpSrc = (c: EigrpCfg): string => `${c.v6 ? 'eigrp6' : 'eigrp'}:${c.asn}`;

/** IPv6-Prozesse laufen nur mit `no shutdown` und einer (IPv4-)Router-ID. */
const enabled = (rt: Rt, c: EigrpCfg): boolean =>
  !c.v6 || (!c.shutdown && eigrpRid(rt, c) !== '0.0.0.0');

/** Schnittstellen eines Prozesses (IPv6: Pseudo-Schnittstellen, Adresse = Link-Local). */
function allIfaces(rt: Rt, c: EigrpCfg): Iface[] {
  return c.v6 ? (rt.node.v6?.ifaces ?? []).map(pseudoIface) : rt.node.ifaces;
}
const ifOf = (rt: Rt, c: EigrpCfg, id: string): Iface | undefined =>
  allIfaces(rt, c).find((i) => i.id === id);

export function eigrpIfaces(rt: Rt, c: EigrpCfg): Iface[] {
  if (c.v6) {
    if (!enabled(rt, c)) return [];
    return allIfaces(rt, c).filter((i) => i.cfg.v6?.eigrp === c.asn);
  }
  return rt.node.ifaces.filter((i) =>
    c.networks.some((n) => wildcardMatch(i.ip, n.prefix, n.wildcard)),
  );
}

/** Angeschlossene Präfixe einer Schnittstelle (IPv4: ein Netz, IPv6: alle globalen Präfixe). */
function localPrefixes(rt: Rt, c: EigrpCfg, i: Iface): { prefix: string; plen: number }[] {
  if (c.v6) return i.v6Prefixes ?? [];
  const plen = i.kind === 'loop' ? 32 : maskLen(i.mask);
  return [{ prefix: i.kind === 'loop' ? i.ip : netOf(i.ip, plen), plen }];
}

function eigrpRid(rt: Rt, c: EigrpCfg): string {
  if (c.routerId) return c.routerId;
  if (c.rid) return c.rid;
  const loops = rt.node.ifaces.filter((i) => i.kind === 'loop').map((i) => i.ip);
  const all = loops.length ? loops : rt.node.ifaces.map((i) => i.ip);
  const rid = all.sort().at(-1) ?? '0.0.0.0';
  if (rid !== '0.0.0.0') c.rid = rid;
  return rid;
}

function xmit6(rt: Rt, iface: Iface, dst: string, payload: IpPayload6): void {
  const n6 = rt.node.v6;
  const i6 = n6?.ifaces.find((i) => i.id === iface.id);
  if (!n6 || !i6) return;
  const host = { cfg: rt.node.cfg, v6: n6, xmit: rt.node.xmit };
  if (dst === EIGRP_GROUP6) sendMcast6(rt.ctx, host, i6, dst, payload);
  else sendNbr6(rt.ctx, host, i6, dst, payload);
}
type IpPayload6 = Parameters<typeof sendMcast6>[4];

/** Pakete des Prozesses senden (IPv4 über Multicast/Unicast, IPv6 über Link-Local). */
function emit(rt: Rt, c: EigrpCfg, iface: Iface, dst: string | undefined, msg: EigrpMsg): void {
  if (c.v6) {
    xmit6(rt, iface, dst ?? EIGRP_GROUP6, { kind: 'routing', proto: 'eigrp', v: 6, msg });
    return;
  }
  const payload = { kind: 'routing' as const, proto: 'eigrp' as const, msg };
  if (dst === undefined) sendMcast(rt, iface, EIGRP_GROUP, payload);
  else sendNbr(rt, iface, dst, payload);
}

const dp = (
  rt: Rt,
  c: EigrpCfg,
  dir: 'in' | 'out',
  ifaceId: string | undefined,
  route: { prefix: string; plen: number },
): boolean => distPermits(rt, c.distributeLists, dir, ifaceId, { ...route, v6: c.v6 });

// ------------------------------------------------------------------ Sync

export function eigrpSync(rt: Rt): void {
  for (const c of eigrpProcs(rt)) {
    const ifs = eigrpIfaces(rt, c);
    const ids = new Set(ifs.map((i) => i.id));
    // Nachbarn an verschwundenen/passiven Schnittstellen verwerfen
    for (const n of Object.values(c.neighbors)) {
      if (!ids.has(n.ifaceId) || isPassive(c, n.ifaceId)) killNbr(rt, c, n, 'interface down');
    }
    for (const id of [...c.helloIfs]) {
      const i = ifs.find((x) => x.id === id);
      if (!i || i.kind === 'loop' || isPassive(c, id)) {
        cancelBg(rt, `${tp(c)}:hello:${c.asn}:${id}`);
        c.helloIfs = c.helloIfs.filter((x) => x !== id);
      }
    }
    for (const i of ifs) {
      if (i.kind === 'loop' || isPassive(c, i.id) || c.helloIfs.includes(i.id)) continue;
      c.helloIfs.push(i.id);
      setBg(rt, `${tp(c)}:hello:${c.asn}:${i.id}`, 100_000 + rt.ctx.rand(SEC), HELLO * SEC);
      rlog(rt, 'EIGRP', { key: 'eigrp.if.up', params: { iface: nameOf(rt, i.id), asn: c.asn } });
    }
  }
}

export function eigrpStop(rt: Rt): void {
  for (const c of eigrpProcs(rt)) {
    for (const n of Object.values(c.neighbors)) killNbr(rt, c, n, 'shutdown', true);
  }
}

export function eigrpReset(c: EigrpCfg): void {
  c.neighbors = {};
  c.topology = {};
  c.advQueue = [];
  c.rid = undefined;
  c.helloIfs = [];
}

// ------------------------------------------------------------------ Senden (zuverlässig)

function msgBase(rt: Rt, c: EigrpCfg, op: EigrpMsg['op']): EigrpMsg {
  return { op, asn: c.asn, routerId: eigrpRid(rt, c), holdSec: HOLD, seq: 0, ack: 0 };
}

function sendTo(rt: Rt, c: EigrpCfg, n: EigrpNbr, msg: EigrpMsg): void {
  const iface = ifOf(rt, c, n.ifaceId);
  if (!iface) return;
  emit(rt, c, iface, n.ip, msg);
  dbg(
    rt,
    'EIGRP',
    'eigrp.packet',
    () =>
      `EIGRP: Sending ${msg.op.toUpperCase()} on ${nameOf(rt, n.ifaceId)} nbr ${n.ip}, seq ${msg.seq}, ack ${msg.ack}${msg.routes ? `, ${msg.routes.length} route(s)` : ''}`,
  );
}

function enqueue(
  rt: Rt,
  c: EigrpCfg,
  n: EigrpNbr,
  op: 'update' | 'query' | 'reply',
  routes: EigrpRoute[],
  init = false,
): void {
  n.seqOut += 1;
  n.queue.push({ op, seq: n.seqOut, routes, init, tries: 0 });
  if (n.queue.length === 1) transmit(rt, c, n);
}

function transmit(rt: Rt, c: EigrpCfg, n: EigrpNbr): void {
  const q = n.queue[0];
  if (!q) return;
  q.tries++;
  sendTo(rt, c, n, {
    ...msgBase(rt, c, q.op),
    seq: q.seq,
    ack: n.seqIn,
    init: q.init,
    routes: q.routes,
  });
  setBg(rt, `${tp(c)}:rxmt:${c.asn}:${n.ip}`, RTO);
}

function sendAck(rt: Rt, c: EigrpCfg, n: EigrpNbr, seq: number): void {
  sendTo(rt, c, n, { ...msgBase(rt, c, 'ack'), ack: seq });
}

// ------------------------------------------------------------------ Nachbarn

function killNbr(rt: Rt, c: EigrpCfg, n: EigrpNbr, why: string, silent = false): void {
  cancelBg(rt, `${tp(c)}:hold:${c.asn}:${n.ip}`);
  cancelBg(rt, `${tp(c)}:rxmt:${c.asn}:${n.ip}`);
  delete c.neighbors[n.ip];
  if (!silent)
    rlog(
      rt,
      'EIGRP',
      { key: 'eigrp.nbr.down', params: { ip: n.ip, iface: nameOf(rt, n.ifaceId), reason: why } },
      {
        debug: {
          tag: 'eigrp.neighbor',
          text: () => `EIGRP: Neighbor ${n.ip} (${nameOf(rt, n.ifaceId)}) is down: ${why}`,
        },
      },
    );
  if (silent) return;
  const affected: string[] = [];
  for (const [k, t] of Object.entries(c.topology)) {
    const had = t.paths.some((p) => p.via === n.ip);
    t.paths = t.paths.filter((p) => p.via !== n.ip);
    if (t.active && t.waiting.includes(n.ip)) {
      t.waiting = t.waiting.filter((x) => x !== n.ip);
      if (t.waiting.length === 0) finishActive(rt, c, k, t);
    } else if (had) affected.push(k);
  }
  for (const k of affected) {
    const t = c.topology[k];
    if (t) evaluate(rt, c, k, t);
  }
  flushAdv(rt, c);
  requestRecomputeLater(rt);
}

function requestRecomputeLater(rt: Rt): void {
  setBg(rt, 'rt:recompute', 1000);
}

function upNbr(rt: Rt, c: EigrpCfg, iface: Iface, ip: string, rid: string, hold: number): EigrpNbr {
  const n: EigrpNbr = {
    ip,
    ifaceId: iface.id,
    routerId: rid,
    holdSec: hold,
    lastHeard: rt.ctx.now,
    seqOut: 0,
    seqIn: 0,
    queue: [],
    uptime: rt.ctx.now,
  };
  c.neighbors[ip] = n;
  rlog(
    rt,
    'EIGRP',
    { key: 'eigrp.nbr.up', params: { ip, iface: nameOf(rt, iface.id), asn: c.asn } },
    {
      status: 'ok',
      debug: {
        tag: 'eigrp.neighbor',
        text: () =>
          `EIGRP: New adjacency: Neighbor ${ip} (${nameOf(rt, iface.id)}) is up: new adjacency`,
      },
    },
  );
  // vollständige Topologie senden
  const routes = fullTable(rt, c, iface);
  enqueue(rt, c, n, 'update', routes, true);
  return n;
}

// ------------------------------------------------------------------ Metrik / Topologie

function pathFrom(
  rt: Rt,
  iface: Iface,
  via: string,
  r: { delay: number; bandwidth: number; hops: number; external?: EigrpPath['external'] },
): EigrpPath {
  const delay = r.delay + ifaceDelay(rt, iface);
  const bandwidth = Math.min(r.bandwidth, ifaceBwKbps(rt, iface));
  return {
    via,
    ifaceId: iface.id,
    rd: metricOf(r.bandwidth, r.delay),
    dist: metricOf(bandwidth, delay),
    delay,
    bandwidth,
    hops: r.hops + 1,
    external: r.external,
  };
}

function setPath(t: EigrpTopo, p: EigrpPath): void {
  const i = t.paths.findIndex((x) => x.via === p.via);
  if (i >= 0) t.paths[i] = p;
  else t.paths.push(p);
}

const topoFor = (c: EigrpCfg, prefix: string, plen: number): EigrpTopo =>
  (c.topology[key(prefix, plen)] ??= {
    prefix,
    plen,
    paths: [],
    fd: Number.MAX_SAFE_INTEGER,
    active: false,
    waiting: [],
  });

const bestOf = (paths: EigrpPath[]): EigrpPath | undefined =>
  paths.reduce<EigrpPath | undefined>((b, p) => (!b || p.dist < b.dist ? p : b), undefined);

/** DUAL: Successor wählen, bei fehlendem Feasible Successor aktiv werden. */
function evaluate(rt: Rt, c: EigrpCfg, k: string, t: EigrpTopo): void {
  if (t.active) return;
  const best = bestOf(t.paths);
  if (!best) {
    if (t.succ !== undefined) {
      // Successor verloren, kein Pfad mehr bekannt: Nachbarn könnten noch einen haben → Query
      goActive(rt, c, k, t);
      return;
    }
    if (t.advertised) queueAdv(c, k);
    delete c.topology[k];
    return;
  }
  const oldFd = t.fd;
  const feasible = t.paths.filter((p) => p.via === 'local' || p.rd < oldFd);
  let chosen: EigrpPath | undefined;
  if (best.via === 'local' || best.rd < oldFd || oldFd === Number.MAX_SAFE_INTEGER) chosen = best;
  else chosen = bestOf(feasible);
  if (!chosen) {
    goActive(rt, c, k, t);
    return;
  }
  t.fd = chosen.dist;
  t.succ = chosen.via;
  const adv = {
    delay: chosen.delay,
    bandwidth: chosen.bandwidth,
    hops: chosen.hops,
    unreachable: false,
  };
  if (JSON.stringify(adv) !== JSON.stringify(t.advertised)) {
    t.advertised = adv;
    queueAdv(c, k);
  }
  dbg(rt, 'EIGRP', 'eigrp.fsm', () => `DUAL: ${k} successor ${chosen?.via} FD ${t.fd}`);
}

function goActive(rt: Rt, c: EigrpCfg, k: string, t: EigrpTopo): void {
  const targets = Object.values(c.neighbors)
    .map((n) => n.ip)
    .filter((ip) => ip !== t.origin);
  dbg(
    rt,
    'EIGRP',
    'eigrp.fsm',
    () => `DUAL: ${k} going active, querying ${targets.length} neighbor(s)`,
  );
  rlog(rt, 'EIGRP', { key: 'eigrp.active', params: { prefix: k } });
  if (targets.length === 0) {
    finishActive(rt, c, k, t);
    return;
  }
  t.active = true;
  t.waiting = targets;
  t.activeSince = rt.ctx.now;
  setBg(rt, `${tp(c)}:sia:${c.asn}:${k}`, SIA_SEC * SEC);
  const q: EigrpRoute = {
    prefix: t.prefix,
    plen: t.plen,
    delay: 0,
    bandwidth: 0,
    hops: 0,
    unreachable: true,
  };
  for (const ip of targets) {
    const n = c.neighbors[ip];
    if (n) enqueue(rt, c, n, 'query', [q]);
  }
}

function finishActive(rt: Rt, c: EigrpCfg, k: string, t: EigrpTopo): void {
  cancelBg(rt, `${tp(c)}:sia:${c.asn}:${k}`);
  t.active = false;
  t.activeSince = undefined;
  t.waiting = [];
  const origin = t.origin;
  t.origin = undefined;
  t.fd = Number.MAX_SAFE_INTEGER; // neue Wahl ohne Feasibility-Einschränkung
  if (!bestOf(t.paths)) t.succ = undefined;
  const keep = c.topology[k];
  evaluate(rt, c, k, t);
  if (origin) {
    const n = c.neighbors[origin];
    if (n) enqueue(rt, c, n, 'reply', [routeFor(rt, c, k, c.topology[k] ?? keep, n.ifaceId, true)]);
  }
  void keep;
  flushAdv(rt, c);
  requestRecomputeLater(rt);
}

function queueAdv(c: EigrpCfg, k: string): void {
  if (!c.advQueue.includes(k)) c.advQueue.push(k);
}

/** Route in Updates/Replies; `forceReply`: auch über die Successor-Schnittstelle (Replies unterliegen keinem Split Horizon). */
function routeFor(
  _rt: Rt,
  _c: EigrpCfg,
  _k: string,
  t: EigrpTopo | undefined,
  _ifaceId: string,
  _forceReply = false,
): EigrpRoute {
  const [prefix, plenS] = _k.split('/') as [string, string];
  const plen = Number(plenS);
  const p = t?.paths.find((x) => x.via === t.succ);
  if (!t || !p || !dp(_rt, _c, 'out', _ifaceId, { prefix, plen }))
    return { prefix, plen, delay: 0, bandwidth: 0, hops: 0, unreachable: true };
  return {
    prefix,
    plen,
    delay: p.delay,
    bandwidth: p.bandwidth,
    hops: p.hops,
    external: p.external,
  };
}

/** Alle erreichbaren Routen (mit Split Horizon und Auto-Summary) für eine Schnittstelle. */
function fullTable(rt: Rt, c: EigrpCfg, iface: Iface): EigrpRoute[] {
  return buildAdv(rt, c, iface, Object.keys(c.topology));
}

function buildAdv(rt: Rt, c: EigrpCfg, iface: Iface, keys: string[]): EigrpRoute[] {
  const out: EigrpRoute[] = [];
  const summaries = new Map<string, EigrpRoute>();
  const major = c.v6 ? '' : classfulNet(iface.ip);
  for (const k of keys) {
    const t = c.topology[k];
    if (!t) {
      // verschwundenes Ziel: unreachable melden
      const [prefix, plenS] = k.split('/') as [string, string];
      out.push({ prefix, plen: Number(plenS), delay: 0, bandwidth: 0, hops: 0, unreachable: true });
      continue;
    }
    if (t.active) continue;
    const p = t.paths.find((x) => x.via === t.succ);
    if (!p) continue;
    if (p.via !== 'local' && p.ifaceId === iface.id) continue; // Split Horizon
    if (!dp(rt, c, 'out', iface.id, t)) {
      if (withdrawDenied)
        out.push({
          prefix: t.prefix,
          plen: t.plen,
          delay: 0,
          bandwidth: 0,
          hops: 0,
          unreachable: true,
        });
      continue;
    }
    const r = routeFor(rt, c, k, t, iface.id);
    if (!c.v6 && c.autoSummary && t.plen > 0 && classfulNet(t.prefix) !== major) {
      const sp = classfulPlen(t.prefix);
      if (t.plen > sp) {
        const sk = key(classfulNet(t.prefix), sp);
        const cur = summaries.get(sk);
        if (!cur || metricOf(r.bandwidth, r.delay) < metricOf(cur.bandwidth, cur.delay))
          summaries.set(sk, { ...r, prefix: classfulNet(t.prefix), plen: sp, external: undefined });
        continue;
      }
    }
    out.push(r);
  }
  return [...out, ...summaries.values()];
}

function flushAdv(rt: Rt, c: EigrpCfg): void {
  if (c.advQueue.length === 0) return;
  const keys = [...c.advQueue];
  c.advQueue = [];
  for (const n of Object.values(c.neighbors)) {
    const iface = ifOf(rt, c, n.ifaceId);
    if (!iface) continue;
    const routes = buildAdv(rt, c, iface, keys);
    if (routes.length) enqueue(rt, c, n, 'update', routes);
  }
}

// ------------------------------------------------------------------ Empfang

export function eigrpRx(
  rt: Rt,
  iface: Iface,
  _base: Base,
  ip: Pick<Ipv4Pdu, 'src'>,
  msg: EigrpMsg,
  v6 = false,
): void {
  void _base;
  const c = procOf(rt, msg.asn, v6);
  if (!c || !enabled(rt, c)) return;
  if (!eigrpIfaces(rt, c).some((i) => i.id === iface.id) || isPassive(c, iface.id)) return;
  if (ip.src === iface.ip) return;
  rlog(
    rt,
    'EIGRP',
    { key: 'eigrp.rx', params: { op: msg.op, src: ip.src, asn: msg.asn } },
    {
      kind: 'rx',
      status: 'ok',
      debug: {
        tag: 'eigrp.packet',
        text: () =>
          `EIGRP: Received ${msg.op.toUpperCase()} on ${nameOf(rt, iface.id)} nbr ${ip.src}, seq ${msg.seq}, ack ${msg.ack}`,
      },
    },
  );
  let n = c.neighbors[ip.src];
  if (!n) {
    if (msg.op !== 'hello') return;
    n = upNbr(rt, c, iface, ip.src, msg.routerId, msg.holdSec);
  }
  n.lastHeard = rt.ctx.now;
  n.holdSec = msg.holdSec;
  setBg(rt, `${tp(c)}:hold:${c.asn}:${n.ip}`, msg.holdSec * SEC);
  if (msg.ack && n.queue[0]?.seq === msg.ack) {
    n.queue.shift();
    cancelBg(rt, `${tp(c)}:rxmt:${c.asn}:${n.ip}`);
    if (n.queue.length) transmit(rt, c, n);
  }
  if (msg.op === 'hello' || msg.op === 'ack') return;
  if (msg.seq <= n.seqIn) {
    sendAck(rt, c, n, msg.seq);
    return;
  }
  n.seqIn = msg.seq;
  sendAck(rt, c, n, msg.seq);
  if (msg.op === 'update') rxUpdate(rt, c, iface, n, msg);
  else if (msg.op === 'query') rxQuery(rt, c, iface, n, msg);
  else rxReply(rt, c, iface, n, msg);
  flushAdv(rt, c);
  requestRecomputeLater(rt);
}

function applyRoute(rt: Rt, c: EigrpCfg, iface: Iface, n: EigrpNbr, r: EigrpRoute): string {
  const k = key(r.prefix, r.plen);
  const t = topoFor(c, r.prefix, r.plen);
  if (r.unreachable || !dp(rt, c, 'in', iface.id, r))
    t.paths = t.paths.filter((p) => p.via !== n.ip);
  else setPath(t, pathFrom(rt, iface, n.ip, { ...r }));
  return k;
}

function rxUpdate(rt: Rt, c: EigrpCfg, iface: Iface, n: EigrpNbr, msg: EigrpMsg): void {
  for (const r of msg.routes ?? []) {
    const k = applyRoute(rt, c, iface, n, r);
    const t = c.topology[k];
    if (t) evaluate(rt, c, k, t);
  }
}

function rxQuery(rt: Rt, c: EigrpCfg, iface: Iface, n: EigrpNbr, msg: EigrpMsg): void {
  for (const r of msg.routes ?? []) {
    const k = key(r.prefix, r.plen);
    const t = c.topology[k];
    if (!t) {
      enqueue(rt, c, n, 'reply', [{ ...r, unreachable: true }]);
      continue;
    }
    const wasSucc = t.succ === n.ip;
    t.paths = t.paths.filter((p) => p.via !== n.ip);
    if (t.active) {
      enqueue(rt, c, n, 'reply', [routeFor(rt, c, k, undefined, iface.id)]);
      continue;
    }
    if (wasSucc) t.origin = n.ip;
    evaluate(rt, c, k, t);
    const now = c.topology[k];
    if (!now?.active) {
      if (wasSucc) t.origin = undefined;
      enqueue(rt, c, n, 'reply', [routeFor(rt, c, k, now, iface.id, true)]);
    }
  }
}

function rxReply(rt: Rt, c: EigrpCfg, iface: Iface, n: EigrpNbr, msg: EigrpMsg): void {
  for (const r of msg.routes ?? []) {
    const k = applyRoute(rt, c, iface, n, r);
    const t = c.topology[k];
    if (!t) continue;
    if (t.active) {
      t.waiting = t.waiting.filter((x) => x !== n.ip);
      if (t.waiting.length === 0) finishActive(rt, c, k, t);
    } else evaluate(rt, c, k, t);
  }
}

// ------------------------------------------------------------------ Recompute

export function eigrpRecompute(rt: Rt): boolean {
  let changed = false;
  const known = new Set(eigrpProcs(rt).map(eigrpSrc));
  const orphan = rt.cfg.dynRoutes.filter((r) => r.src.startsWith('eigrp:') && !known.has(r.src));
  if (orphan.length) {
    rt.cfg.dynRoutes = rt.cfg.dynRoutes.filter((r) => !orphan.includes(r));
    changed = true;
  }
  const orphan6 = rt.cfg.dynRoutes6.filter((r) => r.src.startsWith('eigrp6:') && !known.has(r.src));
  if (orphan6.length) {
    rt.cfg.dynRoutes6 = rt.cfg.dynRoutes6.filter((r) => !orphan6.includes(r));
    changed = true;
  }
  for (const c of eigrpProcs(rt)) {
    if (!enabled(rt, c)) {
      // abgeschaltet: keine Nachbarn, keine Topologie, keine Routen
      if (Object.keys(c.neighbors).length || Object.keys(c.topology).length) eigrpReset(c);
      if (installRoutes(rt, eigrpSrc(c), [], !!c.v6)) changed = true;
      continue;
    }
    if (syncLocals(rt, c)) changed = true;
    if (applyDistChange(rt, c)) changed = true;
    flushAdv(rt, c);
    const routes = [];
    for (const t of Object.values(c.topology)) {
      const p0 = t.paths.find((x) => x.via === t.succ);
      if (!p0 || p0.via === 'local') continue;
      // Successors (gleiche Distanz) + Feasible Successors innerhalb der Variance
      const variance = Math.max(1, c.variance);
      const usable = t.paths
        .filter(
          (p) =>
            p.via !== 'local' &&
            (p.dist === t.fd || (variance > 1 && p.rd < t.fd && p.dist <= variance * t.fd)),
        )
        .sort((a, b) => a.dist - b.dist || a.via.localeCompare(b.via))
        .slice(0, maxPathsOf(c));
      if (!usable.some((p) => p === p0)) usable.unshift(p0);
      const unequal = usable.some((p) => p.dist !== t.fd);
      for (const p of usable) {
        const ext = !!p.external;
        routes.push({
          proto: 'D' as const,
          sub: ext ? 'EX' : undefined,
          prefix: t.prefix,
          plen: t.plen,
          ad: ext ? AD.eigrpExt : AD.eigrp,
          metric: p.dist,
          nextHop: p.via,
          ifaceId: p.ifaceId,
          share: unequal ? Math.max(1, Math.floor((t.fd * 100) / p.dist)) : undefined,
        });
      }
    }
    if (installRoutes(rt, eigrpSrc(c), routes as never, !!c.v6)) changed = true;
  }
  return changed;
}

/** `distribute-list` geändert: Pfade neu filtern, Ankündigungen erneuern (gefilterte werden zurückgezogen). */
function applyDistChange(rt: Rt, c: EigrpCfg): boolean {
  const sig = JSON.stringify(c.distributeLists ?? []);
  if (sig === (c.distSig ?? '[]')) return false;
  c.distSig = sig;
  for (const [k, t] of Object.entries(c.topology)) {
    t.paths = t.paths.filter((p) => p.via === 'local' || dp(rt, c, 'in', p.ifaceId, t));
    evaluate(rt, c, k, t);
    queueAdv(c, k);
  }
  withdrawDenied = true;
  flushAdv(rt, c);
  withdrawDenied = false;
  return true;
}

/** Direkt angeschlossene und redistribuierte Ziele als lokale Pfade führen. */
function syncLocals(rt: Rt, c: EigrpCfg): boolean {
  const want = new Map<string, EigrpPath & { prefix: string; plen: number }>();
  const ifs = eigrpIfaces(rt, c);
  for (const i of ifs) {
    const delay = ifaceDelay(rt, i);
    const bandwidth = ifaceBwKbps(rt, i);
    for (const { prefix, plen } of localPrefixes(rt, c, i))
      want.set(key(prefix, plen), {
        prefix,
        plen,
        via: 'local',
        ifaceId: i.id,
        rd: 0,
        dist: metricOf(bandwidth, delay),
        delay,
        bandwidth,
        hops: 0,
      });
  }
  const rid = eigrpRid(rt, c);
  for (const red of c.redistribute) {
    const srcs = c.v6 ? redistSource6(rt, red, eigrpSrc(c)) : redistSource(rt, red, eigrpSrc(c));
    for (const s of srcs) {
      if (
        s.plen === 0 ||
        ifs.some((i) =>
          localPrefixes(rt, c, i).some((p) => p.prefix === s.prefix && p.plen === s.plen),
        )
      )
        continue;
      // IOS: ohne Startmetrik sind aus OSPF/RIP/BGP übernommene Routen unerreichbar (nur connected,
      // static und andere EIGRP-Prozesse bringen eine Metrik mit)
      const seeded =
        s.set?.eigrpMetric !== undefined ||
        red.bw !== undefined ||
        red.source === 'connected' ||
        red.source === 'static' ||
        red.source === 'eigrp';
      if (!seeded) continue;
      const bandwidth = s.set?.eigrpMetric?.bw ?? red.bw ?? 100_000;
      const delay = s.set?.eigrpMetric?.delay ?? red.delay ?? 10;
      want.set(key(s.prefix, s.plen), {
        prefix: s.prefix,
        plen: s.plen,
        via: 'local',
        ifaceId: s.ifaceId ?? '',
        rd: 0,
        dist: metricOf(bandwidth, delay),
        delay,
        bandwidth,
        hops: 0,
        external: { proto: red.source, router: rid },
      });
    }
  }
  let changed = false;
  for (const [k, t] of Object.entries(c.topology)) {
    const loc = t.paths.find((p) => p.via === 'local');
    if (loc && !want.has(k)) {
      t.paths = t.paths.filter((p) => p.via !== 'local');
      evaluate(rt, c, k, t);
      changed = true;
    }
  }
  for (const [k, w] of want) {
    const { prefix, plen, ...path } = w;
    const t = topoFor(c, prefix, plen);
    const cur = t.paths.find((p) => p.via === 'local');
    if (!cur || JSON.stringify(cur) !== JSON.stringify(path)) {
      setPath(t, path);
      evaluate(rt, c, k, t);
      changed = true;
    }
  }
  return changed;
}

const maskLen = (mask: string): number => {
  const n = mask.split('.').reduce((a, b) => a * 256 + Number(b), 0) >>> 0;
  let c = 0;
  for (let b = 31; b >= 0; b--) if (((n >>> b) & 1) === 1) c++;
  return c;
};
const netOf = (ip: string, plen: number): string => {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  const n = (ip.split('.').reduce((a, b) => a * 256 + Number(b), 0) & m) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
};

// ------------------------------------------------------------------ Timer

export function eigrpTimer(rt: Rt, name: string): boolean {
  const v6 = name.startsWith('rt:eigrp6:');
  if (!v6 && !name.startsWith('rt:eigrp:')) return false;
  const parts = name.split(':');
  const kind = parts[2];
  // der Rest kann Doppelpunkte enthalten (IPv6-Nachbar, IPv6-Präfix)
  const rest = parts.slice(4).join(':');
  const c = procOf(rt, Number(parts[3]), v6);
  if (!c || !enabled(rt, c)) return true;
  if (kind === 'hello') {
    const iface = ifOf(rt, c, rest);
    if (iface && !isPassive(c, iface.id)) emit(rt, c, iface, undefined, msgBase(rt, c, 'hello'));
    return true;
  }
  if (kind === 'sia') {
    // rest = Präfix (`a.b.c.d/len`)
    const t = c.topology[rest];
    if (t?.active) {
      rlog(rt, 'EIGRP', {
        key: 'eigrp.sia',
        params: { prefix: rest, nbrs: t.waiting.join(', ') },
      });
      // Nachbarn, die nicht geantwortet haben, werden zurückgesetzt (IOS: „stuck in active“)
      for (const ip of [...t.waiting]) {
        const n = c.neighbors[ip];
        if (n) killNbr(rt, c, n, 'stuck in active');
      }
      const again = c.topology[rest];
      if (again?.active) finishActive(rt, c, rest, again);
    }
    return true;
  }
  if (kind === 'hold') {
    const n = c.neighbors[rest];
    if (n) killNbr(rt, c, n, 'holding time expired');
    return true;
  }
  if (kind === 'rxmt') {
    const n = c.neighbors[rest];
    if (!n || n.queue.length === 0) return true;
    if ((n.queue[0]?.tries ?? 0) >= MAX_TRIES) {
      killNbr(rt, c, n, 'retry limit exceeded');
      return true;
    }
    transmit(rt, c, n);
    return true;
  }
  return true;
}

void inNet;
