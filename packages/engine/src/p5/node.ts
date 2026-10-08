import type { DeviceCtx } from '../ctx';
import { hostNode } from '../devices/host';
import { l3Node, type L3Dev } from '../devices/l3dev';
import type { IpNode } from '../l3';
import { newAppCore } from '../p5defaults';
import type { AppCore } from '../p5types';
import type { Device, IpCore } from '../types';

/** IP-Sicht eines Geräts (Host, Router, L3-/L2-Switch mit SVI); `undefined` für Geräte ohne IP-Stack. */
export function ipNodeOf(ctx: DeviceCtx, dev: Device = ctx.device): IpNode | undefined {
  const c = dev.config;
  if (c.kind === 'host') return hostNode(ctx, c);
  if (c.kind === 'router' || c.kind === 'switch') return l3Node(ctx, dev as L3Dev);
  return undefined;
}

/** Zustand der Anwendungsdienste (lazy angelegt). */
export const appcOf = (cfg: IpCore): AppCore => (cfg.appc ??= newAppCore());

/** Eine der Adressen des Knotens (für Absenderangaben ohne Routing-Kontext). */
export const firstIp = (node: IpNode): string => node.ifaces[0]?.ip ?? '0.0.0.0';
