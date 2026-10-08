import type { HsrpPdu, HsrpState, Ipv4Pdu, Ipv6Pdu } from '@netsim/protocols';
import { multicastMacV6, parseIpv4 } from '@netsim/protocols';
import { ARP_BROADCAST } from './consts';
import { SEC, cancelBg, dbg, rlog, sendMcast, setBg, type Rt } from './core';
import type { Iface } from '../ifaces';
import { eth } from '../l3';
import { eth6, newIp6, sendUnsolicitedNa, type Iface6 } from '../l3v6';
import type { IfaceCfg } from '../types';
import type { HsrpCfg } from './types';

export const HSRP_GROUP = '224.0.0.2';
export const HSRP2_GROUP = '224.0.0.102';
export const HSRP6_GROUP = 'ff02::66';

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

/** Virtuelle MAC: v1 `0000.0c07.acXX`, v2 `0000.0c9f.fXXX` (12-Bit-Gruppe). */
export const vmacOf = (group: number, version: 1 | 2 = 1): string =>
  version === 2
    ? `00:00:0c:9f:${hex2(0xf0 | ((group >> 8) & 0x0f))}:${hex2(group & 0xff)}`
    : `00:00:0c:07:ac:${hex2(group & 0xff)}`;

/** Virtuelle MAC für HSRP-IPv6-Gruppen: `0005.73a0.0XXX`. */
export const vmac6Of = (group: number): string =>
  `00:05:73:a0:${hex2((group >> 8) & 0x0f)}:${hex2(group & 0xff)}`;

/** Aus der virtuellen MAC abgeleitete virtuelle Link-Local-Adresse (`standby G ipv6 autoconfig`). */
export const virtualLl6 = (group: number): string => `fe80::5:73ff:fea0:${group.toString(16)}`;

export const hsrpVersion = (cfg: Pick<IfaceCfg, 'hsrpVersion'>): 1 | 2 => cfg.hsrpVersion ?? 1;
export const hsrpAuthKey = (g: HsrpCfg): string => g.authKey ?? 'cisco';
export const vipOf = (g: HsrpCfg): string | undefined =>
  g.v6 && g.autoconfig ? virtualLl6(g.group) : g.vip;
export const groupMac = (cfg: IfaceCfg, g: HsrpCfg): string =>
  g.v6 ? vmac6Of(g.group) : vmacOf(g.group, hsrpVersion(cfg));
export const mcastOf = (cfg: IfaceCfg, g: HsrpCfg): string =>
  g.v6 ? HSRP6_GROUP : hsrpVersion(cfg) === 2 ? HSRP2_GROUP : HSRP_GROUP;

export const newHsrp = (group: number): HsrpCfg => ({
  group,
  priority: 100,
  preempt: false,
  helloSec: 3,
  holdSec: 10,
  track: [],
  state: 'init',
  activePriority: 0,
  standbyPriority: 0,
  lastActiveHello: 0,
  lastStandbyHello: 0,
  stateSince: 0,
});

const ipNum = (ip: string): number => parseIpv4(ip) ?? 0;
/** Vergleich Priorität, dann höhere IP-Adresse (IPv6: lexikographisch über die Adresse). */
const addrRank = (a: string, b: string): number =>
  a.includes(':') || b.includes(':') ? a.localeCompare(b) : ipNum(a) - ipNum(b);
const better = (p1: number, ip1: string, p2: number, ip2: string): boolean =>
  p1 > p2 || (p1 === p2 && addrRank(ip1, ip2) > 0);

/** Effektive Priorität = konfigurierte Priorität minus Dekremente ausgefallener Tracking-Schnittstellen. */
export function effPriority(rt: Rt, g: HsrpCfg): number {
  let p = g.priority;
  for (const t of g.track) if (!rt.node.ifaces.some((i) => i.id === t.ifaceId)) p -= t.decrement;
  return Math.max(0, p);
}

/** Eine HSRP-Gruppe an einer Schnittstelle (IPv4- oder IPv6-Familie). */
interface Slot {
  id: string;
  cfg: IfaceCfg;
  g: HsrpCfg;
  /** Eigene Adresse auf dem Segment (IPv4-Adresse bzw. Link-Local). */
  ip: string;
  iface?: Iface;
  iface6?: Iface6;
}

const gid = (g: HsrpCfg): string => `${g.group}${g.v6 ? 'v6' : ''}`;
const nm = (id: string, g: HsrpCfg): string => `${id}:${gid(g)}`;

