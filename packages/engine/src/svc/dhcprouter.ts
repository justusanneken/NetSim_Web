import type { DhcpOp, DhcpPdu, Frame } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { ifaceName, type Iface } from '../ifaces';
import { newIpPacket, sendBroadcast, type Base, type IpNode } from '../l3';
import { syslogEmit } from '../p5/syslog';
import type { Device, IfaceCfg, L3Cfg } from '../types';

/**
 * Router-Schnittstelle als DHCP-Client (`ip address dhcp`). Vereinfachungen: keine ARP-Probe,
 * Verlängerung per Broadcast-REQUEST mit `ciaddr`; der gelieferte Gateway wird als Default-Route mit
 * AD 254 installiert (wie IOS).
 */
const RETRY_US = 4_000_000;

const timer = (id: string, what: 'retry' | 'renew' | 'expire'): string => `dhcpc:${id}:${what}`;

/** Schnittstelle zum Senden – auch ohne Adresse (Port bzw. Subinterface). */
export function dhcpcIface(dev: Device, id: string, c: IfaceCfg): Iface | undefined {
  const port = dev.ports.find((p) => p.id === c.portId);
  if (!port || (c.kind !== 'phys' && c.kind !== 'sub')) return undefined;
  return {
    id,
    kind: c.kind,
    portId: port.id,
    vlan: c.kind === 'sub' ? c.vlan : undefined,
    mac: port.mac,
    ip: c.ip ?? '0.0.0.0',
    mask: c.mask ?? '0.0.0.0',
    mtu: port.mtu,
    cfg: c,
  };
}

function send(
  ctx: DeviceCtx,
  node: IpNode,
  id: string,
  c: IfaceCfg,
  op: DhcpOp,
  extra: DhcpPdu['options'],
): void {
  const iface = dhcpcIface(node.dev, id, c);
  const cl = c.dhcpc;
  if (!iface || !cl) return;
  const ciaddr = cl.state === 'renewing' && c.ip ? c.ip : '0.0.0.0';
  const msg: DhcpPdu = {
    kind: 'dhcp',
    op,
    xid: cl.xid,
    chaddr: iface.mac,
    ciaddr,
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    options: extra,
  };
  const udp = { kind: 'udp' as const, srcPort: 68, dstPort: 67, dataSize: 0, app: msg };
  sendBroadcast(ctx, node, iface, newIpPacket(node, ciaddr, '255.255.255.255', udp));
}

/** DORA starten (Konfiguration, Neustart, NAK, Ablauf). */
export function routerDhcpStart(ctx: DeviceCtx, node: IpNode, id: string, c: IfaceCfg): void {
  const cl = (c.dhcpc ??= { state: 'selecting', xid: 0, leaseSec: 0 });
  for (const w of ['retry', 'renew', 'expire'] as const) ctx.cancelTimer(timer(id, w));
  cl.state = 'selecting';
  cl.xid = (ctx.rand(0x7fffffff) + 1) >>> 0;
  cl.offered = undefined;
  cl.router = undefined;
  cl.server = undefined;
  c.ip = undefined;
  c.mask = undefined;
  send(ctx, node, id, c, 'discover', {});
  ctx.setTimer(timer(id, 'retry'), RETRY_US);
}

/** `no ip address` bzw. statische Adresse: Client beenden (mit RELEASE, falls gebunden). */
export function routerDhcpStop(ctx: DeviceCtx, node: IpNode, id: string, c: IfaceCfg): void {
  const cl = c.dhcpc;
  if (!cl) return;
  for (const w of ['retry', 'renew', 'expire'] as const) ctx.cancelTimer(timer(id, w));
  if ((cl.state === 'bound' || cl.state === 'renewing') && c.ip && cl.server) {
    cl.state = 'renewing';
    send(ctx, node, id, c, 'release', { serverId: cl.server });
  }
  c.dhcpc = undefined;
  c.ip = undefined;
  c.mask = undefined;
}

/** Laufzeit nach Ausschalten: Adresse vergessen, beim Start neu beziehen. */
export function routerDhcpReset(cfg: L3Cfg): void {
  for (const c of Object.values(cfg.ifaces)) {
    if (!c.dhcpc) continue;
    c.dhcpc = { state: 'selecting', xid: 0, leaseSec: 0 };
    c.ip = undefined;
    c.mask = undefined;
  }
}

/** Beim Start: alle `ip address dhcp`-Schnittstellen beziehen eine Adresse. */
export function routerDhcpBoot(ctx: DeviceCtx, node: IpNode, cfg: L3Cfg): void {
  for (const [id, c] of Object.entries(cfg.ifaces))
    if (c.dhcpc && c.dhcpc.state === 'selecting') routerDhcpStart(ctx, node, id, c);
}

