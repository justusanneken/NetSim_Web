import type {
  Ipv4Addr,
  OspfAuth,
  OspfLsa,
  OspfLsaBody,
  OspfLsaHeader,
  OspfMsg,
  OspfRouterLink,
} from '@netsim/protocols';
import { ipv6Network, parseIpv4 } from '@netsim/protocols';
import type { Iface } from '../ifaces';
import type { Base } from '../l3';
import {
  SEC,
  cancelBg,
  dbg,
  distPermits,
  ifaceBwKbps,
  inNet,
  installRoutes,
  plenOfMask,
  redistSource,
  redistSource6,
  rlog,
  sendMcast,
  sendNbr,
  sendRouted,
  setBg,
  wildcardMatch,
  type Rt,
} from './core';
import { requestRecompute } from './index';
import { sendMcast6, sendNbr6, type Iface6 } from '../l3v6';
import { spfRun } from './ospfspf';
import {
  isPassive,
  maxPathsOf,
  type OspfAreaCfg,
  type OspfCfg,
  type OspfExternal,
  type OspfIfState,
  type OspfNbr,
  type OspfNbrState,
  type OspfVlink,
} from './types';
import type { IfaceCfg } from '../types';

export const OSPF_ALL = '224.0.0.5';
export const OSPF_DR = '224.0.0.6';
export const MAXAGE = 3600;
export const INIT_SEQ = 0x80000001;
const LS_REFRESH = 1800;
const RXMT = 5 * SEC;
const NO_ID = '0.0.0.0';

/** Zuletzt erkannter Zustand der virtuellen Links je Prozess (nur Laufzeit-Cache, nicht im Snapshot nötig). */
const vlSigs = new WeakMap<OspfCfg, string>();

function markDirty(rt: Rt, c: OspfCfg): void {
  c.dirty = true;
  requestRecompute(rt);
}

export const newOspf = (pid: number, v6 = false): OspfCfg => ({
  pid,
  networks: [],
  passive: [],
  unpassive: [],
  passiveDefault: false,
  refBwMbps: 100,
  redistribute: [],
  ranges: [],
  v6,
  ifs: {},
  lsdb: {},
  installed: {},
  seqs: {},
  externals: {},
  spfRuns: 0,
  lastSpf: 0,
  dirty: true,
});

// ------------------------------------------------------------------ Hilfen

const ipNum = (ip: string): number => parseIpv4(ip) ?? 0;

export const areaCfg = (c: OspfCfg, area: string): OspfAreaCfg =>
  c.areas?.[area] ?? { id: area, type: 'normal', noSummary: false };
export const areaTypeOf = (c: OspfCfg, area: string): 'normal' | 'stub' | 'nssa' =>
  areaCfg(c, area).type;

/** Vereinfachter MD5-„Digest“ (kein echter Hash): nur zum Vergleich gemeinsamer Schlüssel. */
export const authDigest = (key: string): string => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** Wirksame Authentifizierung einer Schnittstelle: Interface-Einstellung vor Area-Einstellung. */
export function authMode(c: OspfCfg, iface: Iface, area: string): 'simple' | 'md5' | undefined {
  const ic = ifCfg(iface, c);
  const m = ic?.auth ?? areaCfg(c, area).auth;
  return m === 'null' ? undefined : m;
}

function authFor(c: OspfCfg, iface: Iface, area: string): OspfAuth | undefined {
  const mode = authMode(c, iface, area);
  const ic = ifCfg(iface, c);
  if (mode === 'simple') return { type: 'simple', key: ic?.authKey ?? '' };
  if (mode === 'md5') {
    const id = Math.min(...Object.keys(ic?.md5Keys ?? { 0: '' }).map(Number));
    return { type: 'md5', keyId: id, digest: authDigest(ic?.md5Keys?.[id] ?? '') };
  }
  return undefined;
}

function authAccepts(c: OspfCfg, iface: Iface, area: string, got: OspfAuth | undefined): boolean {
  const mode = authMode(c, iface, area);
  const ic = ifCfg(iface, c);
  if (!mode) return got === undefined;
  if (!got || got.type !== mode) return false;
  if (got.type === 'simple') return got.key === (ic?.authKey ?? '');
  const key = ic?.md5Keys?.[got.keyId];
  return key !== undefined && authDigest(key) === got.digest;
}
export const cmpId = (a: string, b: string): number => ipNum(a) - ipNum(b);
export const lsaKey = (h: { type: number; id: string; advRouter: string }): string =>
  `${h.type}|${h.id}|${h.advRouter}`;
const areaOfType = (type: number, area: string): string => (type === 5 ? 'as' : area);
export const stateRank: Record<OspfNbrState, number> = {
  down: 0,
  init: 1,
  '2way': 2,
  exstart: 3,
  exchange: 4,
  loading: 5,
  full: 6,
};

const nameOf = (rt: Rt, iface: Iface): string => rt.ctx.deviceIfaceName(iface.id);

/** Timer-Präfix: OSPFv2 `rt:ospf`, OSPFv3 `rt:ospf6`. */
export const tp = (c: OspfCfg): string => (c.v6 ? 'rt:ospf6' : 'rt:ospf');
export const srcOf = (c: OspfCfg): string => `${c.v6 ? 'ospf6' : 'ospf'}:${c.pid}`;
export const procsOf = (rt: Rt): OspfCfg[] => [
  ...Object.values(rt.r.ospf),
  ...Object.values(rt.r.ospf6),
];

export interface Pfx {
  prefix: string;
  plen: number;
}

/** Schnittstellen eines Prozesses: IPv4 direkt, IPv6 als Pseudo-Schnittstellen (Adresse = Link-Local). */
export function ospfIfaces(rt: Rt, c: OspfCfg): Iface[] {
  if (!c.v6) return rt.node.ifaces;
  return (rt.node.v6?.ifaces ?? []).map(pseudoIface);
}

export const pseudoIface = (i: Iface6): Iface => ({
  id: i.id,
  kind: i.kind,
  portId: i.portId,
  vlan: i.vlan,
  mac: i.mac,
  ip: i.ll,
  mask: '',
  mtu: i.mtu,
  cfg: i.cfg,
  v6Prefixes: i.addrs.map((a) => ({ prefix: ipv6Network(a.addr, a.plen), plen: a.plen })),
});

// ------------------------------------------------------------------ Virtual Links

export const vlId = (rid: string): string => `vl-${rid.replaceAll('.', '_')}`;
export const isVl = (id: string): boolean => id.startsWith('vl-');
export const vlinkOf = (c: OspfCfg, id: string): OspfVlink | undefined =>
  c.vlinks?.find((v) => vlId(v.rid) === id);

/** Adressen des virtuellen Links: eigene Adresse im Transitbereich und Adresse des Peers (aus dessen Router-LSA). */
export function vlEndpoints(
  rt: Rt,
  c: OspfCfg,
  v: OspfVlink,
): { local: string; remote: string } | undefined {
  if (c.v6 || v.area === '0') return undefined;
  const mine = physicalParts(rt, c).find((p) => p.area === v.area);
  const lsa = Object.values(c.lsdb[v.area] ?? {}).find(
    (l) => l.body.type === 1 && l.advRouter === v.rid && l.age < MAXAGE,
  );
  const remote =
    lsa?.body.type === 1 ? lsa.body.links.find((l) => l.addr !== undefined)?.addr : undefined;
  if (!mine || !remote || !rt.node.lookup(remote)) return undefined;
  return { local: mine.iface.ip, remote };
}

function vlIface(rt: Rt, c: OspfCfg, v: OspfVlink): Iface | undefined {
  const ep = vlEndpoints(rt, c, v);
  if (!ep) return undefined;
  return {
    id: vlId(v.rid),
    kind: 'tunnel',
    portId: '',
    mac: '',
    ip: ep.local,
    mask: '255.255.255.255',
    mtu: 1500,
    cfg: { kind: 'tunnel' } as IfaceCfg,
  };
}

