import type { HsrpPdu, HsrpState, Ipv4Pdu } from '@netsim/protocols';
import { ARP_BROADCAST } from './consts';
import { SEC, cancelBg, dbg, rlog, sendMcast, setBg, type Rt } from './core';
import type { Iface } from '../ifaces';
import { eth } from '../l3';
import type { HsrpCfg } from './types';
import { parseIpv4 } from '@netsim/protocols';

export const HSRP_GROUP = '224.0.0.2';

export const vmacOf = (group: number): string =>
  `00:00:0c:07:ac:${group.toString(16).padStart(2, '0')}`;

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
const better = (p1: number, ip1: string, p2: number, ip2: string): boolean =>
  p1 > p2 || (p1 === p2 && ipNum(ip1) > ipNum(ip2));

/** Effektive Priorität = konfigurierte Priorität minus Dekremente ausgefallener Tracking-Schnittstellen. */
export function effPriority(rt: Rt, g: HsrpCfg): number {
  let p = g.priority;
  for (const t of g.track) if (!rt.node.ifaces.some((i) => i.id === t.ifaceId)) p -= t.decrement;
  return Math.max(0, p);
}

interface Slot {
  iface: Iface;
  g: HsrpCfg;
}

function slots(rt: Rt): Slot[] {
  const out: Slot[] = [];
  for (const iface of rt.node.ifaces) {
    if (iface.kind === 'loop' || iface.kind === 'tunnel') continue;
    for (const g of Object.values(iface.cfg.hsrp ?? {})) if (g.vip) out.push({ iface, g });
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
      silent.push({ mac: vmacOf(g.group), ifaceId: i.id });
      if (g.state === 'active') vips.push({ ip: g.vip, mac: vmacOf(g.group), ifaceId: i.id });
    }
  }
  return { vips, silent };
}

const nm = (id: string, g: number): string => `${id}:${g}`;