function slots(rt: Rt): Slot[] {
  const out: Slot[] = [];
  for (const iface of rt.node.ifaces) {
    if (iface.kind === 'loop' || iface.kind === 'tunnel') continue;
    for (const g of Object.values(iface.cfg.hsrp ?? {}))
      if (g.vip) out.push({ id: iface.id, cfg: iface.cfg, g, ip: iface.ip, iface });
  }
  for (const i6 of rt.node.v6?.ifaces ?? []) {
    if (i6.kind === 'loop' || i6.kind === 'tunnel') continue;
    for (const g of Object.values(i6.cfg.hsrp6 ?? {})) {
      g.v6 = true;
      if (vipOf(g)) out.push({ id: i6.id, cfg: i6.cfg, g, ip: i6.ll, iface6: i6 });
    }
  }
  return out;
}

/** Aktive virtuelle Adressen + alle konfigurierten virtuellen MACs (Standby-Router verwerfen still). */
export function hsrpVips(ifaces: Iface[]): {
  vips: { ip: string; mac: string; ifaceId: string }[];
  silent: { mac: string; ifaceId: string }[];
} {
  const vips: { ip: string; mac: string; ifaceId: string }[] = [];
  const silent: { mac: string; ifaceId: string }[] = [];
  for (const i of ifaces) {
    for (const g of Object.values(i.cfg.hsrp ?? {})) {
      if (!g.vip) continue;
      const mac = vmacOf(g.group, hsrpVersion(i.cfg));
      silent.push({ mac, ifaceId: i.id });
      if (g.state === 'active') vips.push({ ip: g.vip, mac, ifaceId: i.id });
    }
  }
  return { vips, silent };
}

