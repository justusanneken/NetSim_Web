import type {
  Ipv4Addr,
  Ipv4Pdu,
  OspfLsa,
  OspfLsaBody,
  OspfLsaHeader,
  OspfMsg,
  OspfRouterLink,
} from '@netsim/protocols';
import { parseIpv4 } from '@netsim/protocols';
import type { Iface } from '../ifaces';
import type { Base } from '../l3';
import {
  SEC,
  cancelBg,
  dbg,
  ifaceBwKbps,
  inNet,
  installRoutes,
  plenOfMask,
  redistSource,
  rlog,
  sendMcast,
  sendNbr,
  setBg,
  wildcardMatch,
  type Rt,
} from './core';
import { requestRecompute } from './index';
import { spfRun } from './ospfspf';
import {
  isPassive,
  type OspfCfg,
  type OspfExternal,
  type OspfIfState,
  type OspfNbr,
  type OspfNbrState,
} from './types';

export const OSPF_ALL = '224.0.0.5';
export const OSPF_DR = '224.0.0.6';
export const MAXAGE = 3600;
export const INIT_SEQ = 0x80000001;
const LS_REFRESH = 1800;
const RXMT = 5 * SEC;
const NO_ID = '0.0.0.0';

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

export function ifCfg(iface: Iface, c: OspfCfg): NonNullable<Iface['cfg']['ospf']> | undefined {
  return iface.cfg.ospf?.pid === c.pid ? iface.cfg.ospf : undefined;
}
export const ifNetwork = (iface: Iface, c: OspfCfg): 'broadcast' | 'point-to-point' =>
  ifCfg(iface, c)?.network ?? (iface.kind === 'tunnel' ? 'point-to-point' : 'broadcast');
export const ifHello = (iface: Iface, c: OspfCfg): number => ifCfg(iface, c)?.helloSec ?? 10;
export const ifDead = (iface: Iface, c: OspfCfg): number =>
  ifCfg(iface, c)?.deadSec ?? ifHello(iface, c) * 4;
export const ifPriority = (iface: Iface, c: OspfCfg): number => ifCfg(iface, c)?.priority ?? 1;