function setState(rt: Rt, iface: Iface, g: HsrpCfg, to: HsrpState): void {
  if (g.state === to) return;
  const from = g.state;
  g.state = to;
  g.stateSince = rt.ctx.now;
  rlog(
    rt,
    'HSRP',
    {
      key: 'hsrp.state',
      params: { iface: rt.ctx.deviceIfaceName(iface.id), group: g.group, from, to },
    },
    {
      status: to === 'active' ? 'ok' : 'info',
      debug: {
        tag: 'hsrp',
        text: () =>
          `HSRP: ${rt.ctx.deviceIfaceName(iface.id)} Grp ${g.group} state ${cap(from)} -> ${cap(to)}`,
      },
    },
  );
  const id = nm(iface.id, g.group);
  if (to === 'speak' || to === 'standby' || to === 'active') {
    setBg(rt, `rt:hsrp:hello:${id}`, 50_000, g.helloSec * SEC);
  } else cancelBg(rt, `rt:hsrp:hello:${id}`);
  if (to === 'active') {
    // Gratuitous ARP mit der virtuellen MAC als Quelle → Switches lernen den neuen Port
    const arp = {
      kind: 'arp' as const,
      op: 'request' as const,
      senderMac: vmacOf(g.group),
      senderIp: g.vip as string,
      targetMac: '00:00:00:00:00:00',
      targetIp: g.vip as string,
    };
    rt.node.xmit(rt.ctx, iface, eth(vmacOf(g.group), ARP_BROADCAST, arp));
    sendHello(rt, iface, g);
  }
  if (to === 'speak') setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
  if (to === 'listen') setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
  rt.ctx.requestRefresh();
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function sendHello(rt: Rt, iface: Iface, g: HsrpCfg, op: HsrpPdu['op'] = 'hello'): void {
  const pdu: HsrpPdu = {
    kind: 'hsrp',
    group: g.group,
    op,
    state: g.state,
    helloSec: g.helloSec,
    holdSec: g.holdSec,
    priority: effPriority(rt, g),
    vip: g.vip as string,
  };
  sendMcast(
    rt,
    iface,
    HSRP_GROUP,
    { kind: 'udp', srcPort: 1985, dstPort: 1985, dataSize: 0, app: pdu },
    g.state === 'active' ? vmacOf(g.group) : undefined,
  );
  dbg(
    rt,
    'HSRP',
    'hsrp',
    () =>
      `HSRP: ${rt.ctx.deviceIfaceName(iface.id)} Grp ${g.group} Hello out ${iface.ip} ${cap(g.state)} pri ${pdu.priority} vIP ${g.vip}`,
  );
}

// ------------------------------------------------------------------ Sync

export function hsrpSync(rt: Rt): void {
  const live = new Set<string>();
  for (const { iface, g } of slots(rt)) {
    live.add(nm(iface.id, g.group));
    if (g.state === 'init') {
      setState(rt, iface, g, 'listen');
    } else reeval(rt, iface, g);
  }
  // Gruppen auf ausgefallenen Schnittstellen zurücksetzen
  for (const [id, ic] of Object.entries(rt.cfg.ifaces)) {
    for (const g of Object.values(ic.hsrp ?? {})) {
      if (live.has(nm(id, g.group))) continue;
      if (g.state !== 'init') {
        const was = g.state;
        g.state = 'init';
        g.activeIp = undefined;
        g.standbyIp = undefined;
        for (const k of ['hello', 'active', 'standby', 'state'])
          cancelBg(rt, `rt:hsrp:${k}:${nm(id, g.group)}`);
        rlog(
          rt,
          'HSRP',
          {
            key: 'hsrp.state',
            params: { iface: rt.ctx.deviceIfaceName(id), group: g.group, from: was, to: 'init' },
          },
          {
            debug: {
              tag: 'hsrp',
              text: () =>
                `HSRP: ${rt.ctx.deviceIfaceName(id)} Grp ${g.group} state ${cap(was)} -> Init`,
            },
          },
        );
      }
    }
  }
}

export function hsrpStop(rt: Rt): void {
  for (const [id, ic] of Object.entries(rt.cfg.ifaces)) {
    for (const g of Object.values(ic.hsrp ?? {})) {
      for (const k of ['hello', 'active', 'standby', 'state'])
        cancelBg(rt, `rt:hsrp:${k}:${nm(id, g.group)}`);
    }
  }
}

/** Preempt/Priorität neu bewerten (z. B. nach Tracking-Änderung). */
function reeval(rt: Rt, iface: Iface, g: HsrpCfg): void {
  if (g.state === 'active' || !g.preempt) return;
  if (
    g.activeIp &&
    g.state !== 'listen' &&
    better(effPriority(rt, g), iface.ip, g.activePriority, g.activeIp)
  ) {
    setState(rt, iface, g, 'active');
  }
}

// ------------------------------------------------------------------ Empfang

export function hsrpRx(rt: Rt, iface: Iface, ip: Ipv4Pdu, pdu: HsrpPdu): void {
  const g = iface.cfg.hsrp?.[pdu.group];
  if (!g || !g.vip || g.state === 'init' || ip.src === iface.ip) return;
  rlog(
    rt,
    'HSRP',
    {
      key: 'hsrp.rx',
      params: { src: ip.src, group: pdu.group, state: pdu.state, prio: pdu.priority },
    },
    {
      kind: 'rx',
      status: 'ok',
      debug: {
        tag: 'hsrp',
        text: () =>
          `HSRP: ${rt.ctx.deviceIfaceName(iface.id)} Grp ${pdu.group} Hello in ${ip.src} ${cap(pdu.state)} pri ${pdu.priority} vIP ${pdu.vip}`,
      },
    },
  );
  const id = nm(iface.id, g.group);
  const mine = effPriority(rt, g);
  if (pdu.state === 'active') {
    if (g.state === 'active') {
      if (better(pdu.priority, ip.src, mine, iface.ip)) {
        g.activeIp = ip.src;
        g.activePriority = pdu.priority;
        g.lastActiveHello = rt.ctx.now;
        setState(rt, iface, g, 'speak');
        setBg(rt, `rt:hsrp:active:${id}`, g.holdSec * SEC);
      } else {
        // Wir gewinnen den Konflikt: sofort Hello senden
        sendHello(rt, iface, g);
      }
      return;
    }
    g.activeIp = ip.src;
    g.activePriority = pdu.priority;
    g.lastActiveHello = rt.ctx.now;
    setBg(rt, `rt:hsrp:active:${id}`, Math.max(g.holdSec, pdu.holdSec) * SEC);
    if (g.preempt && better(mine, iface.ip, pdu.priority, ip.src)) {
      setState(rt, iface, g, 'active');
      return;
    }
    if (g.state === 'listen') setState(rt, iface, g, 'speak');
    return;
  }
  if (pdu.state === 'standby') {
    g.standbyIp = ip.src;
    g.standbyPriority = pdu.priority;
    g.lastStandbyHello = rt.ctx.now;
    setBg(rt, `rt:hsrp:standby:${id}`, Math.max(g.holdSec, pdu.holdSec) * SEC);
    if (g.state === 'standby' && better(pdu.priority, ip.src, mine, iface.ip)) {
      setState(rt, iface, g, 'speak');
    } else if (g.state === 'listen') setState(rt, iface, g, 'speak');
    return;
  }
  // speak/listen anderer Router
  if (g.state === 'listen') setState(rt, iface, g, 'speak');
}

// ------------------------------------------------------------------ Timer

export function hsrpTimer(rt: Rt, name: string): boolean {
  if (!name.startsWith('rt:hsrp:')) return false;
  const [, , kind, ifaceId, groupS] = name.split(':');
  const iface = rt.node.ifaces.find((i) => i.id === ifaceId);
  const g = iface?.cfg.hsrp?.[Number(groupS)];
  if (!iface || !g || !g.vip) return true;
  if (kind === 'hello') {
    if (g.state === 'speak' || g.state === 'standby' || g.state === 'active')
      sendHello(rt, iface, g);
    return true;
  }
  const id = nm(iface.id, g.group);
  if (kind === 'active') {
    g.activeIp = undefined;
    if (g.state === 'standby') setState(rt, iface, g, 'active');
    else if (g.state === 'listen') setState(rt, iface, g, 'speak');
    else if (g.state === 'speak') evaluateSpeak(rt, iface, g);
    return true;
  }
  if (kind === 'standby') {
    g.standbyIp = undefined;
    if (g.state === 'speak') evaluateSpeak(rt, iface, g);
    return true;
  }
  if (kind === 'state') {
    if (g.state === 'listen') setState(rt, iface, g, 'speak');
    else if (g.state === 'speak') evaluateSpeak(rt, iface, g);
    void id;
    return true;
  }
  return true;
}

/** Ende der Speak-Phase: Active/Standby besetzen. */
function evaluateSpeak(rt: Rt, iface: Iface, g: HsrpCfg): void {
  const id = nm(iface.id, g.group);
  const mine = effPriority(rt, g);
  if (!g.activeIp) {
    if (!g.standbyIp || better(mine, iface.ip, g.standbyPriority, g.standbyIp))
      setState(rt, iface, g, 'active');
    else setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
    return;
  }
  if (!g.standbyIp || better(mine, iface.ip, g.standbyPriority, g.standbyIp))
    setState(rt, iface, g, 'standby');
  else setBg(rt, `rt:hsrp:state:${id}`, g.holdSec * SEC);
}