function entryFor(node: IpNode, mac: string, xid: number): [string, IfaceCfg] | undefined {
  const cfg = node.l3;
  if (!cfg) return undefined;
  return Object.entries(cfg.ifaces).find(
    ([id, c]) => c.dhcpc?.xid === xid && dhcpcIface(node.dev, id, c)?.mac === mac,
  );
}

/** Antwort des Servers an eine Client-Schnittstelle; `true` = verbraucht. */
export function routerClientRx(
  ctx: DeviceCtx,
  node: IpNode,
  _iface: Iface | undefined,
  base: Base,
  m: DhcpPdu,
): boolean {
  const hit = entryFor(node, m.chaddr, m.xid);
  if (!hit) return false;
  const [id, c] = hit;
  const cl = c.dhcpc;
  if (!cl) return false;
  const log = (
    key: string,
    params: Record<string, string | number> = {},
    status: 'ok' | 'drop' = 'ok',
  ): void => ctx.log({ ...base, kind: 'rx', proto: 'DHCP', status, msg: { key, params } });
  if (m.op === 'offer' && cl.state === 'selecting') {
    cl.offered = {
      ip: m.yiaddr,
      mask: m.options.mask ?? '255.255.255.0',
      router: m.options.router,
      leaseSec: m.options.leaseSec ?? 86400,
    };
    cl.server = m.options.serverId ?? m.siaddr;
    cl.state = 'requesting';
    log('dhcp.gotOffer', { ip: m.yiaddr, server: cl.server });
    send(ctx, node, id, c, 'request', { requestedIp: m.yiaddr, serverId: cl.server });
    ctx.setTimer(timer(id, 'retry'), RETRY_US);
  } else if (m.op === 'ack' && (cl.state === 'requesting' || cl.state === 'renewing')) {
    ctx.cancelTimer(timer(id, 'retry'));
    const first = cl.state === 'requesting';
    const off = cl.offered;
    cl.leaseSec = m.options.leaseSec ?? off?.leaseSec ?? 86400;
    cl.state = 'bound';
    if (first && off) {
      c.ip = off.ip;
      c.mask = off.mask;
      cl.router = off.router;
      log('dhcp.bound', { ip: off.ip });
      syslogEmit(
        ctx,
        node.dev,
        6,
        'DHCP-6-ADDRESS_ASSIGN',
        `Interface ${ifaceName(node.dev, id, c)} assigned DHCP address ${off.ip}, mask ${off.mask}, hostname ${(node.dev.config as { sys?: { hostname?: string } }).sys?.hostname ?? ''}`,
      );
    } else log('dhcp.renewed', { ip: m.yiaddr });
    ctx.setTimer(timer(id, 'renew'), (cl.leaseSec * 1_000_000) / 2);
    ctx.setTimer(timer(id, 'expire'), cl.leaseSec * 1_000_000);
  } else if (m.op === 'nak') {
    log('dhcp.gotNak', {}, 'drop');
    routerDhcpStart(ctx, node, id, c);
  } else return false;
  return true;
}

/** Timer `dhcpc:<if>:…`; `true` = behandelt. */
export function routerDhcpTimer(ctx: DeviceCtx, node: IpNode, name: string): boolean {
  if (!name.startsWith('dhcpc:')) return false;
  const [, id, what] = name.split(':');
  const c = id ? node.l3?.ifaces[id] : undefined;
  const cl = c?.dhcpc;
  if (!c || !cl || !id) return true;
  if (what === 'retry' && (cl.state === 'selecting' || cl.state === 'requesting'))
    routerDhcpStart(ctx, node, id, c);
  else if (what === 'renew' && cl.state === 'bound') {
    cl.state = 'renewing';
    send(ctx, node, id, c, 'request', { requestedIp: c.ip, serverId: cl.server });
  } else if (what === 'expire') {
    ctx.log({ kind: 'error', proto: 'DHCP', status: 'error', msg: { key: 'dhcp.expired' } });
    routerDhcpStart(ctx, node, id, c);
  }
  return true;
}

/** Eingehender Frame an einem Port ohne Adresse: DHCP-Antwort an den Client? */
export function routerDhcpRxNoIp(ctx: DeviceCtx, node: IpNode, frame: Frame, base: Base): boolean {
  const ip = frame.payload;
  if (ip.kind !== 'ipv4' || ip.payload.kind !== 'udp' || ip.payload.dstPort !== 68) return false;
  const app = ip.payload.app;
  if (app?.kind !== 'dhcp') return false;
  return routerClientRx(ctx, node, undefined, base, app);
}
