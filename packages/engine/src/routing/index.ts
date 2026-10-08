import type { Ipv4Pdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { L3Dev } from '../devices/l3dev';
import type { Iface } from '../ifaces';
import type { Base, IpNode } from '../l3';
import type { L3Cfg } from '../types';
import { rtOf, setBg, type Rt } from './core';
import { ospfRecompute, ospfRx, ospfStop, ospfSync, ospfTimer } from './ospf';
import { ripRecompute, ripRx, ripStop, ripSync, ripTimer } from './rip';
import { newRouting } from './types';

export { newRouting } from './types';
export { newRip } from './rip';
export { newOspf } from './ospf';

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
    if (!changed) break;
  }
  rt.ctx.requestRefresh();
}

/** Konfiguration/Topologie hat sich geändert: Protokollprozesse anpassen. */
export function routingSync(ctx: DeviceCtx, dev: L3Dev): void {
  const rt = rtOf(ctx, dev);
  ripSync(rt);
  ospfSync(rt);
  requestRecompute(rt);
}

export function routingStop(ctx: DeviceCtx, dev: L3Dev): void {
  const rt = rtOf(ctx, dev);
  ripStop(rt);
  ospfStop(rt);
}

export function routingTimer(ctx: DeviceCtx, dev: L3Dev, name: string): void {
  const rt = rtOf(ctx, dev);
  if (name === RECOMPUTE) {
    recompute(rt);
    return;
  }
  if (ripTimer(rt, name)) return;
  if (ospfTimer(rt, name)) return;
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
  else if (l4.kind === 'routing' && l4.proto === 'ospf') ospfRx(rt, iface, base, ip, l4.msg);
}

/** Setzt den flüchtigen Zustand zurück (Ausschalten/Reload) – Konfiguration bleibt erhalten. */
export function routingResetRuntime(cfg: L3Cfg): void {
  cfg.dynRoutes = [];
  const r = cfg.routing;
  if (r.rip) {
    r.rip.routes = {};
    r.rip.timersArmed = false;
  }
  for (const c of Object.values(r.ospf)) {
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
