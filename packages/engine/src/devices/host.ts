import type { Ipv4Addr } from '@netsim/protocols';
import { sameSubnet } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { diagTimer, startPing, startTrace, type PingOptions } from '../diag';
import { ipFrameRx, ipTimer, sendArpRequest, type Iface, type IpNode } from '../ip';
import type { HostConfig, IpCore, Result } from '../types';

export const HOST_ARP_TTL_US = 120_000_000;
export const DEFAULT_TTL = 128;
export { PING_TIMEOUT_US } from '../diag';
export type { PingOptions };

export function newIpCore(): IpCore {
  return {
    arpCache: {},
    arpPending: {},
    reasm: {},
    pingSessions: [],
    pings: [],
    nextPingId: 1,
    nextIpId: 1,
    traces: [],
    nextTraceId: 1,
  };
}

/** IP-Sicht auf einen Host: eine Schnittstelle, Default-Gateway, kein Forwarding. */
export function hostNode(ctx: DeviceCtx, cfg: HostConfig): IpNode {
  const port = ctx.device.ports[0];
  const ifaces: Iface[] = port && cfg.ip && cfg.mask ? [{ portId: port.id, ip: cfg.ip, mask: cfg.mask }] : [];
  const iface = ifaces[0];
  return {
    cfg,
    forwarding: false,
    arpTtlUs: HOST_ARP_TTL_US,
    defaultTtl: DEFAULT_TTL,
    ifaces,
    lookup(dst) {
      if (!iface) return undefined;
      if (sameSubnet(dst, iface.ip, iface.mask)) return { nextHop: dst, iface };
      return cfg.gateway ? { nextHop: cfg.gateway, iface } : undefined;
    },
  };
}

export function hostRx(
  ctx: DeviceCtx,
  cfg: HostConfig,
  portId: string,
  frame: Parameters<typeof ipFrameRx>[3],
  fromId: string,
): void {
  ipFrameRx(ctx, hostNode(ctx, cfg), portId, frame, fromId);
}

export function hostTimer(ctx: DeviceCtx, cfg: HostConfig, name: string): void {
  const node = hostNode(ctx, cfg);
  if (!ipTimer(ctx, node, name)) diagTimer(ctx, node, name);
}

export function hostPing(
  ctx: DeviceCtx,
  cfg: HostConfig,
  dst: Ipv4Addr,
  opts?: PingOptions,
): Result<number> {
  return startPing(ctx, hostNode(ctx, cfg), dst, opts);
}

export function hostTrace(ctx: DeviceCtx, cfg: HostConfig, dst: Ipv4Addr, maxHops?: number) {
  return startTrace(ctx, hostNode(ctx, cfg), dst, maxHops);
}

/** Gratuitous ARP nach IP-Änderung. */
export function announce(ctx: DeviceCtx, cfg: HostConfig): void {
  const node = hostNode(ctx, cfg);
  const iface = node.ifaces[0];
  if (iface) sendArpRequest(ctx, iface, iface.ip);
}

/** Setzt flüchtigen Laufzeitzustand zurück (Ausschalten / IP-Änderung). */
export function resetIpRuntime(cfg: IpCore): void {
  cfg.arpCache = {};
  cfg.arpPending = {};
  cfg.reasm = {};
  cfg.pingSessions = [];
}