export const ifaceOf = (rt: Rt, c: OspfCfg, id: string): Iface | undefined => {
  if (isVl(id)) {
    const v = vlinkOf(c, id);
    return v ? vlIface(rt, c, v) : undefined;
  }
  return ospfIfaces(rt, c).find((i) => i.id === id);
};

/** Angeschlossene Präfixe (IPv4: ein Netz aus Adresse/Maske, IPv6: alle globalen Präfixe). */
export function prefixesOf(c: OspfCfg, iface: Iface): Pfx[] {
  if (isVl(iface.id)) return [];
  if (c.v6) return iface.v6Prefixes ?? [];
  if (iface.kind === 'loop') return [{ prefix: iface.ip, plen: 32 }];
  const plen = plenOfMask(iface.mask);
  return [{ prefix: networkOf(iface.ip, plen), plen }];
}

export function ifCfg(iface: Iface, c: OspfCfg): NonNullable<Iface['cfg']['ospf']> | undefined {
  const o = c.v6 ? iface.cfg.v6?.ospf : iface.cfg.ospf;
  return o && (o.pid === undefined || o.pid === c.pid) ? o : undefined;
}
export const ifNetwork = (iface: Iface, c: OspfCfg): 'broadcast' | 'point-to-point' =>
  ifCfg(iface, c)?.network ??
  (iface.kind === 'tunnel' || iface.cfg.serial ? 'point-to-point' : 'broadcast');
export const ifHello = (iface: Iface, c: OspfCfg): number => ifCfg(iface, c)?.helloSec ?? 10;
export const ifDead = (iface: Iface, c: OspfCfg): number =>
  ifCfg(iface, c)?.deadSec ?? ifHello(iface, c) * 4;
export const ifPriority = (iface: Iface, c: OspfCfg): number => ifCfg(iface, c)?.priority ?? 1;

export function ifCost(rt: Rt, iface: Iface, c: OspfCfg): number {
  if (isVl(iface.id)) return vlinkOf(c, iface.id)?.cost ?? 1;
  const set = ifCfg(iface, c)?.cost;
  if (set !== undefined) return set;
  if (iface.kind === 'loop') return 1;
  const bw = ifaceBwKbps(rt, iface);
  return Math.max(1, Math.floor((c.refBwMbps * 1000) / bw));
}

export function ospfRid(rt: Rt, c: OspfCfg): string {
  if (c.routerId) return c.routerId;
  if (c.rid) return c.rid;
  const loops = rt.node.ifaces.filter((i) => i.kind === 'loop').map((i) => i.ip);
  const all = loops.length ? loops : rt.node.ifaces.map((i) => i.ip);
  const rid = all.sort(cmpId).at(-1);
  if (rid) c.rid = rid;
  return rid ?? NO_ID;
}

export const effectiveRid = (rt: Rt, c: OspfCfg): string => c.routerId ?? c.rid ?? ospfRid(rt, c);

interface Part {
  iface: Iface;
  area: string;
}

export function participants(rt: Rt, c: OspfCfg): Part[] {
  const out = physicalParts(rt, c);
  for (const v of c.vlinks ?? []) {
    const iface = vlIface(rt, c, v);
    if (iface) out.push({ iface, area: '0' });
  }
  return out;
}

function physicalParts(rt: Rt, c: OspfCfg): Part[] {
  const out: Part[] = [];
  if (c.v6 && effectiveRid(rt, c) === NO_ID) return out;
  for (const iface of ospfIfaces(rt, c)) {
    const ic = c.v6 ? iface.cfg.v6?.ospf : iface.cfg.ospf;
    if (ic && ic.pid !== undefined && ic.pid !== c.pid) continue;
    let area = ic?.area;
    if (area === undefined && !c.v6)
      area = c.networks.find((n) => wildcardMatch(iface.ip, n.prefix, n.wildcard))?.area;
    if (area !== undefined) out.push({ iface, area });
  }
  return out;
}

export const areasOf = (parts: Part[]): string[] => [...new Set(parts.map((p) => p.area))];

function lsdbOf(c: OspfCfg, area: string): Record<string, OspfLsa> {
  return (c.lsdb[area] ??= {});
}

export function lsaAge(c: OspfCfg, area: string, key: string, now: number): number {
  const l = c.lsdb[area]?.[key];
  if (!l) return 0;
  const inst = c.installed[`${area}|${key}`] ?? now;
  return Math.min(MAXAGE, l.age + Math.floor((now - inst) / SEC));
}

const hdrOf = (c: OspfCfg, area: string, l: OspfLsa, now: number): OspfLsaHeader => ({
  type: l.type,
  id: l.id,
  advRouter: l.advRouter,
  seq: l.seq,
  age: lsaAge(c, area, lsaKey(l), now),
});

const newer = (a: { seq: number; age: number }, b: { seq: number; age: number }): boolean =>
  a.seq > b.seq || (a.seq === b.seq && a.age >= MAXAGE && b.age < MAXAGE);

// ------------------------------------------------------------------ Senden

function send(rt: Rt, c: OspfCfg, iface: Iface, dst: Ipv4Addr, msg0: OspfMsg): void {
  const auth = authFor(c, iface, msg0.areaId);
  const msg: OspfMsg = auth ? ({ ...msg0, auth } as OspfMsg) : msg0;
  const payload = {
    kind: 'routing' as const,
    proto: 'ospf' as const,
    v: (c.v6 ? 3 : 2) as 2 | 3,
    msg,
  };
  if (isVl(iface.id)) {
    const v = vlinkOf(c, iface.id);
    const ep = v && vlEndpoints(rt, c, v);
    if (ep)
      sendRouted(rt, ep.local, dst === OSPF_ALL || dst === OSPF_DR ? ep.remote : dst, payload, 255);
    return;
  }
  if (c.v6) {
    const n6 = rt.node.v6;
    const i6 = n6?.ifaces.find((i) => i.id === iface.id);
    if (!n6 || !i6) return;
    const host = { cfg: rt.node.cfg, v6: n6, xmit: rt.node.xmit };
    if (dst === OSPF_ALL || dst === OSPF_DR)
      sendMcast6(rt.ctx, host, i6, dst === OSPF_ALL ? 'ff02::5' : 'ff02::6', payload);
    else sendNbr6(rt.ctx, host, i6, dst, payload);
    return;
  }
  if (dst === OSPF_ALL || dst === OSPF_DR) sendMcast(rt, iface, dst, payload);
  else sendNbr(rt, iface, dst, payload);
}

function sendHello(rt: Rt, c: OspfCfg, iface: Iface, ifs: OspfIfState): void {
  const rid = effectiveRid(rt, c);
  const msg: OspfMsg = {
    type: 'hello',
    routerId: rid,
    areaId: ifs.area,
    helloSec: ifHello(iface, c),
    deadSec: ifDead(iface, c),
    priority: ifPriority(iface, c),
    dr: ifs.dr,
    bdr: ifs.bdr,
    neighbors: Object.values(ifs.neighbors)
      .filter((n) => stateRank[n.state] >= 1)
      .map((n) => n.rid),
    plen: c.v6 ? undefined : plenOfMask(iface.mask),
    areaType: areaTypeOf(c, ifs.area),
  };
  send(rt, c, iface, OSPF_ALL, msg);
  dbg(
    rt,
    'OSPF',
    'ospf.hello',
    () =>
      `OSPF-${c.pid} HELLO ${nameOf(rt, iface)}: Send hello to ${OSPF_ALL} area ${ifs.area} from ${iface.ip}`,
  );
}

// ------------------------------------------------------------------ Sync

