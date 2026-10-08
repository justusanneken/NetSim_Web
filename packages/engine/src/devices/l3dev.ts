import type { Frame, Ipv4Addr } from '@netsim/protocols';
import { sameSubnet } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { diagTimer, startPing, startTrace, type PingOptions } from '../diag';
import { listIfaces, type Iface } from '../ifaces';
import { ifaceFrameRx, ipTimer, type IpNode } from '../l3';
import { buildRib, lookupRib } from '../rib';
import { routingTimer } from '../routing';
import type { Device, Result, RouterConfig, SwitchConfig } from '../types';
import { switchOriginate, type SwitchDev } from './switch';

export type L3Dev = Device & { config: RouterConfig | SwitchConfig };

export const ROUTER_ARP_TTL_US = 14_400_000_000;
export const ROUTER_TTL = 255;

/** IP-Sicht auf Router bzw. Switch mit SVIs/Routed Ports. */
export function l3Node(ctx: DeviceCtx, dev: L3Dev): IpNode {
  const cfg = dev.config;
  const ifaces = listIfaces(dev, cfg);
  const rib = buildRib(cfg, ifaces);
  const forwarding = cfg.kind === 'router' || cfg.ipRouting;
  return {
    dev,
    cfg,
    l3: cfg,
    forwarding,
    arpTtlUs: ROUTER_ARP_TTL_US,
    defaultTtl: ROUTER_TTL,
    ifaces,
    lookup(dst) {
      const e = lookupRib(rib, dst);
      const iface = e?.ifaceId ? ifaces.find((i) => i.id === e.ifaceId) : undefined;
      if (e && iface && (forwarding || e.type === 'C')) {
        return { nextHop: e.type === 'C' || !e.nextHop ? dst : e.nextHop, iface };
      }
      if (!forwarding && cfg.defaultGateway) {
        const gwIface = ifaces.find((i) => sameSubnet(i.ip, cfg.defaultGateway as string, i.mask));
        if (gwIface) return { nextHop: cfg.defaultGateway, iface: gwIface };
      }
      return undefined;
    },
    xmit(c: DeviceCtx, iface: Iface, frame: Frame) {
      if (iface.kind === 'svi') {
        switchOriginate(c, dev as SwitchDev, iface.vlan ?? 1, frame);
      } else if (iface.kind === 'sub') {
        c.send(iface.portId, { ...frame, vlan: { vid: iface.vlan ?? 1, pcp: 0 } }, c.processingUs);
      } else c.send(iface.portId, frame, c.processingUs);
    },
  };
}

/** Frame an einem Router-Port: Schnittstelle (physisch/Subinterface) bestimmen. */
export function routerRx(
  ctx: DeviceCtx,
  dev: L3Dev,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const node = l3Node(ctx, dev);
  const iface = node.ifaces.find(
    (i) =>
      i.portId === portId &&
      i.kind !== 'svi' &&
      (i.kind === 'sub' ? frame.vlan?.vid === i.vlan : !frame.vlan),
  );
  if (!iface) {
    ctx.log({
      kind: 'drop',
      proto: frame.payload.kind === 'arp' ? 'ARP' : 'ETH',
      status: 'drop',
      from: fromId,
      port: ctx.port(portId),
      frame,
      msg: { key: 'host.noIp' },
    });
    return;
  }
  ifaceFrameRx(ctx, node, iface, frame, fromId, ctx.port(portId));
}

export function l3Timer(ctx: DeviceCtx, dev: L3Dev, name: string): void {
  if (name.startsWith('rt:')) {
    routingTimer(ctx, dev, name);
    return;
  }
  const node = l3Node(ctx, dev);
  if (!ipTimer(ctx, node, name)) diagTimer(ctx, node, name);
}

export function l3Ping(
  ctx: DeviceCtx,
  dev: L3Dev,
  dst: Ipv4Addr,
  opts?: PingOptions,
): Result<number> {
  return startPing(ctx, l3Node(ctx, dev), dst, opts);
}

export function l3Trace(ctx: DeviceCtx, dev: L3Dev, dst: Ipv4Addr, maxHops?: number) {
  return startTrace(ctx, l3Node(ctx, dev), dst, maxHops);
}
