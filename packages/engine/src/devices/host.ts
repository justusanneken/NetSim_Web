import { apRx, apXmit } from '../p5/ap';
import { hostPort } from '../p5/hostport';
import { sameSubnet, summarizeFrame, type Frame, type Ipv4Addr } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { diagTimer, startPing, startTrace, type PingOptions } from '../diag';
import type { Iface } from '../ifaces';
import { ifaceFrameRx, ipTimer, sendArpRequest, type IpNode } from '../l3';
import { hostIfaces6, hostNode6, ip6FrameRx, ip6Timer, hostV6Start } from '../l3v6';
import { dhcpProbeReply, dhcpStart, dhcpStop, dhcpTimer } from '../svc/dhcpclient';
import { dnsResolve, dnsTimer } from '../svc/dns';
import { httpGet, tcpTimer } from '../svc/tcp';
import type { Device, HostConfig, IpCore, Result } from '../types';

export const HOST_ARP_TTL_US = 120_000_000;
export const DEFAULT_TTL = 128;
export { PING_TIMEOUT_US } from '../diag';
export type { PingOptions };
export { newIpCore } from '../defaults';

/** IP-Sicht auf einen Host: eine Schnittstelle, Default-Gateway, kein Forwarding. */
export function hostNode(ctx: DeviceCtx, cfg: HostConfig): IpNode {
  const dev = ctx.device;
  const port = hostPort(dev);
  const ifaces: Iface[] =
    port && cfg.ip && cfg.mask
      ? [
          {
            id: port.id,
            kind: 'phys',
            portId: port.id,
            mac: port.mac,
            ip: cfg.ip,
            mask: cfg.mask,
            mtu: port.mtu,
            cfg: { kind: 'phys', portId: port.id, ip: cfg.ip, mask: cfg.mask },
          },
        ]
      : [];
  const iface = ifaces[0];
  const ifaces6 = hostIfaces6(dev, cfg);
  return {
    v6: ifaces6.length > 0 ? hostNode6(ifaces6, cfg, ctx.now) : undefined,
    dev,
    cfg,
    host: cfg,
    forwarding: false,
    arpTtlUs: HOST_ARP_TTL_US,
    defaultTtl: DEFAULT_TTL,
    ifaces,
    lookup(dst) {
      if (!iface) return undefined;
      if (sameSubnet(dst, iface.ip, iface.mask)) return { nextHop: dst, iface };
      return cfg.gateway ? { nextHop: cfg.gateway, iface } : undefined;
    },
    xmit: (c, i, frame) =>
      cfg.ap ? apXmit(c, cfg, frame) : c.send(i.portId, frame, c.processingUs),
  };
}

export function hostRx(
  ctx: DeviceCtx,
  cfg: HostConfig,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  if (cfg.ap) {
    apRx(ctx, cfg, portId, frame, fromId, () => hostRxLocal(ctx, cfg, portId, frame, fromId));
    return;
  }
  hostRxLocal(ctx, cfg, portId, frame, fromId);
}

function hostRxLocal(
  ctx: DeviceCtx,
  cfg: HostConfig,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const node = hostNode(ctx, cfg);
  const port = ctx.port(portId);
  if (frame.vlan) return; // NIC ignoriert getaggte Frames
  if (frame.payload.kind === 'ipv6') {
    const i6 = node.v6?.ifaces[0];
    if (node.v6 && i6)
      ip6FrameRx(ctx, { cfg, v6: node.v6, host: cfg, xmit: node.xmit }, i6, frame, fromId, port);
    return;
  }
  const iface = node.ifaces[0];
  if (!iface) {
    // Ohne IP: DHCP-Antworten und ARP-Probe-Antworten trotzdem verarbeiten
    const p = frame.payload;
    const { proto, info } = summarizeFrame(frame);
    if (p.kind === 'arp' && p.op === 'reply' && dhcpProbeReply(ctx, node, cfg, p.senderIp)) return;
    if (
      p.kind === 'ipv4' &&
      p.payload.kind === 'udp' &&
      p.payload.dstPort === 68 &&
      cfg.dhcpClient.enabled
    ) {
      const pseudo: Iface = {
        id: port.id,
        kind: 'phys',
        portId: port.id,
        mac: port.mac,
        ip: '0.0.0.0',
        mask: '0.0.0.0',
        mtu: port.mtu,
        cfg: { kind: 'phys', portId: port.id },
      };
      if (frame.dst === port.mac || frame.dst === 'ff:ff:ff:ff:ff:ff') {
        ifaceFrameRxNoIp(ctx, node, pseudo, frame, fromId, port);
        return;
      }
    }
    ctx.log({
      from: fromId,
      port,
      frame,
      summary: info,
      proto,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'host.noIp' },
    });
    return;
  }
  ifaceFrameRx(ctx, node, iface, frame, fromId, port);
}

function ifaceFrameRxNoIp(
  ctx: DeviceCtx,
  node: IpNode,
  pseudo: Iface,
  frame: Frame,
  fromId: string,
  port: ReturnType<DeviceCtx['port']>,
): void {
  // Nur UDP/DHCP-Antworten: über die normale Pipeline mit Pseudo-Schnittstelle (Broadcast-Ziel)
  const n: IpNode = { ...node, ifaces: [pseudo] };
  ifaceFrameRx(ctx, n, pseudo, frame, fromId, port);
}

export function hostTimer(ctx: DeviceCtx, cfg: HostConfig, name: string): void {
  const node = hostNode(ctx, cfg);
  if (node.v6 && ip6Timer(ctx, { cfg, v6: node.v6, host: cfg, xmit: node.xmit }, name)) return;
  if (ipTimer(ctx, node, name)) return;
  if (diagTimer(ctx, node, name)) return;
  if (dhcpTimer(ctx, node, cfg, name)) return;
  if (dnsTimer(ctx, node, cfg, name)) return;
  tcpTimer(ctx, node, cfg, name);
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

export function hostHttp(ctx: DeviceCtx, cfg: HostConfig, url: string): number {
  return httpGet(ctx, hostNode(ctx, cfg), cfg, url);
}

export function hostResolve(ctx: DeviceCtx, cfg: HostConfig, name: string) {
  return dnsResolve(ctx, hostNode(ctx, cfg), cfg, name);
}

export function hostDhcp(ctx: DeviceCtx, cfg: HostConfig, on: boolean): void {
  const node = hostNode(ctx, cfg);
  if (on) dhcpStart(ctx, node, cfg);
  else dhcpStop(ctx, node, cfg);
}

/** Gratuitous ARP nach IP-Änderung. */
export function announce(ctx: DeviceCtx, cfg: HostConfig): void {
  const node = hostNode(ctx, cfg);
  const iface = node.ifaces[0];
  if (iface) sendArpRequest(ctx, node, iface, iface.ip);
}

/** Setzt flüchtigen Laufzeitzustand zurück (Ausschalten / IP-Änderung). */
export function resetIpRuntime(cfg: IpCore): void {
  cfg.arpCache = {};
  cfg.arpPending = {};
  cfg.nd = {};
  cfg.ndPending = {};
  cfg.reasm = {};
  cfg.pingSessions = [];
}

export const isHostDevice = (d: Device): d is Device & { config: HostConfig } =>
  d.config.kind === 'host';

/** IPv6-Start eines Hosts: Router Solicitation für SLAAC. */
export function hostV6(ctx: DeviceCtx, cfg: HostConfig): void {
  hostV6Start(ctx, cfg);
}