export function ospfSync(rt: Rt): void {
  const procs = procsOf(rt);
  // verwaiste Routen entfernen (Prozess gelöscht)
  const known = new Set(procs.map(srcOf));
  const orphan = rt.cfg.dynRoutes.filter((r) => r.src.startsWith('ospf:') && !known.has(r.src));
  if (orphan.length) rt.cfg.dynRoutes = rt.cfg.dynRoutes.filter((r) => !orphan.includes(r));
  const orphan6 = rt.cfg.dynRoutes6.filter((r) => r.src.startsWith('ospf6:') && !known.has(r.src));
  if (orphan6.length) rt.cfg.dynRoutes6 = rt.cfg.dynRoutes6.filter((r) => !orphan6.includes(r));
  for (const c of procs) syncProcess(rt, c);
}

function syncProcess(rt: Rt, c: OspfCfg): void {
  const parts = participants(rt, c);
  const byId = new Map(parts.map((p) => [p.iface.id, p]));
  // Schnittstellen entfernen
  for (const [id, ifs] of Object.entries(c.ifs)) {
    const p = byId.get(id);
    const wantP2p = p ? ifNetwork(p.iface, c) === 'point-to-point' : false;
    const isActive = ifs.state !== 'loopback';
    if (!p || p.area !== ifs.area || (isActive && wantP2p !== (ifs.state === 'p2p'))) {
      ifDown(rt, c, id, ifs);
      delete c.ifs[id];
    }
  }
  const rid = effectiveRid(rt, c);
  if (!c.timersArmed) {
    c.timersArmed = true;
    setBg(rt, `${tp(c)}:refresh:${c.pid}`, LS_REFRESH * SEC, LS_REFRESH * SEC);
    setBg(rt, `${tp(c)}:age:${c.pid}`, 60 * SEC, 60 * SEC);
  }
  for (const { iface, area } of parts) {
    const cur = c.ifs[iface.id];
    const passive = isPassive(c, iface.id);
    if (!cur) {
      const ifs: OspfIfState = {
        area,
        state: 'down',
        dr: NO_ID,
        bdr: NO_ID,
        drAddr: NO_ID,
        bdrAddr: NO_ID,
        waitUntil: 0,
        helloSec: ifHello(iface, c),
        neighbors: {},
      };
      c.ifs[iface.id] = ifs;
      if (iface.kind === 'loop' || passive) ifs.state = 'loopback';
      else {
        const isP2p = ifNetwork(iface, c) === 'point-to-point';
        ifs.state = isP2p ? 'p2p' : 'waiting';
        if (!isP2p) {
          ifs.waitUntil = rt.ctx.now + ifDead(iface, c) * SEC;
          setBg(rt, `${tp(c)}:wait:${c.pid}:${iface.id}`, ifDead(iface, c) * SEC);
        }
        setBg(
          rt,
          `${tp(c)}:hello:${c.pid}:${iface.id}`,
          100_000 + rt.ctx.rand(SEC),
          ifs.helloSec * SEC,
        );
        rlog(
          rt,
          'OSPF',
          { key: 'ospf.if.up', params: { iface: nameOf(rt, iface), area, rid } },
          {
            debug: {
              tag: 'ospf.events',
              text: () => `OSPF-${c.pid} IFSM ${nameOf(rt, iface)}: Interface up, area ${area}`,
            },
          },
        );
      }
      markDirty(rt, c);
    } else if (!(iface.kind === 'loop' || passive)) {
      if (cur.state === 'loopback') {
        // war passiv, ist jetzt aktiv
        delete c.ifs[iface.id];
        syncProcess(rt, c);
        return;
      }
      const hs = ifHello(iface, c);
      if (cur.helloSec !== hs) {
        cur.helloSec = hs;
        setBg(rt, `${tp(c)}:hello:${c.pid}:${iface.id}`, SEC, hs * SEC);
      }
    } else if (cur.state !== 'loopback') {
      // jetzt passiv: Nachbarn verwerfen
      ifDown(rt, c, iface.id, cur);
      delete c.ifs[iface.id];
      syncProcess(rt, c);
      return;
    }
  }
  originateAll(rt, c);
}

function ifDown(rt: Rt, c: OspfCfg, id: string, ifs: OspfIfState): void {
  cancelBg(rt, `${tp(c)}:hello:${c.pid}:${id}`);
  cancelBg(rt, `${tp(c)}:wait:${c.pid}:${id}`);
  for (const n of Object.values(ifs.neighbors)) killNbr(rt, c, id, ifs, n, 'Interface down', true);
  markDirty(rt, c);
}

export function ospfStop(rt: Rt): void {
  for (const c of procsOf(rt)) {
    for (const [id, ifs] of Object.entries(c.ifs)) ifDown(rt, c, id, ifs);
    cancelBg(rt, `${tp(c)}:refresh:${c.pid}`);
    cancelBg(rt, `${tp(c)}:age:${c.pid}`);
  }
}

// ------------------------------------------------------------------ Nachbarn

function setNbr(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  n: OspfNbr,
  to: OspfNbrState,
): void {
  if (n.state === to) return;
  const from = n.state;
  n.state = to;
  rlog(
    rt,
    'OSPF',
    { key: 'ospf.nbr', params: { rid: n.rid, ip: n.ip, iface: nameOf(rt, iface), from, to } },
    {
      status: to === 'full' ? 'ok' : 'info',
      debug: {
        tag: 'ospf.adj',
        text: () =>
          `OSPF-${c.pid} ADJ   ${nameOf(rt, iface)}: Nbr ${n.rid}: ${from.toUpperCase()} -> ${to.toUpperCase()}`,
      },
    },
  );
  if (from === 'full' || to === 'full') {
    originateAll(rt, c);
    markDirty(rt, c);
  }
}

function killNbr(
  rt: Rt,
  c: OspfCfg,
  ifaceId: string,
  ifs: OspfIfState,
  n: OspfNbr,
  why: string,
  silent = false,
): void {
  cancelBg(rt, `${tp(c)}:dead:${c.pid}:${ifaceId}:${n.rid}`);
  cancelBg(rt, `${tp(c)}:rxmt:${c.pid}:${ifaceId}:${n.rid}`);
  const iface = ifaceOf(rt, c, ifaceId as string);
  const was = n.state;
  delete ifs.neighbors[n.rid];
  rlog(
    rt,
    'OSPF',
    {
      key: 'ospf.nbr.down',
      params: { rid: n.rid, iface: rt.ctx.deviceIfaceName(ifaceId), reason: why },
    },
    {
      status: 'info',
      debug: {
        tag: 'ospf.adj',
        text: () =>
          `OSPF-${c.pid} ADJ   ${rt.ctx.deviceIfaceName(ifaceId)}: Nbr ${n.rid}: ${was.toUpperCase()} -> DOWN (${why})`,
      },
    },
  );
  if (silent) return;
  if (iface && ifs.state !== 'p2p' && ifs.state !== 'loopback') elect(rt, c, iface, ifs);
  if (was === 'full') {
    originateAll(rt, c);
    markDirty(rt, c);
  }
}

// ------------------------------------------------------------------ DR-Wahl

