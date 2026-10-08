import type { BgpAttrs, BgpMsg, Ipv4Pdu } from '@netsim/protocols';
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
  sendRouted,
  setBg,
  type Rt,
} from './core';
import { lookupRib } from '../rib';
import type { Iface } from '../ifaces';
import type { BgpCfg, BgpNbrCfg, BgpPath } from './types';

const HOLD = 180;
const KEEPALIVE = 60;
const CONNECT_RETRY = 5 * SEC;

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
  `${a.origin}|${a.asPath.join(' ')}|${a.nextHop}|${a.med ?? ''}|${a.localPref ?? ''}`;

function send(rt: Rt, c: BgpCfg, n: BgpNbrCfg, msg: BgpMsg): boolean {
  const src = sourceFor(rt, n);
  if (!src) return false;
  const ttl = isEbgp(c, n) ? (n.ebgpMultihop ?? 1) : 255;
  const ok = sendRouted(
    rt,
    src,
    n.ip,
    { kind: 'routing', proto: 'bgp', sport: 40000 + (ipNum(n.ip) & 0xff), dport: 179, msg },
    ttl,
  );
  if (ok) n.lastTx = rt.ctx.now;
  dbg(rt, 'BGP', 'bgp', () => `BGP: ${n.ip} send ${msg.type.toUpperCase()}`);
  return ok;
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
}

export function bgpStop(rt: Rt): void {
  cancelBg(rt, 'rt:bgp:tick');
}

export function bgpReset(c: BgpCfg): void {
  c.locRib = {};
  c.rid = undefined;
  c.timersArmed = false;
  for (const n of Object.values(c.neighbors)) {
    n.state = 'idle';
    n.ribIn = {};
    n.advertised = {};
    n.prefixesRx = 0;
    n.routerId = undefined;
    n.established = undefined;
  }
}

function resetSession(rt: Rt, c: BgpCfg, n: BgpNbrCfg, why: string, notify: boolean): void {
  const was = n.state;
  if (notify && was !== 'idle') send(rt, c, n, { type: 'notification', code: 6, text: why });
  n.state = 'idle';
  n.ribIn = {};
  n.advertised = {};
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
    if (n.state === 'established' || n.state === 'openconfirm') {
      if (rt.ctx.now - n.lastRx > n.holdSec * SEC) {
        resetSession(rt, c, n, 'hold timer expired', true);
        continue;
      }
      if (rt.ctx.now - n.lastTx >= KEEPALIVE * SEC) send(rt, c, n, { type: 'keepalive' });
      continue;
    }
    if (!reachable(rt, c, n)) continue;
    // Verbindungsaufbau: OPEN senden
    n.state = n.state === 'idle' ? 'connect' : n.state;
    if (send(rt, c, n, { type: 'open', asn: c.asn, holdSec: HOLD, routerId: bgpRid(rt, c) })) {
      setState(rt, c, n, 'opensent');
      n.lastRx = rt.ctx.now;
    }
  }
  return true;
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

export function bgpRx(rt: Rt, _iface: Iface, ip: Ipv4Pdu, msg: BgpMsg): void {
  void _iface;
  const c = rt.r.bgp;
  if (!c) return;
  const n = c.neighbors[ip.src];
  if (!n || n.shutdown) return;
  rlog(
    rt,
    'BGP',
    { key: 'bgp.rx', params: { type: msg.type, src: ip.src } },
    {
      kind: 'rx',
      status: 'ok',
      debug: { tag: 'bgp', text: () => `BGP: ${ip.src} rcv ${msg.type.toUpperCase()}` },
    },
  );
  n.lastRx = rt.ctx.now;
  switch (msg.type) {
    case 'open': {
      if (msg.asn !== n.asn) {
        send(rt, c, n, { type: 'notification', code: 2, text: 'bad peer AS' });
        resetSession(rt, c, n, 'bad peer AS', false);
        return;
      }
      n.routerId = msg.routerId;
      n.holdSec = Math.min(HOLD, msg.holdSec);
      if (n.state === 'idle' || n.state === 'connect') {
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

function rxUpdate(rt: Rt, c: BgpCfg, n: BgpNbrCfg, m: Extract<BgpMsg, { type: 'update' }>): void {
  for (const w of m.withdrawn) delete n.ribIn[pkey(w.prefix, w.plen)];
  if (m.attrs) {
    const a = m.attrs;
    const ebgp = isEbgp(c, n);
    if (ebgp && a.asPath.includes(c.asn)) {
      // AS-Pfad-Schleife
      dbg(rt, 'BGP', 'bgp', () => `BGP: ${n.ip} rejected NLRI, AS path loop`);
    } else {
      for (const p of m.nlri) {
        n.ribIn[pkey(p.prefix, p.plen)] = {
          prefix: p.prefix,
          plen: p.plen,
          attrs: { ...a, localPref: ebgp ? undefined : (a.localPref ?? c.defaultLocalPref) },
          from: n.ip,
          ebgp,
          fromRid: n.routerId ?? n.ip,
          weight: n.weight ?? 0,
          local: false,
        };
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
    for (const p of Object.values(n.ribIn)) {
      if (igpMetric(rt, p.attrs.nextHop) === undefined) continue; // Next-Hop unerreichbar
      add({ ...p, weight: n.weight ?? p.weight });
    }
  }
  const loc: Record<string, BgpPath> = {};
  for (const [k, list] of cand) {
    let best = list[0] as BgpPath;
    for (const p of list.slice(1)) if (betterPath(rt, c, p, best)) best = p;
    loc[k] = best;
  }
  const locChanged = JSON.stringify(loc) !== JSON.stringify(c.locRib);
  c.locRib = loc;

  // Routen installieren
  const routes = [];
  for (const p of Object.values(loc)) {
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
      ifaceId: e.ifaceId,
    });
  }
  let changed = installRoutes(rt, 'bgp', routes);
  if (advertise(rt, c)) changed = true;
  return changed || locChanged;
}

// ------------------------------------------------------------------ Advertise

function exportAttrs(rt: Rt, c: BgpCfg, n: BgpNbrCfg, p: BgpPath): BgpAttrs | undefined {
  const ebgp = isEbgp(c, n);
  if (p.from === n.ip) return undefined; // nicht zurück zum Absender
  if (!ebgp && !p.local && !p.ebgp) return undefined; // iBGP → iBGP nicht weitergeben
  if (ebgp && p.attrs.asPath.includes(n.asn)) return undefined;
  const self = sourceFor(rt, n) ?? '0.0.0.0';
  if (ebgp) {
    return {
      origin: p.attrs.origin,
      asPath: [c.asn, ...p.attrs.asPath],
      nextHop: self,
      med: p.local ? p.attrs.med : undefined,
    };
  }
  return {
    origin: p.attrs.origin,
    asPath: p.attrs.asPath,
    nextHop: p.local || n.nextHopSelf ? self : p.attrs.nextHop,
    med: p.attrs.med,
    localPref: p.attrs.localPref ?? c.defaultLocalPref,
  };
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
