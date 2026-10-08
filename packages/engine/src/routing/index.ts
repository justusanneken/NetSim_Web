import type { Ipv4Pdu, Ipv6Pdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { L3Dev } from '../devices/l3dev';
import type { Iface } from '../ifaces';
import type { Base, IpNode } from '../l3';
import type { Ip6Host, Iface6 } from '../l3v6';
import type { L3Cfg } from '../types';
import { rtOf, setBg, type Rt } from './core';
import { bgpRecompute, bgpReset, bgpRx, bgpStop, bgpSync, bgpTimer } from './bgp';
import { eigrpRecompute, eigrpReset, eigrpRx, eigrpStop, eigrpSync, eigrpTimer } from './eigrp';
import { syncRa } from '../l3v6';
import { greRx } from './gre';
import { hsrpRx, hsrpRx6, hsrpStop, hsrpSync, hsrpTimer } from './hsrp';
import { pseudoIface, ospfRecompute, ospfRx, ospfStop, ospfSync, ospfTimer } from './ospf';
import { ripRecompute, ripRx, ripStop, ripSync, ripTimer } from './rip';

export { newRouting } from './types';
export { newRip } from './rip';
export { newOspf } from './ospf';
export { newEigrp } from './eigrp';
export { newBgp, newBgpNbr } from './bgp';
export {
  newHsrp,
  vmacOf,
  vmac6Of,
  virtualLl6,
  hsrpVips,
  hsrpVips6,
  hsrpVersion,
  vipOf,
} from './hsrp';

const RECOMPUTE = 'rt:recompute';

function rtFromNode(ctx: DeviceCtx, node: IpNode): Rt {
  const cfg = node.l3 as L3Cfg;
  return { ctx, dev: node.dev as L3Dev, node, cfg, r: cfg.routing };
}

/** Verzögerte Neuberechnung (Bündelung mehrerer Änderungen im selben Moment). */
export function requestRecompute(rt: Rt): void {
  setBg(rt, RECOMPUTE, 1000);
}

/** Alle Protokolle neu berechnen und Redistribution bis zum Fixpunkt wiederholen. */
export function recompute(rt: Rt): void {
  for (let i = 0; i < 5; i++) {
    let changed = false;
    changed = ripRecompute(rt) || changed;
    changed = ospfRecompute(rt) || changed;
    changed = eigrpRecompute(rt) || changed;
    changed = bgpRecompute(rt) || changed;
    if (!changed) break;
  }
  rt.ctx.requestRefresh();
}

/** Konfiguration/Topologie hat sich geändert: Protokollprozesse anpassen. */
export function routingSync(ctx: DeviceCtx, dev: L3Dev): void {
  const rt = rtOf(ctx, dev);
  syncRa(ctx, rt.cfg, rt.node.v6?.ifaces ?? []);
  ripSync(rt);
  ospfSync(rt);
  eigrpSync(rt);
  hsrpSync(rt);
  bgpSync(rt);
  requestRecompute(rt);
}

export function routingStop(ctx: DeviceCtx, dev: L3Dev): void {
  const rt = rtOf(ctx, dev);
  ripStop(rt);
  ospfStop(rt);
  eigrpStop(rt);
  hsrpStop(rt);
  bgpStop(rt);
}

export function routingTimer(ctx: DeviceCtx, dev: L3Dev, name: string): void {
  const rt = rtOf(ctx, dev);
  if (name === RECOMPUTE) {
    recompute(rt);
    return;
  }
  if (ripTimer(rt, name)) return;
  if (ospfTimer(rt, name)) return;
  if (eigrpTimer(rt, name)) return;
  if (hsrpTimer(rt, name)) return;
  if (bgpTimer(rt, name)) return;
}

export function routingRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
): void {
  const rt = rtFromNode(ctx, node);
  const l4 = ip.payload;
  if (l4.kind === 'udp' && l4.app?.kind === 'rip') ripRx(rt, iface, base, ip, l4.app);
  else if (l4.kind === 'udp' && l4.app?.kind === 'hsrp') hsrpRx(rt, iface, ip, l4.app);
  else if (l4.kind === 'gre') greRx(rt, base, ip, l4);
  else if (l4.kind === 'routing' && l4.proto === 'ospf') ospfRx(rt, iface, base, ip, l4.msg);
  else if (l4.kind === 'routing' && l4.proto === 'eigrp') eigrpRx(rt, iface, base, ip, l4.msg);
  else if (l4.kind === 'routing' && l4.proto === 'bgp') bgpRx(rt, iface, ip, l4.msg);
}

/** Setzt den flüchtigen Zustand zurück (Ausschalten/Reload) – Konfiguration bleibt erhalten. */
function hsrpResetCfg(cfg: L3Cfg): void {
  for (const ic of Object.values(cfg.ifaces)) {
    for (const g of [...Object.values(ic.hsrp ?? {}), ...Object.values(ic.hsrp6 ?? {})]) {
      g.state = 'init';
      g.activeIp = undefined;
      g.standbyIp = undefined;
      g.lastActiveHello = 0;
      g.lastStandbyHello = 0;
    }
  }
}

export function routingResetRuntime(cfg: L3Cfg): void {
  cfg.dynRoutes = [];
  cfg.dynRoutes6 = [];
  cfg.raIfs = [];
  for (const ic of Object.values(cfg.ifaces)) if (ic.v6) ic.v6.slaac = [];
  const r = cfg.routing;
  if (r.rip) {
    r.rip.routes = {};
    r.rip.held = {};
    r.rip.timersArmed = false;
  }
  hsrpResetCfg(cfg);
  if (r.bgp) bgpReset(r.bgp);
  for (const c of Object.values(r.eigrp)) eigrpReset(c);
  for (const c of [...Object.values(r.ospf), ...Object.values(r.ospf6)]) {
    c.ifs = {};
    c.lsdb = {};
    c.installed = {};
    c.seqs = {};
    c.externals = {};
    c.rid = undefined;
    c.dirty = true;
    c.timersArmed = false;
  }
}

/** IPv6-Routing-Pakete (OSPFv3). */
export function routingRx6(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  base: Base,
  pkt: Ipv6Pdu,
): void {
  if (!n.dev) return;
  const rt = rtOf(ctx, n.dev as L3Dev);
  const l4 = pkt.payload;
  if (l4.kind === 'routing' && l4.proto === 'ospf' && l4.v === 3)
    ospfRx(rt, pseudoIface(iface), base, { src: pkt.src }, l4.msg, true);
  else if (l4.kind === 'udp' && l4.app?.kind === 'hsrp') hsrpRx6(rt, iface, pkt, l4.app);
}