function elect(rt: Rt, c: OspfCfg, iface: Iface, ifs: OspfIfState): void {
  const rid = effectiveRid(rt, c);
  const pri = ifPriority(iface, c);
  interface Cand {
    rid: string;
    pri: number;
    dr: string;
    bdr: string;
  }
  const others: Cand[] = Object.values(ifs.neighbors)
    .filter((n) => stateRank[n.state] >= 2 && n.priority > 0)
    .map((n) => ({ rid: n.rid, pri: n.priority, dr: n.dr, bdr: n.bdr }));
  const best = (xs: Cand[]): Cand | undefined =>
    xs.reduce<Cand | undefined>(
      (b, x) => (!b || x.pri > b.pri || (x.pri === b.pri && cmpId(x.rid, b.rid) > 0) ? x : b),
      undefined,
    );
  let dr = ifs.dr;
  let bdr = ifs.bdr;
  for (let round = 0; round < 2; round++) {
    const me: Cand = { rid, pri, dr, bdr };
    const cands = pri > 0 ? [me, ...others] : others;
    const pool = cands.filter((x) => x.dr !== x.rid);
    const declBdr = pool.filter((x) => x.bdr === x.rid);
    const nb = best(declBdr.length ? declBdr : pool);
    const declDr = cands.filter((x) => x.dr === x.rid);
    const nd = best(declDr) ?? nb;
    const newDr = nd?.rid ?? NO_ID;
    const newBdr = nb && nb.rid !== newDr ? nb.rid : NO_ID;
    const roleChanged = (newDr === rid) !== (dr === rid) || (newBdr === rid) !== (bdr === rid);
    dr = newDr;
    bdr = newBdr;
    if (!roleChanged) break;
  }
  const changed = dr !== ifs.dr || bdr !== ifs.bdr;
  ifs.dr = dr;
  ifs.bdr = bdr;
  ifs.state = dr === rid ? 'dr' : bdr === rid ? 'bdr' : 'drother';
  const addrOf = (r: string): string => (r === rid ? iface.ip : (ifs.neighbors[r]?.ip ?? NO_ID));
  ifs.drAddr = dr === NO_ID ? NO_ID : addrOf(dr);
  ifs.bdrAddr = bdr === NO_ID ? NO_ID : addrOf(bdr);
  if (changed) {
    rlog(
      rt,
      'OSPF',
      { key: 'ospf.dr', params: { iface: nameOf(rt, iface), dr, bdr, state: ifs.state } },
      {
        debug: {
          tag: 'ospf.events',
          text: () =>
            `OSPF-${c.pid} IFSM ${nameOf(rt, iface)}: DR/BDR election -> DR ${dr}, BDR ${bdr}, state ${ifs.state.toUpperCase()}`,
        },
      },
    );
  }
  evalAdjacencies(rt, c, iface, ifs);
  if (changed) originateAll(rt, c);
}

const needAdj = (ifs: OspfIfState, n: OspfNbr): boolean =>
  ifs.state === 'p2p' ||
  ifs.state === 'dr' ||
  ifs.state === 'bdr' ||
  n.rid === ifs.dr ||
  n.rid === ifs.bdr;

function evalAdjacencies(rt: Rt, c: OspfCfg, iface: Iface, ifs: OspfIfState): void {
  for (const n of Object.values(ifs.neighbors)) {
    if (stateRank[n.state] < 2) continue;
    const want = needAdj(ifs, n);
    if (want && n.state === '2way') startAdj(rt, c, iface, ifs, n);
    else if (!want && stateRank[n.state] > 2) {
      n.reqList = [];
      n.retrans = {};
      n.dbdDone = false;
      setNbr(rt, c, iface, ifs, n, '2way');
    }
  }
}

function startAdj(rt: Rt, c: OspfCfg, iface: Iface, ifs: OspfIfState, n: OspfNbr): void {
  n.master = cmpId(effectiveRid(rt, c), n.rid) > 0;
  n.ddSeq = 1000 + rt.ctx.rand(1000);
  n.dbdDone = false;
  n.reqList = [];
  n.retrans = {};
  setNbr(rt, c, iface, ifs, n, 'exstart');
  sendDbd(rt, c, iface, ifs, n, true);
  setBg(rt, `${tp(c)}:rxmt:${c.pid}:${iface.id}:${n.rid}`, RXMT);
}

function lsdbHeaders(rt: Rt, c: OspfCfg, area: string): OspfLsaHeader[] {
  const out: OspfLsaHeader[] = [];
  for (const a of areaTypeOf(c, area) === 'normal' ? [area, 'as'] : [area]) {
    for (const l of Object.values(c.lsdb[a] ?? {})) out.push(hdrOf(c, a, l, rt.ctx.now));
  }
  return out;
}

function sendDbd(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  n: OspfNbr,
  init: boolean,
): void {
  send(rt, c, iface, n.ip, {
    type: 'dbd',
    routerId: effectiveRid(rt, c),
    areaId: ifs.area,
    init,
    more: false,
    master: n.master,
    ddSeq: n.ddSeq,
    headers: init ? [] : lsdbHeaders(rt, c, ifs.area),
    mtu: iface.mtu,
  });
}

// ------------------------------------------------------------------ Empfang

export function ospfRx(
  rt: Rt,
  iface0: Iface,
  _base: Base,
  ip: { src: string },
  msg: OspfMsg,
  v6 = false,
): void {
  void _base;
  for (const c of procsOf(rt)) {
    if (c.v6 !== v6) continue;
    let iface = iface0;
    let ifs = c.ifs[iface.id];
    if (msg.areaId === '0' && (!ifs || ifs.area !== '0')) {
      // Paket eines virtuellen Link-Peers (Backbone-Area, aber über eine Nicht-Backbone-Schnittstelle)
      const vifs = c.ifs[vlId(msg.routerId)];
      const viface = vifs && ifaceOf(rt, c, vlId(msg.routerId));
      if (vifs && viface) {
        ifs = vifs;
        iface = viface;
      }
    }
    if (!ifs || ifs.state === 'loopback') continue;
    if (ip.src === iface0.ip) return;
    if (msg.areaId !== ifs.area) {
      if (msg.type === 'hello')
        rlog(
          rt,
          'OSPF',
          { key: 'ospf.mismatch', params: { rid: msg.routerId, what: 'area' } },
          { kind: 'drop', status: 'drop' },
        );
      continue;
    }
    if (!authAccepts(c, iface, ifs.area, msg.auth)) {
      rlog(
        rt,
        'OSPF',
        {
          key: 'ospf.authFail',
          params: { src: ip.src, rid: msg.routerId, iface: nameOf(rt, iface) },
        },
        {
          kind: 'drop',
          status: 'drop',
          debug: {
            tag: 'ospf.adj',
            text: () =>
              `OSPF-${c.pid} ADJ   ${nameOf(rt, iface)}: Rx pkt from ${ip.src}: authentication failed (type ${msg.auth?.type ?? 'none'})`,
          },
        },
      );
      return;
    }
    rlog(
      rt,
      'OSPF',
      { key: 'ospf.rx', params: { type: msg.type, src: ip.src, rid: msg.routerId } },
      {
        kind: 'rx',
        status: 'ok',
        debug: {
          tag: 'ospf.packet',
          text: () =>
            `OSPF-${c.pid} PAK   ${nameOf(rt, iface)}: rcv. v:2 t:${msg.type.toUpperCase()} rid:${msg.routerId} aid:${msg.areaId} from ${ip.src}`,
        },
      },
    );
    switch (msg.type) {
      case 'hello':
        rxHello(rt, c, iface, ifs, ip, msg);
        break;
      case 'dbd':
        rxDbd(rt, c, iface, ifs, ip, msg);
        break;
      case 'lsr':
        rxLsr(rt, c, iface, ifs, ip, msg);
        break;
      case 'lsu':
        rxLsu(rt, c, iface, ifs, ip, msg);
        break;
      case 'lsack':
        rxAck(c, ifs, msg);
        break;
    }
    return;
  }
}

