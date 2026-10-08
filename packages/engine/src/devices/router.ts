import type { Ipv4Addr } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { diagTimer, startPing, startTrace, type PingOptions } from '../diag';
import { ipFrameRx, ipTimer, type Iface, type IpNode } from '../ip';
import { buildRib, lookupRib } from '../rib';
import type { Frame } from '@netsim/protocols';
import type { Result, RouterConfig } from '../types';

export const ROUTER_ARP_TTL_US = 14_400_000_000;
export const ROUTER_TTL = 255;

/** IP-Sicht auf einen Router: mehrere Schnittstellen, Routing-Tabelle, Forwarding. */
export function routerNode(ctx: DeviceCtx, cfg: RouterConfig): IpNode {
  const rib = buildRib(cfg, ctx.device.ports);
  const ifaces: Iface[] = [];
  for (const p of ctx.device.ports) {
    const i = cfg.ifaces[p.id];
    if (i?.ip && i.mask && p.operUp) ifaces.push({ portId: p.id, ip: i.ip, mask: i.mask });
  }
  return {
    cfg,
    forwarding: true,
    arpTtlUs: ROUTER_ARP_TTL_US,
    defaultTtl: ROUTER_TTL,
    ifaces,
    lookup(dst) {
      const e = lookupRib(rib, dst);
      const iface = e?.portId ? ifaces.find((i) => i.portId === e.portId) : undefined;
      if (!e || !iface) return undefined;
      return { nextHop: e.type === 'C' || !e.nextHop ? dst : e.nextHop, iface };
    },
  };
}

export function routerRx(
  ctx: DeviceCtx,
  cfg: RouterConfig,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  ipFrameRx(ctx, routerNode(ctx, cfg), portId, frame, fromId);
}

export function routerTimer(ctx: DeviceCtx, cfg: RouterConfig, name: string): void {
  const node = routerNode(ctx, cfg);
  if (!ipTimer(ctx, node, name)) diagTimer(ctx, node, name);
}

export function routerPing(
  ctx: DeviceCtx,
  cfg: RouterConfig,
  dst: Ipv4Addr,
  opts?: PingOptions,
): Result<number> {
  return startPing(ctx, routerNode(ctx, cfg), dst, opts);
}

export function routerTrace(ctx: DeviceCtx, cfg: RouterConfig, dst: Ipv4Addr, maxHops?: number) {
  return startTrace(ctx, routerNode(ctx, cfg), dst, maxHops);
}
