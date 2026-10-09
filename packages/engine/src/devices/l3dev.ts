import type { Frame, Ipv4Addr } from '@netsim/protocols';
import { sameSubnet } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { diagTimer, startPing, startTrace, type PingOptions } from '../diag';
import { listIfaces } from '../ifaces';
import { ifaceFrameRx, ipTimer, type IpNode, type XmitIface } from '../l3';
import { buildRib, lookupRib, lookupRibPaths, pickPath } from '../rib';
import { greXmit } from '../routing/gre';
import { cryptoXmit } from '../routing/ipsec';
import { pppoeRx, pppoeXmit } from '../routing/pppoe';
import { hsrpVips } from '../routing/hsrp';
import { routingTimer } from '../routing';
import { ip6FrameRx, ip6Timer, listIfaces6, routerNode6 } from '../l3v6';
import type { Device, IfaceCfg, Result, RouterConfig, SwitchConfig } from '../types';
import { switchOriginate, type SwitchDev } from './switch';

export type L3Dev = Device & { config: RouterConfig | SwitchConfig };

const ifaceIp = (node: IpNode, id: string): string =>
  node.ifaces.find((i) => i.id === id)?.ip ?? '0.0.0.0';

export const ROUTER_ARP_TTL_US = 14_400_000_000;
export const ROUTER_TTL = 255;

/** IP-Sicht auf Router bzw. Switch mit SVIs/Routed Ports. */
export function l3Node(ctx: DeviceCtx, dev: L3Dev): IpNode {
  const cfg = dev.config;
  let ifaces = listIfaces(dev, cfg);
  let tunnelOk = (_c: IfaceCfg): boolean => true;
  if (Object.values(cfg.ifaces).some((c) => c.kind === 'tunnel')) {
    // Tunnel nur „up“, wenn das Ziel über eine andere Schnittstelle erreichbar ist
    const rib0 = buildRib(
      cfg,
      ifaces.filter((i) => i.kind !== 'tunnel'),
    );
    tunnelOk = (c) => {
      const dst = c.tunnel?.destination;
      return !!dst && lookupRib(rib0, dst) !== undefined;
    };
    ifaces = ifaces.filter((i) => i.kind !== 'tunnel' || tunnelOk(i.cfg));
  }
  const rib = buildRib(cfg, ifaces);
  const { vips, silent } = hsrpVips(ifaces);
  const ifaces6 = listIfaces6(dev, cfg, tunnelOk);
  const forwarding = cfg.kind === 'router' || cfg.ipRouting;
  const node: IpNode = {
    dev,
    cfg,
    l3: cfg,
    forwarding,
    arpTtlUs: ROUTER_ARP_TTL_US,
    defaultTtl: ROUTER_TTL,
    ifaces,
    vips,
    silentMacs: silent,
    lookup(dst, src) {
      const paths = lookupRibPaths(rib, dst);
      const e = paths.length ? pickPath(paths, src, dst) : undefined;
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
    xmit(c: DeviceCtx, iface: XmitIface, frame: Frame) {
      if (iface.kind === 'loop') return;
      if (iface.kind === 'tunnel') {
        greXmit(c, node, iface, frame);
        return;
      }
      // Crypto Map (auch am Dialer einer PPPoE-Einwahl): passende Pakete werden ESP-gekapselt
      if (
        iface.cfg.cryptoMap &&
        cryptoXmit(c, node, { ...iface, ip: ifaceIp(node, iface.id) }, frame)
      )
        return;
      if (iface.kind === 'dialer' || iface.kind === 'vaccess') {
        pppoeXmit(c, node, iface, frame);
        return;
      }
      if (iface.kind === 'svi') {
        switchOriginate(c, dev as SwitchDev, iface.vlan ?? 1, frame);
      } else if (iface.kind === 'sub') {
        c.send(iface.portId, { ...frame, vlan: { vid: iface.vlan ?? 1, pcp: 0 } }, c.processingUs);
      } else c.send(iface.portId, frame, c.processingUs);
    },
  };
  if (ifaces6.length > 0) node.v6 = routerNode6(ifaces6, cfg);
  return node;
}

/** Frame an einem Router-Port: Schnittstelle (physisch/Subinterface) bestimmen. */
export function routerRx(
  ctx: DeviceCtx,
  dev: L3Dev,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  if (frame.payload.kind === 'pppoe') {
    pppoeRx(ctx, dev, portId, frame, fromId);
    return;
  }
  const node = l3Node(ctx, dev);
  if (frame.payload.kind === 'ipv6') {
    const i6 = node.v6?.ifaces.find(
      (i) =>
        i.portId === portId &&
        i.kind !== 'svi' &&
        (i.kind === 'sub' ? frame.vlan?.vid === i.vlan : !frame.vlan),
    );
    if (!i6 || !node.v6) {
      ctx.log({
        kind: 'drop',
        proto: 'ND',
        status: 'drop',
        from: fromId,
        port: ctx.port(portId),
        frame,
        msg: { key: 'host.noIp' },
      });
      return;
    }
    ip6FrameRx(
      ctx,
      { dev, cfg: node.cfg, v6: node.v6, xmit: node.xmit },
      i6,
      frame,
      fromId,
      ctx.port(portId),
    );
    return;
  }
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
  if (node.v6 && ip6Timer(ctx, { dev, cfg: node.cfg, v6: node.v6, xmit: node.xmit }, name)) return;
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