function rxHello(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  ip: { src: string },
  m: Extract<OspfMsg, { type: 'hello' }>,
): void {
  const myRid = effectiveRid(rt, c);
  if (m.routerId === myRid) return;
  const net = ifNetwork(iface, c);
  if ((m.areaType ?? 'normal') !== areaTypeOf(c, ifs.area)) {
    rlog(
      rt,
      'OSPF',
      { key: 'ospf.mismatch', params: { rid: m.routerId, what: 'area-type' } },
      { kind: 'drop', status: 'drop' },
    );
    return;
  }
  if (
    m.helloSec !== ifHello(iface, c) ||
    m.deadSec !== ifDead(iface, c) ||
    (net === 'broadcast' && m.plen !== undefined && m.plen !== plenOfMask(iface.mask))
  ) {
    rlog(
      rt,
      'OSPF',
      { key: 'ospf.mismatch', params: { rid: m.routerId, what: 'timers' } },
      { kind: 'drop', status: 'drop' },
    );
    return;
  }
  let n = ifs.neighbors[m.routerId];
  const isNew = !n;
  if (!n) {
    n = {
      rid: m.routerId,
      ip: ip.src,
      state: 'down',
      priority: m.priority,
      dr: m.dr,
      bdr: m.bdr,
      ddSeq: 0,
      master: false,
      lastHeard: rt.ctx.now,
      reqList: [],
      retrans: {},
      dbdDone: false,
    };
    ifs.neighbors[m.routerId] = n;
    setNbr(rt, c, iface, ifs, n, 'init');
  }
  void isNew;
  n.ip = ip.src;
  n.lastHeard = rt.ctx.now;
  const prevPri = n.priority;
  const prevDr = n.dr;
  const prevBdr = n.bdr;
  n.priority = m.priority;
  n.dr = m.dr;
  n.bdr = m.bdr;
  setBg(rt, `${tp(c)}:dead:${c.pid}:${iface.id}:${n.rid}`, ifDead(iface, c) * SEC);
  const sawMe = m.neighbors.includes(myRid);
  if (!sawMe) {
    if (stateRank[n.state] >= 2) {
      // 1-WayReceived
      n.reqList = [];
      n.retrans = {};
      n.dbdDone = false;
      setNbr(rt, c, iface, ifs, n, 'init');
      if (ifs.state !== 'p2p') elect(rt, c, iface, ifs);
    }
    return;
  }
  if (n.state === 'init') {
    setNbr(rt, c, iface, ifs, n, '2way');
    if (ifs.state === 'p2p') evalAdjacencies(rt, c, iface, ifs);
  }
  if (ifs.state === 'p2p') return;
  // Wait-Phase: BackupSeen beendet das Warten
  const backupSeen = m.bdr === m.routerId || (m.dr === m.routerId && m.bdr === NO_ID);
  if (ifs.state === 'waiting') {
    if (backupSeen) {
      cancelBg(rt, `${tp(c)}:wait:${c.pid}:${iface.id}`);
      elect(rt, c, iface, ifs);
    }
    return;
  }
  const changedDecl = prevPri !== n.priority || prevDr !== n.dr || prevBdr !== n.bdr;
  if (changedDecl || stateRank[n.state] === 2) elect(rt, c, iface, ifs);
}

function rxDbd(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  ip: { src: string },
  m: Extract<OspfMsg, { type: 'dbd' }>,
): void {
  const n = ifs.neighbors[m.routerId];
  if (!n || stateRank[n.state] < 2) return;
  n.ip = ip.src;
  if (n.state === '2way') {
    if (!needAdj(ifs, n)) return;
    startAdj(rt, c, iface, ifs, n);
  }
  // MTU-Mismatch: ein DBD mit größerer MTU des Nachbarn wird verworfen (Nachbar bleibt in EXSTART)
  if (m.mtu !== undefined && m.mtu > iface.mtu && !ifCfg(iface, c)?.mtuIgnore) {
    dbg(
      rt,
      'OSPF',
      'ospf.adj',
      () => `OSPF-${c.pid} ADJ   ${nameOf(rt, iface)}: Nbr ${m.routerId} has larger interface MTU`,
    );
    return;
  }
  if (m.init) {
    if (n.state === 'exstart') {
      setNbr(rt, c, iface, ifs, n, 'exchange');
      sendDbd(rt, c, iface, ifs, n, false);
    } else if (n.state === 'exchange' || n.state === 'loading' || n.state === 'full') {
      sendDbd(rt, c, iface, ifs, n, false);
    }
    return;
  }
  if (n.state === 'exstart') {
    setNbr(rt, c, iface, ifs, n, 'exchange');
    sendDbd(rt, c, iface, ifs, n, false);
  }
  if (n.dbdDone) return;
  n.dbdDone = true;
  const need: string[] = [];
  for (const h of m.headers) {
    const a = areaOfType(h.type, ifs.area);
    const have = c.lsdb[a]?.[lsaKey(h)];
    if (h.advRouter === effectiveRid(rt, c)) continue;
    if (!have || newer(h, hdrOf(c, a, have, rt.ctx.now))) need.push(lsaKey(h));
  }
  n.reqList = need;
  if (need.length === 0) {
    setNbr(rt, c, iface, ifs, n, 'full');
    cancelBg(rt, `${tp(c)}:rxmt:${c.pid}:${iface.id}:${n.rid}`);
    maybeRxmt(rt, c, iface, n);
    return;
  }
  setNbr(rt, c, iface, ifs, n, 'loading');
  sendLsr(rt, c, iface, ifs, n);
}

function sendLsr(rt: Rt, c: OspfCfg, iface: Iface, ifs: OspfIfState, n: OspfNbr): void {
  send(rt, c, iface, n.ip, {
    type: 'lsr',
    routerId: effectiveRid(rt, c),
    areaId: ifs.area,
    requests: n.reqList.map((k) => {
      const [type, id, advRouter] = k.split('|') as [string, string, string];
      return { type: Number(type), id, advRouter };
    }),
  });
  setBg(rt, `${tp(c)}:rxmt:${c.pid}:${iface.id}:${n.rid}`, RXMT);
}

function rxLsr(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  ip: { src: string },
  m: Extract<OspfMsg, { type: 'lsr' }>,
): void {
  const n = ifs.neighbors[m.routerId];
  if (!n || stateRank[n.state] < 3) return;
  const lsas: OspfLsa[] = [];
  for (const r of m.requests) {
    const k = lsaKey(r);
    const a = areaOfType(r.type, ifs.area);
    const l = c.lsdb[a]?.[k];
    if (l) lsas.push({ ...l, age: lsaAge(c, a, k, rt.ctx.now) });
  }
  if (lsas.length) sendLsu(rt, c, iface, n, lsas, ip.src);
}

function sendLsu(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  n: OspfNbr,
  lsas: OspfLsa[],
  dst?: string,
): void {
  send(rt, c, iface, dst ?? n.ip, {
    type: 'lsu',
    routerId: effectiveRid(rt, c),
    areaId: c.ifs[iface.id]?.area ?? '0',
    lsas,
  });
}

function rxLsu(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  ip: { src: string },
  m: Extract<OspfMsg, { type: 'lsu' }>,
): void {
  const n = ifs.neighbors[m.routerId];
  if (!n || stateRank[n.state] < 4) return;
  const myRid = effectiveRid(rt, c);
  const acks: OspfLsaHeader[] = [];
  const flood: OspfLsa[] = [];
  for (const l of m.lsas) {
    const k = lsaKey(l);
    const a = areaOfType(l.type, ifs.area);
    const have = c.lsdb[a]?.[k];
    const at = areaTypeOf(c, ifs.area);
    if ((l.type === 5 && at !== 'normal') || (l.type === 7 && at !== 'nssa')) continue;
    acks.push({ type: l.type, id: l.id, advRouter: l.advRouter, seq: l.seq, age: l.age });
    n.reqList = n.reqList.filter((x) => x !== k);
    if (l.advRouter === myRid) {
      // Fremdes Abbild einer eigenen LSA: wir sind maßgeblich
      if (!have || newer(l, hdrOf(c, a, have, rt.ctx.now))) {
        c.seqs[k] = Math.max(c.seqs[k] ?? INIT_SEQ, l.seq);
        if (have) reoriginate(rt, c, a, k);
        else flushLsa(rt, c, a, l);
      }
      continue;
    }
    if (!have || newer(l, hdrOf(c, a, have, rt.ctx.now))) {
      if (l.age >= MAXAGE) {
        if (have) {
          delete c.lsdb[a]?.[k];
          delete c.installed[`${a}|${k}`];
          markDirty(rt, c);
          flood.push(l);
        }
        continue;
      }
      install(rt, c, a, l);
      flood.push(l);
      dbg(
        rt,
        'OSPF',
        'ospf.lsa',
        () =>
          `OSPF-${c.pid} LSA   installing type ${l.type} id ${l.id} adv ${l.advRouter} seq ${l.seq.toString(16)}`,
      );
    } else if (have && newer(hdrOf(c, a, have, rt.ctx.now), l)) {
      sendLsu(rt, c, iface, n, [{ ...have, age: lsaAge(c, a, k, rt.ctx.now) }]);
    }
  }
  send(rt, c, iface, ip.src, { type: 'lsack', routerId: myRid, areaId: ifs.area, headers: acks });
  if (flood.length) floodLsas(rt, c, ifs.area, flood, m.routerId);
  if ((n.state === 'loading' || n.state === 'exchange') && n.dbdDone && n.reqList.length === 0) {
    cancelBg(rt, `${tp(c)}:rxmt:${c.pid}:${iface.id}:${n.rid}`);
    setNbr(rt, c, iface, ifs, n, 'full');
    maybeRxmt(rt, c, iface, n);
  }
}