export function ifCost(rt: Rt, iface: Iface, c: OspfCfg): number {
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
  const out: Part[] = [];
  for (const iface of rt.node.ifaces) {
    const ic = iface.cfg.ospf;
    if (ic && ic.pid !== c.pid) continue;
    let area = ic?.area;
    if (area === undefined)
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

function send(rt: Rt, c: OspfCfg, iface: Iface, dst: Ipv4Addr, msg: OspfMsg): void {
  const payload = {
    kind: 'routing' as const,
    proto: 'ospf' as const,
    v: (c.v6 ? 3 : 2) as 2 | 3,
    msg,
  };
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
    plen: plenOfMask(iface.mask),
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
  const procs = Object.values(rt.r.ospf);
  // verwaiste Routen entfernen (Prozess gelöscht)
  const known = new Set(procs.map((c) => `ospf:${c.pid}`));
  const orphan = rt.cfg.dynRoutes.filter((r) => r.src.startsWith('ospf:') && !known.has(r.src));
  if (orphan.length) rt.cfg.dynRoutes = rt.cfg.dynRoutes.filter((r) => !orphan.includes(r));
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
    setBg(rt, `rt:ospf:refresh:${c.pid}`, LS_REFRESH * SEC, LS_REFRESH * SEC);
    setBg(rt, `rt:ospf:age:${c.pid}`, 60 * SEC, 60 * SEC);
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
          setBg(rt, `rt:ospf:wait:${c.pid}:${iface.id}`, ifDead(iface, c) * SEC);
        }
        setBg(
          rt,
          `rt:ospf:hello:${c.pid}:${iface.id}`,
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
        setBg(rt, `rt:ospf:hello:${c.pid}:${iface.id}`, SEC, hs * SEC);
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
  cancelBg(rt, `rt:ospf:hello:${c.pid}:${id}`);
  cancelBg(rt, `rt:ospf:wait:${c.pid}:${id}`);
  for (const n of Object.values(ifs.neighbors)) killNbr(rt, c, id, ifs, n, 'Interface down', true);
  markDirty(rt, c);
}

export function ospfStop(rt: Rt): void {
  for (const c of Object.values(rt.r.ospf)) {
    for (const [id, ifs] of Object.entries(c.ifs)) ifDown(rt, c, id, ifs);
    cancelBg(rt, `rt:ospf:refresh:${c.pid}`);
    cancelBg(rt, `rt:ospf:age:${c.pid}`);
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
  cancelBg(rt, `rt:ospf:dead:${c.pid}:${ifaceId}:${n.rid}`);
  cancelBg(rt, `rt:ospf:rxmt:${c.pid}:${ifaceId}:${n.rid}`);
  const iface = rt.node.ifaces.find((i) => i.id === ifaceId);
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
  setBg(rt, `rt:ospf:rxmt:${c.pid}:${iface.id}:${n.rid}`, RXMT);
}

function lsdbHeaders(rt: Rt, c: OspfCfg, area: string): OspfLsaHeader[] {
  const out: OspfLsaHeader[] = [];
  for (const a of [area, 'as']) {
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
  });
}

// ------------------------------------------------------------------ Empfang

export function ospfRx(rt: Rt, iface: Iface, _base: Base, ip: Ipv4Pdu, msg: OspfMsg): void {
  void _base;
  for (const c of Object.values(rt.r.ospf)) {
    const ifs = c.ifs[iface.id];
    if (!ifs || ifs.state === 'loopback') continue;
    if (ip.src === iface.ip) return;
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
  ip: Ipv4Pdu,
  m: Extract<OspfMsg, { type: 'hello' }>,
): void {
  const myRid = effectiveRid(rt, c);
  if (m.routerId === myRid) return;
  const net = ifNetwork(iface, c);
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
  setBg(rt, `rt:ospf:dead:${c.pid}:${iface.id}:${n.rid}`, ifDead(iface, c) * SEC);
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
      cancelBg(rt, `rt:ospf:wait:${c.pid}:${iface.id}`);
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
  ip: Ipv4Pdu,
  m: Extract<OspfMsg, { type: 'dbd' }>,
): void {
  const n = ifs.neighbors[m.routerId];
  if (!n || stateRank[n.state] < 2) return;
  n.ip = ip.src;
  if (n.state === '2way') {
    if (!needAdj(ifs, n)) return;
    startAdj(rt, c, iface, ifs, n);
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
    cancelBg(rt, `rt:ospf:rxmt:${c.pid}:${iface.id}:${n.rid}`);
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
  setBg(rt, `rt:ospf:rxmt:${c.pid}:${iface.id}:${n.rid}`, RXMT);
}

function rxLsr(
  rt: Rt,
  c: OspfCfg,
  iface: Iface,
  ifs: OspfIfState,
  ip: Ipv4Pdu,
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
  ip: Ipv4Pdu,
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
    cancelBg(rt, `rt:ospf:rxmt:${c.pid}:${iface.id}:${n.rid}`);
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
  const external = lsas.every((l) => l.type === 5);
  for (const [id, ifs] of Object.entries(c.ifs)) {
    if (!external && ifs.area !== area) continue;
    const iface = rt.node.ifaces.find((i) => i.id === id);
    if (!iface) continue;
    for (const n of Object.values(ifs.neighbors)) {
      if (stateRank[n.state] < 4 || n.rid === exceptRid) continue;
      const out = lsas.map((l) => {
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

function maybeRxmt(rt: Rt, c: OspfCfg, iface: Iface, n: OspfNbr): void {
  if (
    Object.keys(n.retrans).length > 0 ||
    n.state === 'exstart' ||
    n.state === 'exchange' ||
    n.state === 'loading'
  )
    setBg(rt, `rt:ospf:rxmt:${c.pid}:${iface.id}:${n.rid}`, RXMT);
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
    const plen = plenOfMask(iface.mask);
    const net = networkOf(iface.ip, plen);
    if (ifs.state === 'loopback') {
      links.push({
        kind: 'stub',
        prefix: iface.kind === 'loop' ? iface.ip : net,
        plen: iface.kind === 'loop' ? 32 : plen,
        cost,
      });
      continue;
    }
    if (ifs.state === 'p2p') {
      for (const n of Object.values(ifs.neighbors)) {
        if (n.state === 'full') links.push({ kind: 'p2p', neighbor: n.rid, addr: iface.ip, cost });
      }
      links.push({ kind: 'stub', prefix: net, plen, cost });
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
      links.push({ kind: 'stub', prefix: net, plen, cost });
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
  const isAsbr = c.redistribute.length > 0 || !!c.defaultOriginate;
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
        const plen = plenOfMask(iface.mask);
        originate(rt, c, area, 2, iface.ip, {
          type: 2,
          prefix: networkOf(iface.ip, plen),
          plen,
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
  for (const c of Object.values(rt.r.ospf)) {
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
    const out = res.routes
      .map((r) => ({
        proto: 'O' as const,
        sub:
          r.type === 'intra'
            ? undefined
            : r.type === 'inter'
              ? 'IA'
              : r.type === 'e1'
                ? 'E1'
                : 'E2',
        prefix: r.prefix,
        plen: r.plen,
        ad: 110,
        metric: r.cost,
        nextHop: r.nh?.addr,
        ifaceId: r.nh?.ifaceId ?? '',
      }))
      .filter((r) => r.ifaceId !== '');
    if (installRoutes(rt, `ospf:${c.pid}`, out)) changed = true;
    if (originateSummaries(rt, c, res)) {
      // neue Summary-LSAs ändern unsere eigene Sicht nicht
    }
  }
  return changed;
}

function externalKey(prefix: string, plen: number): string {
  return `${prefix}/${plen}`;
}

/** Redistribution → externe Routen und Typ-5-LSAs. Liefert `true`, wenn LSAs entstanden/verschwanden. */
function syncExternals(rt: Rt, c: OspfCfg): boolean {
  const want = new Map<string, OspfExternal>();
  for (const red of c.redistribute) {
    for (const s of redistSource(rt, red, `ospf:${c.pid}`)) {
      if (s.plen === 0) continue;
      if (!red.subnets && s.plen > classfulPlenOf(s.prefix)) continue;
      want.set(externalKey(s.prefix, s.plen), {
        prefix: s.prefix,
        plen: s.plen,
        metric: red.metric ?? 20,
        eType: red.metricType ?? 2,
        tag: red.tag ?? 0,
      });
    }
  }
  if (c.defaultOriginate) {
    const hasDefault =
      c.defaultOriginate.always ||
      rt.cfg.staticRoutes.some((r) => r.prefix === '0.0.0.0' && r.mask === '0.0.0.0') ||
      rt.cfg.dynRoutes.some((r) => r.plen === 0 && r.src !== `ospf:${c.pid}`);
    if (hasDefault)
      want.set('0.0.0.0/0', {
        prefix: '0.0.0.0',
        plen: 0,
        metric: c.defaultOriginate.metric,
        eType: c.defaultOriginate.metricType,
        tag: 0,
      });
  }
  let changed = false;
  const rid = effectiveRid(rt, c);
  // neue/geänderte
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
  // entfernte
  for (const k of Object.keys(c.externals)) {
    if (want.has(k)) continue;
    const e = c.externals[k] as OspfExternal;
    delete c.externals[k];
    changed = true;
    const l = c.lsdb['as']?.[lsaKey({ type: 5, id: e.prefix, advRouter: rid })];
    if (l) flushLsa(rt, c, 'as', l);
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
        (g) => g.area === r.area && plen >= g.plen && inNet(prefix, g.prefix, g.plen),
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
    for (const a of res.asbrs) {
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
  if (!name.startsWith('rt:ospf:')) return false;
  const [, , kind, pidS, ifaceId, rid] = name.split(':');
  const c = rt.r.ospf[Number(pidS)];
  if (!c) return true;
  if (kind === 'hello') {
    const iface = rt.node.ifaces.find((i) => i.id === ifaceId);
    const ifs = c.ifs[ifaceId as string];
    if (iface && ifs) sendHello(rt, c, iface, ifs);
    return true;
  }
  if (kind === 'wait') {
    const iface = rt.node.ifaces.find((i) => i.id === ifaceId);
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
    const iface = rt.node.ifaces.find((i) => i.id === ifaceId);
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