/** IPv6: aktive virtuelle Adressen (ND beantworten, lokal zustellen) und stille virtuelle MACs. */
export function hsrpVips6(ifaces: Iface6[]): {
  vips: { ip: string; mac: string; ifaceId: string }[];
  silent: { mac: string; ifaceId: string }[];
} {
  const vips: { ip: string; mac: string; ifaceId: string }[] = [];
  const silent: { mac: string; ifaceId: string }[] = [];
  for (const i of ifaces) {
    for (const g of Object.values(i.cfg.hsrp6 ?? {})) {
      g.v6 = true;
      const ip = vipOf(g);
      if (!ip) continue;
      silent.push({ mac: vmac6Of(g.group), ifaceId: i.id });
      if (g.state === 'active') vips.push({ ip, mac: vmac6Of(g.group), ifaceId: i.id });
    }
  }
  return { vips, silent };
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const ifName = (rt: Rt, id: string): string => rt.ctx.deviceIfaceName(id);

function setState(rt: Rt, sl: Slot, to: HsrpState): void {
  const { g } = sl;
  if (g.state === to) return;
  const from = g.state;
  g.state = to;
  g.stateSince = rt.ctx.now;
  rlog(
    rt,
    'HSRP',
    {
      key: 'hsrp.state',
      params: { iface: ifName(rt, sl.id), group: g.group, from, to },
    },
    {
      status: to === 'active' ? 'ok' : 'info',
      debug: {
        tag: 'hsrp',
        text: () =>
          `HSRP: ${ifName(rt, sl.id)} Grp ${g.group}${g.v6 ? ' (IPv6)' : ''} state ${cap(from)} -> ${cap(to)}`,
      },
    },
  );
  const id = nm(sl.id, g);
  if (to === 'speak' || to === 'standby' || to === 'active') {
    setBg(rt, `rt:hsrp:hello:${id}`, 50_000, g.helloSec * SEC);
  } else cancelBg(rt, `rt:hsrp:hello:${id}`);
  if (to === 'active') {
    const mac = groupMac(sl.cfg, g);
    if (sl.iface) {
      // Gratuitous ARP mit der virtuellen MAC als Quelle → Switches lernen den neuen Port
      const arp = {
        kind: 'arp' as const,
        op: 'request' as const,
        senderMac: mac,
        senderIp: g.vip as string,
        targetMac: '00:00:00:00:00:00',
        targetIp: g.vip as string,
      };
      rt.node.xmit(rt.ctx, sl.iface, eth(mac, ARP_BROADCAST, arp));
    } else if (sl.iface6 && rt.node.v6) {
      sendUnsolicitedNa(
        rt.ctx,
        { cfg: rt.node.cfg, v6: rt.node.v6, xmit: rt.node.xmit },
        sl.iface6,
        vipOf(g) as string,
        mac,
      );
    }
    sendHello(rt, sl);
  }
  if (to === 'speak') setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
  if (to === 'listen') setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
  rt.ctx.requestRefresh();
}

function sendHello(rt: Rt, sl: Slot, op: HsrpPdu['op'] = 'hello'): void {
  const { g } = sl;
  const pdu: HsrpPdu = {
    kind: 'hsrp',
    group: g.group,
    op,
    state: g.state,
    helloSec: g.helloSec,
    holdSec: g.holdSec,
    priority: effPriority(rt, g),
    vip: vipOf(g) as string,
    version: g.v6 ? 2 : hsrpVersion(sl.cfg),
    auth: hsrpAuthKey(g),
  };
  const srcMac = g.state === 'active' ? groupMac(sl.cfg, g) : undefined;
  if (sl.iface) {
    sendMcast(
      rt,
      sl.iface,
      mcastOf(sl.cfg, g),
      { kind: 'udp', srcPort: 1985, dstPort: 1985, dataSize: 0, app: pdu },
      srcMac,
    );
  } else if (sl.iface6 && rt.node.v6) {
    const pkt = newIp6(
      rt.node.v6,
      sl.iface6.ll,
      HSRP6_GROUP,
      { kind: 'udp', srcPort: 2029, dstPort: 2029, dataSize: 0, app: pdu },
      255,
    );
    rt.node.xmit(
      rt.ctx,
      sl.iface6,
      eth6(srcMac ?? sl.iface6.mac, multicastMacV6(HSRP6_GROUP), pkt),
    );
  }
  dbg(
    rt,
    'HSRP',
    'hsrp',
    () =>
      `HSRP: ${ifName(rt, sl.id)} Grp ${g.group} Hello out ${sl.ip} ${cap(g.state)} pri ${pdu.priority} vIP ${pdu.vip}`,
  );
}

// ------------------------------------------------------------------ Sync

const timerKinds = ['hello', 'active', 'standby', 'state'];

export function hsrpSync(rt: Rt): void {
  const live = new Set<string>();
  for (const sl of slots(rt)) {
    live.add(nm(sl.id, sl.g));
    if (sl.g.state === 'init') {
      setState(rt, sl, 'listen');
    } else reeval(rt, sl);
  }
  // Gruppen auf ausgefallenen Schnittstellen zurücksetzen
  for (const [id, ic] of Object.entries(rt.cfg.ifaces)) {
    for (const g of [...Object.values(ic.hsrp ?? {}), ...Object.values(ic.hsrp6 ?? {})]) {
      if (ic.hsrp6 && Object.values(ic.hsrp6).includes(g)) g.v6 = true;
      if (live.has(nm(id, g))) continue;
      if (g.state !== 'init') {
        const was = g.state;
        g.state = 'init';
        g.activeIp = undefined;
        g.standbyIp = undefined;
        for (const k of timerKinds) cancelBg(rt, `rt:hsrp:${k}:${nm(id, g)}`);
        rlog(
          rt,
          'HSRP',
          {
            key: 'hsrp.state',
            params: { iface: ifName(rt, id), group: g.group, from: was, to: 'init' },
          },
          {
            debug: {
              tag: 'hsrp',
              text: () => `HSRP: ${ifName(rt, id)} Grp ${g.group} state ${cap(was)} -> Init`,
            },
          },
        );
      }
    }
  }
}

export function hsrpStop(rt: Rt): void {
  for (const [id, ic] of Object.entries(rt.cfg.ifaces)) {
    for (const g of [...Object.values(ic.hsrp ?? {}), ...Object.values(ic.hsrp6 ?? {})]) {
      if (ic.hsrp6 && Object.values(ic.hsrp6).includes(g)) g.v6 = true;
      for (const k of timerKinds) cancelBg(rt, `rt:hsrp:${k}:${nm(id, g)}`);
    }
  }
}

/** Preempt/Priorität neu bewerten (z. B. nach Tracking-Änderung). */
function reeval(rt: Rt, sl: Slot): void {
  const { g } = sl;
  if (g.state === 'active' || !g.preempt) return;
  if (
    g.activeIp &&
    g.state !== 'listen' &&
    better(effPriority(rt, g), sl.ip, g.activePriority, g.activeIp)
  ) {
    setState(rt, sl, 'active');
  }
}

// ------------------------------------------------------------------ Empfang

/** IPv4-Hello. */
export function hsrpRx(rt: Rt, iface: Iface, ip: Ipv4Pdu, pdu: HsrpPdu): void {
  const g = iface.cfg.hsrp?.[pdu.group];
  if (!g || !g.vip || g.state === 'init' || ip.src === iface.ip) return;
  if ((pdu.version ?? 1) !== hsrpVersion(iface.cfg)) return; // v1 und v2 sprechen nicht miteinander
  rxCore(rt, { id: iface.id, cfg: iface.cfg, g, ip: iface.ip, iface }, ip.src, pdu);
}

/** IPv6-Hello (Version 2). */
export function hsrpRx6(rt: Rt, iface: Iface6, pkt: Ipv6Pdu, pdu: HsrpPdu): void {
  const g = iface.cfg.hsrp6?.[pdu.group];
  if (!g || !vipOf(g) || g.state === 'init' || pkt.src === iface.ll) return;
  g.v6 = true;
  rxCore(rt, { id: iface.id, cfg: iface.cfg, g, ip: iface.ll, iface6: iface }, pkt.src, pdu);
}

function rxCore(rt: Rt, sl: Slot, src: string, pdu: HsrpPdu): void {
  const { g } = sl;
  if ((pdu.auth ?? 'cisco') !== hsrpAuthKey(g)) {
    rlog(
      rt,
      'HSRP',
      { key: 'hsrp.authFail', params: { src, group: pdu.group, iface: ifName(rt, sl.id) } },
      {
        kind: 'drop',
        status: 'drop',
        debug: {
          tag: 'hsrp',
          text: () =>
            `HSRP: ${ifName(rt, sl.id)} Grp ${pdu.group} Auth failed from ${src} (key mismatch)`,
        },
      },
    );
    return;
  }
  rlog(
    rt,
    'HSRP',
    {
      key: 'hsrp.rx',
      params: { src, group: pdu.group, state: pdu.state, prio: pdu.priority },
    },
    {
      kind: 'rx',
      status: 'ok',
      debug: {
        tag: 'hsrp',
        text: () =>
          `HSRP: ${ifName(rt, sl.id)} Grp ${pdu.group} Hello in ${src} ${cap(pdu.state)} pri ${pdu.priority} vIP ${pdu.vip}`,
      },
    },
  );
  const id = nm(sl.id, g);
  const mine = effPriority(rt, g);
  if (pdu.state === 'active') {
    if (g.state === 'active') {
      if (better(pdu.priority, src, mine, sl.ip)) {
        g.activeIp = src;
        g.activePriority = pdu.priority;
        g.lastActiveHello = rt.ctx.now;
        setState(rt, sl, 'speak');
        setBg(rt, `rt:hsrp:active:${id}`, g.holdSec * SEC);
      } else {
        // Wir gewinnen den Konflikt: sofort Hello senden
        sendHello(rt, sl);
      }
      return;
    }
    g.activeIp = src;
    g.activePriority = pdu.priority;
    g.lastActiveHello = rt.ctx.now;
    setBg(rt, `rt:hsrp:active:${id}`, Math.max(g.holdSec, pdu.holdSec) * SEC);
    if (g.preempt && better(mine, sl.ip, pdu.priority, src)) {
      setState(rt, sl, 'active');
      return;
    }
    if (g.state === 'listen') setState(rt, sl, 'speak');
    return;
  }
  if (pdu.state === 'standby') {
    g.standbyIp = src;
    g.standbyPriority = pdu.priority;
    g.lastStandbyHello = rt.ctx.now;
    setBg(rt, `rt:hsrp:standby:${id}`, Math.max(g.holdSec, pdu.holdSec) * SEC);
    if (g.state === 'standby' && better(pdu.priority, src, mine, sl.ip)) {
      setState(rt, sl, 'speak');
    } else if (g.state === 'listen') setState(rt, sl, 'speak');
    return;
  }
  // speak/listen anderer Router
  if (g.state === 'listen') setState(rt, sl, 'speak');
}

// ------------------------------------------------------------------ Timer

export function hsrpTimer(rt: Rt, name: string): boolean {
  if (!name.startsWith('rt:hsrp:')) return false;
  const [, , kind, ifaceId, groupS] = name.split(':');
  const v6 = (groupS ?? '').endsWith('v6');
  const sl = slots(rt).find(
    (x) => x.id === ifaceId && x.g.group === parseInt(groupS ?? '', 10) && !!x.g.v6 === v6,
  );
  if (!sl) return true;
  const { g } = sl;
  if (kind === 'hello') {
    if (g.state === 'speak' || g.state === 'standby' || g.state === 'active') sendHello(rt, sl);
    return true;
  }
  const id = nm(sl.id, g);
  if (kind === 'active') {
    g.activeIp = undefined;
    if (g.state === 'standby') setState(rt, sl, 'active');
    else if (g.state === 'listen') setState(rt, sl, 'speak');
    else if (g.state === 'speak') evaluateSpeak(rt, sl);
    return true;
  }
  if (kind === 'standby') {
    g.standbyIp = undefined;
    if (g.state === 'speak') evaluateSpeak(rt, sl);
    return true;
  }
  if (kind === 'state') {
    if (g.state === 'listen') setState(rt, sl, 'speak');
    else if (g.state === 'speak') evaluateSpeak(rt, sl);
    void id;
    return true;
  }
  return true;
}

/** Ende der Speak-Phase: Active/Standby besetzen. */
function evaluateSpeak(rt: Rt, sl: Slot): void {
  const { g } = sl;
  const id = nm(sl.id, g);
  const mine = effPriority(rt, g);
  if (!g.activeIp) {
    if (!g.standbyIp || better(mine, sl.ip, g.standbyPriority, g.standbyIp))
      setState(rt, sl, 'active');
    else setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
    return;
  }
  if (!g.standbyIp || better(mine, sl.ip, g.standbyPriority, g.standbyIp))
    setState(rt, sl, 'standby');
  else setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
}