function rxAck(c: OspfCfg, ifs: OspfIfState, m: Extract<OspfMsg, { type: 'lsack' }>): void {
  const n = ifs.neighbors[m.routerId];
  if (!n) return;
  for (const h of m.headers) {
    const k = lsaKey(h);
    if (n.retrans[k] !== undefined && n.retrans[k] <= h.seq) delete n.retrans[k];
  }
}

// ------------------------------------------------------------------ LSDB / Flooding

function install(rt: Rt, c: OspfCfg, area: string, l: OspfLsa): void {
  const k = lsaKey(l);
  lsdbOf(c, area)[k] = { ...l, age: l.age };
  c.installed[`${area}|${k}`] = rt.ctx.now;
  markDirty(rt, c);
}

/** Eine LSA an alle vollständig/fast vollständig benachbarten Router im Flooding-Bereich senden. */
function floodLsas(rt: Rt, c: OspfCfg, area: string, lsas: OspfLsa[], exceptRid?: string): void {
  // Typ 5 gilt AS-weit (alle normalen Bereiche), alle anderen LSAs nur im Bereich
  const ext = lsas.filter((l) => l.type === 5);
  const local = lsas.filter((l) => l.type !== 5);
  for (const [group, external] of [
    [ext, true],
    [local, false],
  ] as const) {
    if (group.length === 0) continue;
    for (const [id, ifs] of Object.entries(c.ifs)) {
      if (!external && ifs.area !== area) continue;
      if (external && areaTypeOf(c, ifs.area) !== 'normal') continue;
      const iface = ifaceOf(rt, c, id);
      if (!iface) continue;
      for (const n of Object.values(ifs.neighbors)) {
        if (stateRank[n.state] < 4 || n.rid === exceptRid) continue;
        const out = group.map((l) => {
          const a = areaOfType(l.type, area);
          const k = lsaKey(l);
          n.retrans[k] = l.seq;
          return { ...l, age: lsaAge(c, a, k, rt.ctx.now) || l.age };
        });
        sendLsu(rt, c, iface, n, out);
        maybeRxmt(rt, c, iface, n);
      }
    }
  }
}

function maybeRxmt(rt: Rt, c: OspfCfg, iface: Iface, n: OspfNbr): void {
  if (
    Object.keys(n.retrans).length > 0 ||
    n.state === 'exstart' ||
    n.state === 'exchange' ||
    n.state === 'loading'
  )
    setBg(rt, `${tp(c)}:rxmt:${c.pid}:${iface.id}:${n.rid}`, RXMT);
}

function rxmtTimer(rt: Rt, c: OspfCfg, iface: Iface, ifs: OspfIfState, n: OspfNbr): void {
  if (n.state === 'exstart') {
    sendDbd(rt, c, iface, ifs, n, true);
  } else if (n.state === 'exchange') {
    sendDbd(rt, c, iface, ifs, n, false);
  } else if (n.state === 'loading') {
    sendLsr(rt, c, iface, ifs, n);
    return;
  }
  const lsas: OspfLsa[] = [];
  for (const k of Object.keys(n.retrans)) {
    const type = Number(k.split('|')[0]);
    const a = areaOfType(type, ifs.area);
    const l = c.lsdb[a]?.[k];
    if (l) lsas.push({ ...l, age: lsaAge(c, a, k, rt.ctx.now) });
    else delete n.retrans[k];
  }
  if (lsas.length) sendLsu(rt, c, iface, n, lsas);
  maybeRxmt(rt, c, iface, n);
}

// ------------------------------------------------------------------ Origination

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const contains = (c: OspfCfg, ip: string, prefix: string, plen: number): boolean =>
  c.v6 ? ipv6Network(ip, plen) === prefix : inNet(ip, prefix, plen);

/** Eigene LSA erzeugen/aktualisieren; liefert `true`, wenn sich der Inhalt änderte. */
function originate(
  rt: Rt,
  c: OspfCfg,
  area: string,
  type: OspfLsa['type'],
  id: string,
  body: OspfLsaBody,
): boolean {
  const rid = effectiveRid(rt, c);
  const key = lsaKey({ type, id, advRouter: rid });
  const a = areaOfType(type, area);
  const cur = c.lsdb[a]?.[key];
  if (cur && cur.age < MAXAGE && same(cur.body, body)) return false;
  const seq = (c.seqs[key] ?? INIT_SEQ - 1) + 1;
  c.seqs[key] = seq;
  const lsa: OspfLsa = { type, id, advRouter: rid, seq, age: 0, body };
  install(rt, c, a, lsa);
  dbg(
    rt,
    'OSPF',
    'ospf.lsa',
    () => `OSPF-${c.pid} LSA   originating type ${type} id ${id} seq ${seq.toString(16)}`,
  );
  floodLsas(rt, c, area, [lsa]);
  return true;
}

function reoriginate(rt: Rt, c: OspfCfg, area: string, key: string): void {
  const cur = c.lsdb[area]?.[key];
  if (!cur) return;
  const seq = (c.seqs[key] ?? cur.seq) + 1;
  c.seqs[key] = seq;
  const lsa: OspfLsa = { ...cur, seq, age: 0 };
  install(rt, c, area, lsa);
  floodLsas(rt, c, area === 'as' ? '0' : area, [lsa]);
}

/** Eigene LSA mit MaxAge fluten und entfernen. */
function flushLsa(rt: Rt, c: OspfCfg, area: string, l: OspfLsa): void {
  const key = lsaKey(l);
  const seq = Math.max(c.seqs[key] ?? 0, l.seq) + 1;
  c.seqs[key] = seq;
  const dead: OspfLsa = { ...l, seq, age: MAXAGE };
  delete c.lsdb[area]?.[key];
  delete c.installed[`${area}|${key}`];
  markDirty(rt, c);
  floodLsas(rt, c, area === 'as' ? '0' : area, [dead]);
}

function routerLinks(rt: Rt, c: OspfCfg, area: string, parts: Part[]): OspfRouterLink[] {
  const links: OspfRouterLink[] = [];
  for (const { iface, area: a } of parts) {
    if (a !== area) continue;
    const ifs = c.ifs[iface.id];
    if (!ifs) continue;
    const cost = ifCost(rt, iface, c);
    const stubs = (): void => {
      for (const p of prefixesOf(c, iface))
        links.push({ kind: 'stub', prefix: p.prefix, plen: p.plen, cost });
    };
    if (ifs.state === 'loopback') {
      stubs();
      continue;
    }
    if (ifs.state === 'p2p') {
      for (const n of Object.values(ifs.neighbors)) {
        if (n.state === 'full') links.push({ kind: 'p2p', neighbor: n.rid, addr: iface.ip, cost });
      }
      stubs();
      continue;
    }
    const drNbr = ifs.dr === effectiveRid(rt, c) ? undefined : ifs.neighbors[ifs.dr];
    const adjDr =
      ifs.state === 'dr'
        ? Object.values(ifs.neighbors).some((n) => n.state === 'full')
        : drNbr?.state === 'full';
    if (
      (ifs.state === 'dr' || ifs.state === 'bdr' || ifs.state === 'drother') &&
      adjDr &&
      ifs.drAddr !== NO_ID
    ) {
      links.push({ kind: 'transit', neighbor: ifs.drAddr, addr: iface.ip, cost });
    } else {
      stubs();
    }
  }
  return links;
}

export function networkOf(ip: string, plen: number): string {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  const net = (ipNum(ip) & m) >>> 0;
  return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.');
}

/** Router-/Network-LSAs aller Bereiche an den aktuellen Zustand anpassen. */
export function originateAll(rt: Rt, c: OspfCfg): void {
  const parts = participants(rt, c);
  const areas = areasOf(parts);
  const rid = effectiveRid(rt, c);
  const isAbr = areas.length > 1;
  const isAsbr =
    c.redistribute.length > 0 || !!c.defaultOriginate || translatorAreas(rt, c).length > 0;
  for (const area of areas) {
    const links = routerLinks(rt, c, area, parts);
    originate(rt, c, area, 1, rid, { type: 1, abr: isAbr, asbr: isAsbr, links });
    // Network-LSAs für Segmente, in denen wir DR sind
    for (const { iface, area: a } of parts) {
      if (a !== area) continue;
      const ifs = c.ifs[iface.id];
      if (!ifs) continue;
      const key = lsaKey({ type: 2, id: iface.ip, advRouter: rid });
      const full = Object.values(ifs.neighbors).filter((n) => n.state === 'full');
      if (ifs.state === 'dr' && full.length > 0) {
        const pf = prefixesOf(c, iface)[0];
        originate(rt, c, area, 2, iface.ip, {
          type: 2,
          prefix: pf?.prefix ?? '::',
          plen: pf?.plen ?? 0,
          attached: [rid, ...full.map((n) => n.rid)],
        });
      } else if (c.lsdb[area]?.[key]) {
        const l = c.lsdb[area]?.[key];
        if (l) flushLsa(rt, c, area, l);
      }
    }
  }
  // LSAs aus Bereichen entfernen, in denen wir nichts mehr haben
  for (const area of Object.keys(c.lsdb)) {
    if (area === 'as' || areas.includes(area)) continue;
    for (const l of Object.values(c.lsdb[area] ?? {})) {
      if (l.advRouter === rid) flushLsa(rt, c, area, l);
    }
  }
}

// ------------------------------------------------------------------ Recompute (SPF, Summaries, Externals)

export function ospfRecompute(rt: Rt): boolean {
  let changed = false;
  for (const c of procsOf(rt)) {
    if (syncExternals(rt, c)) markDirty(rt, c);
    if (!c.dirty) continue;
    c.dirty = false;
    const res = spfRun(rt, c);
    c.spfRuns++;
    c.lastSpf = rt.ctx.now;
    dbg(
      rt,
      'OSPF',
      'ospf.spf',
      () => `OSPF-${c.pid} SPF   Running SPF, ${res.routes.length} route(s)`,
    );
    rlog(rt, 'OSPF', { key: 'ospf.spf', params: { pid: c.pid, routes: res.routes.length } });
    const max = maxPathsOf(c);
    const out = res.routes
      .filter((r) => distPermits(rt, c.distributeLists, 'in', undefined, { ...r, v6: c.v6 }))
      .flatMap((r) =>
        r.nhs
          .filter((n) => n.addr !== undefined)
          .slice(0, max)
          .map((nh) => ({
            proto: 'O' as const,
            sub:
              r.type === 'intra'
                ? undefined
                : r.type === 'inter'
                  ? 'IA'
                  : r.type === 'e1'
                    ? r.nssa
                      ? 'N1'
                      : 'E1'
                    : r.nssa
                      ? 'N2'
                      : 'E2',
            prefix: r.prefix,
            plen: r.plen,
            ad: 110,
            metric: r.cost,
            nextHop: nh.addr,
            ifaceId: nh.ifaceId,
          })),
      )
      .filter((r) => r.ifaceId !== '');
    if (installRoutes(rt, srcOf(c), out, c.v6)) changed = true;
    if (originateSummaries(rt, c, res)) {
      // neue Summary-LSAs ändern unsere eigene Sicht nicht
    }
    if (res.vlChanged) originateAll(rt, c);
    if (c.vlinks?.length) {
      const sig = JSON.stringify(
        c.vlinks.map((v) => [v.rid, vlEndpoints(rt, c, v)?.remote ?? null]),
      );
      if (sig !== vlSigs.get(c)) {
        vlSigs.set(c, sig);
        syncProcess(rt, c);
      }
    }
  }
  return changed;
}

function externalKey(prefix: string, plen: number): string {
  return `${prefix}/${plen}`;
}

/** NSSA-Bereiche, für die dieser ABR die Typ-7→Typ-5-Übersetzung übernimmt (höchste Router-ID aller ABRs). */
export function translatorAreas(rt: Rt, c: OspfCfg): string[] {
  const parts = participants(rt, c);
  const areas = areasOf(parts);
  if (areas.length < 2) return [];
  const me = effectiveRid(rt, c);
  const out: string[] = [];
  for (const a of areas) {
    if (areaTypeOf(c, a) !== 'nssa') continue;
    let best = me;
    for (const l of Object.values(c.lsdb[a] ?? {})) {
      if (l.body.type === 1 && l.body.abr && l.age < MAXAGE && cmpId(l.advRouter, best) > 0)
        best = l.advRouter;
    }
    if (best === me) out.push(a);
  }
  return out;
}

/** Redistribution → externe Routen, Typ-5-/Typ-7-LSAs und NSSA-Übersetzung. Liefert `true`, wenn sich etwas änderte. */
function syncExternals(rt: Rt, c: OspfCfg): boolean {
  const own = new Map<string, OspfExternal>();
  for (const red of c.redistribute) {
    for (const s of c.v6 ? redistSource6(rt, red, srcOf(c)) : redistSource(rt, red, srcOf(c))) {
      if (s.plen === 0) continue;
      if (!c.v6 && !red.subnets && s.plen > classfulPlenOf(s.prefix)) continue;
      own.set(externalKey(s.prefix, s.plen), {
        prefix: s.prefix,
        plen: s.plen,
        metric: s.set?.metric ?? red.metric ?? 20,
        eType: s.set?.metricType ?? red.metricType ?? 2,
        tag: s.set?.tag ?? red.tag ?? 0,
      });
    }
  }
  if (c.defaultOriginate) {
    const hasDefault =
      c.defaultOriginate.always ||
      (c.v6
        ? rt.cfg.staticRoutes6.some((r) => r.plen === 0)
        : rt.cfg.staticRoutes.some((r) => r.prefix === '0.0.0.0' && r.mask === '0.0.0.0') ||
          rt.cfg.dynRoutes.some((r) => r.plen === 0 && r.src !== srcOf(c)));
    if (hasDefault)
      own.set(c.v6 ? '::/0' : '0.0.0.0/0', {
        prefix: c.v6 ? '::' : '0.0.0.0',
        plen: 0,
        metric: c.defaultOriginate.metric,
        eType: c.defaultOriginate.metricType,
        tag: 0,
      });
  }
  const rid = effectiveRid(rt, c);
  const parts = participants(rt, c);
  const areas = areasOf(parts);
  const nssa = areas.filter((a) => areaTypeOf(c, a) === 'nssa');
  const hasNormal = areas.length === 0 || areas.some((a) => areaTypeOf(c, a) === 'normal');
  // Typ 7 → Typ 5 (ABR mit der höchsten Router-ID im NSSA-Bereich)
  const want = new Map<string, OspfExternal>(hasNormal ? own : []);
  for (const a of translatorAreas(rt, c)) {
    for (const l of Object.values(c.lsdb[a] ?? {})) {
      if (l.body.type !== 7 || !l.body.p || l.advRouter === rid || l.age >= MAXAGE) continue;
      const k = externalKey(l.body.prefix, l.body.plen);
      if (!want.has(k))
        want.set(k, {
          prefix: l.body.prefix,
          plen: l.body.plen,
          metric: l.body.metric,
          eType: l.body.eType,
          tag: l.body.tag,
        });
    }
  }
  let changed = false;
  for (const [k, e] of want) {
    if (!same(c.externals[k], e)) {
      c.externals[k] = e;
      changed = true;
    }
    originate(rt, c, '0', 5, e.prefix, {
      type: 5,
      prefix: e.prefix,
      plen: e.plen,
      metric: e.metric,
      eType: e.eType,
      tag: e.tag,
    });
  }
  for (const k of Object.keys(c.externals)) {
    if (want.has(k)) continue;
    const e = c.externals[k] as OspfExternal;
    delete c.externals[k];
    changed = true;
    const l = c.lsdb['as']?.[lsaKey({ type: 5, id: e.prefix, advRouter: rid })];
    if (l) flushLsa(rt, c, 'as', l);
  }
  // Typ 7 für eigene Redistribution in NSSA-Bereichen
  const dflt = (a: string): boolean => !!areaCfg(c, a).nssaDefaultOriginate && areas.length > 1;
  for (const a of nssa) {
    const want7 = new Map(own);
    if (dflt(a))
      want7.set('0.0.0.0/0', { prefix: '0.0.0.0', plen: 0, metric: 1, eType: 2, tag: 0 });
    for (const [k, e] of want7) {
      if (
        originate(rt, c, a, 7, e.prefix, {
          type: 7,
          prefix: e.prefix,
          plen: e.plen,
          metric: e.metric,
          eType: e.eType,
          tag: e.tag,
          p: true,
        })
      )
        changed = true;
      void k;
    }
    for (const l of Object.values(c.lsdb[a] ?? {})) {
      if (l.advRouter !== rid || l.body.type !== 7) continue;
      if (!want7.has(externalKey(l.body.prefix, l.body.plen))) {
        flushLsa(rt, c, a, l);
        changed = true;
      }
    }
  }
  // Typ-7-LSAs in Bereichen, die nicht (mehr) NSSA sind
  for (const a of Object.keys(c.lsdb)) {
    if (a === 'as' || nssa.includes(a)) continue;
    for (const l of Object.values(c.lsdb[a] ?? {})) {
      if (l.advRouter === rid && l.type === 7) {
        flushLsa(rt, c, a, l);
        changed = true;
      }
    }
  }
  if (changed) originateAll(rt, c);
  return changed;
}

const classfulPlenOf = (ip: string): number => {
  const f = ipNum(ip) >>> 24;
  return f < 128 ? 8 : f < 192 ? 16 : 24;
};

function originateSummaries(rt: Rt, c: OspfCfg, res: ReturnType<typeof spfRun>): boolean {
  const parts = participants(rt, c);
  const areas = areasOf(parts);
  if (areas.length < 2) return false;
  const rid = effectiveRid(rt, c);
  let changed = false;
  for (const target of areas) {
    const want3 = new Map<string, { prefix: string; plen: number; metric: number }>();
    const want4 = new Map<string, number>();
    for (const r of res.candidates) {
      if (r.area === target) continue; // aus dem Zielbereich gelernt
      // Inter-Area-Routen gelangen nur über den Backbone in andere Bereiche
      if (r.type === 'inter' && r.area !== '0') continue;
      if (target === '0' && r.type === 'inter') continue;
      if (r.type !== 'intra' && r.type !== 'inter') continue;
      let { prefix, plen } = r;
      let metric = r.cost;
      const range = c.ranges.find(
        (g) => g.area === r.area && plen >= g.plen && contains(c, prefix, g.prefix, g.plen),
      );
      if (range) {
        if (range.notAdvertise) continue;
        prefix = range.prefix;
        plen = range.plen;
      }
      const k = `${prefix}/${plen}`;
      const cur = want3.get(k);
      metric = range ? Math.max(cur?.metric ?? 0, metric) : metric;
      if (!cur || (range ? true : metric < cur.metric)) want3.set(k, { prefix, plen, metric });
    }
    const tcfg = areaCfg(c, target);
    // Stub/NSSA: keine ASBR-Summaries; Totally Stubby/NSSA no-summary: nur Default
    if (tcfg.type !== 'normal') want4.clear();
    if (tcfg.type !== 'normal' && tcfg.noSummary) want3.clear();
    if (tcfg.type === 'stub' || (tcfg.type === 'nssa' && tcfg.noSummary))
      want3.set('0.0.0.0/0', { prefix: '0.0.0.0', plen: 0, metric: tcfg.defaultCost ?? 1 });
    for (const a of res.asbrs) {
      if (tcfg.type !== 'normal') break;
      if (a.area === target) continue;
      if (a.viaInter && a.area !== '0') continue;
      if (target === '0' && a.viaInter) continue;
      const cur = want4.get(a.rid);
      if (cur === undefined || a.cost < cur) want4.set(a.rid, a.cost);
    }
    // vorhandene eigene Summary-LSAs abgleichen
    const have = lsdbOf(c, target);
    for (const [k, v] of want3) {
      if (
        originate(rt, c, target, 3, v.prefix, {
          type: 3,
          prefix: v.prefix,
          plen: v.plen,
          metric: v.metric,
        })
      )
        changed = true;
      void k;
    }
    for (const [asbr, cost] of want4) {
      if (originate(rt, c, target, 4, asbr, { type: 4, asbr, metric: cost })) changed = true;
    }
    for (const l of Object.values(have)) {
      if (l.advRouter !== rid) continue;
      if (l.type === 3 && l.body.type === 3 && !want3.has(`${l.body.prefix}/${l.body.plen}`)) {
        flushLsa(rt, c, target, l);
        changed = true;
      }
      if (l.type === 4 && l.body.type === 4 && !want4.has(l.body.asbr)) {
        flushLsa(rt, c, target, l);
        changed = true;
      }
    }
  }
  return changed;
}

// ------------------------------------------------------------------ Timer

export function ospfTimer(rt: Rt, name: string): boolean {
  const v6 = name.startsWith('rt:ospf6:');
  if (!v6 && !name.startsWith('rt:ospf:')) return false;
  const [, , kind, pidS, ifaceId, rid] = name.split(':');
  const c = (v6 ? rt.r.ospf6 : rt.r.ospf)[Number(pidS)];
  if (!c) return true;
  if (kind === 'hello') {
    const iface = ifaceOf(rt, c, ifaceId as string);
    const ifs = c.ifs[ifaceId as string];
    if (iface && ifs) sendHello(rt, c, iface, ifs);
    return true;
  }
  if (kind === 'wait') {
    const iface = ifaceOf(rt, c, ifaceId as string);
    const ifs = c.ifs[ifaceId as string];
    if (iface && ifs && ifs.state === 'waiting') elect(rt, c, iface, ifs);
    return true;
  }
  if (kind === 'dead') {
    const ifs = c.ifs[ifaceId as string];
    const n = ifs?.neighbors[rid as string];
    if (ifs && n) killNbr(rt, c, ifaceId as string, ifs, n, 'Dead timer expired');
    return true;
  }
  if (kind === 'rxmt') {
    const iface = ifaceOf(rt, c, ifaceId as string);
    const ifs = c.ifs[ifaceId as string];
    const n = ifs?.neighbors[rid as string];
    if (iface && ifs && n) rxmtTimer(rt, c, iface, ifs, n);
    return true;
  }
  if (kind === 'refresh') {
    const me = effectiveRid(rt, c);
    for (const [area, db] of Object.entries(c.lsdb)) {
      for (const [k, l] of Object.entries(db)) if (l.advRouter === me) reoriginate(rt, c, area, k);
    }
    return true;
  }
  if (kind === 'age') {
    for (const [area, db] of Object.entries(c.lsdb)) {
      for (const [k, l] of Object.entries(db)) {
        if (lsaAge(c, area, k, rt.ctx.now) >= MAXAGE && l.advRouter !== effectiveRid(rt, c)) {
          delete db[k];
          delete c.installed[`${area}|${k}`];
          markDirty(rt, c);
        }
      }
    }
    return true;
  }
  return true;
}

export type { OspfRouterLink };
