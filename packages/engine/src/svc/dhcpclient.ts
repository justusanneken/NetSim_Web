import { hostPort } from '../p5/hostport';
import type { DhcpOp, DhcpPdu, Ipv4Addr } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { eth, newIpPacket, sendBroadcast, sendDirect, type Base, type IpNode } from '../l3';
import type { Iface } from '../ifaces';
import type { HostConfig } from '../types';

const RETRY_US = 4_000_000;
const PROBE_US = 1_000_000;

function pseudoIface(node: IpNode): Iface | undefined {
  const port = hostPort(node.dev);
  if (!port) return undefined;
  return {
    id: port.id,
    kind: 'phys',
    portId: port.id,
    mac: port.mac,
    ip: node.host?.ip ?? '0.0.0.0',
    mask: node.host?.mask ?? '0.0.0.0',
    mtu: port.mtu,
    cfg: { kind: 'phys', portId: port.id },
  };
}

function send(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  op: DhcpOp,
  extra: Partial<DhcpPdu['options']> = {},
  opts: { ciaddr?: Ipv4Addr; unicastTo?: Ipv4Addr } = {},
): void {
  const iface = pseudoIface(node);
  if (!iface) return;
  const msg: DhcpPdu = {
    kind: 'dhcp',
    op,
    xid: h.dhcpClient.xid,
    chaddr: iface.mac,
    ciaddr: opts.ciaddr ?? '0.0.0.0',
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    options: extra,
  };
  const udp = { kind: 'udp' as const, srcPort: 68, dstPort: 67, dataSize: 0, app: msg };
  if (opts.unicastTo) {
    const pkt = newIpPacket(node, opts.ciaddr ?? '0.0.0.0', opts.unicastTo, udp);
    const real = node.ifaces[0];
    const gwMac =
      node.cfg.arpCache[h.gateway ?? opts.unicastTo]?.mac ?? node.cfg.arpCache[opts.unicastTo]?.mac;
    if (real && gwMac) sendDirect(ctx, node, real, gwMac, pkt);
    else sendBroadcast(ctx, node, iface, pkt);
    return;
  }
  sendBroadcast(ctx, node, iface, newIpPacket(node, '0.0.0.0', '255.255.255.255', udp));
}

export function dhcpStart(ctx: DeviceCtx, node: IpNode, h: HostConfig): void {
  const c = h.dhcpClient;
  c.enabled = true;
  c.state = 'selecting';
  c.xid = (ctx.rand(0x7fffffff) + 1) >>> 0;
  c.offered = undefined;
  h.ip = undefined;
  h.mask = undefined;
  h.gateway = undefined;
  send(ctx, node, h, 'discover');
  ctx.log({
    kind: 'info',
    proto: 'DHCP',
    status: 'info',
    msg: { key: 'dhcp.discover', params: { xid: c.xid } },
  });
  ctx.setTimer('dhcp:retry', RETRY_US);
}

/**
 * INIT-REBOOT (RFC 2131 §3.2): nach einem Roaming im selben L2-Segment behält der Client seine Adresse und fragt
 * per Broadcast-REQUEST (ohne Server-ID) nach Bestätigung. ACK ⇒ sofort `bound` (keine ARP-Probe, kein DORA);
 * NAK oder keine Antwort (4 s) ⇒ vollständiger DORA. Gibt `false` zurück, wenn kein Lease vorhanden ist.
 */
export function dhcpReboot(ctx: DeviceCtx, node: IpNode, h: HostConfig): boolean {
  const c = h.dhcpClient;
  if (!c.enabled || !h.ip || (c.state !== 'bound' && c.state !== 'renewing')) return false;
  c.state = 'rebooting';
  c.xid = (ctx.rand(0x7fffffff) + 1) >>> 0;
  c.offered = {
    ip: h.ip,
    mask: h.mask ?? '255.255.255.0',
    router: h.gateway,
    dns: h.dnsServers,
    leaseSec: c.leaseSec,
  };
  ctx.cancelTimer('dhcp:renewRetry');
  send(ctx, node, h, 'request', { requestedIp: h.ip });
  ctx.log({
    kind: 'info',
    proto: 'DHCP',
    status: 'info',
    msg: { key: 'dhcp.reboot', params: { ip: h.ip } },
  });
  ctx.setTimer('dhcp:retry', RETRY_US);
  return true;
}

export function dhcpStop(ctx: DeviceCtx, node: IpNode, h: HostConfig, release = true): void {
  const c = h.dhcpClient;
  for (const t of ['dhcp:retry', 'dhcp:probe', 'dhcp:renew', 'dhcp:expire']) ctx.cancelTimer(t);
  if (release && c.state === 'bound' && h.ip && c.server) {
    send(ctx, node, h, 'release', {}, { ciaddr: h.ip, unicastTo: c.server });
  }
  c.enabled = false;
  c.state = 'off';
  c.offered = undefined;
}

export function clientRx(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  base: Base,
  m: DhcpPdu,
): boolean {
  const c = h.dhcpClient;
  const port = hostPort(node.dev);
  if (!c.enabled || m.xid !== c.xid || m.chaddr !== port?.mac) return false;
  const log = (
    key: string,
    status: 'ok' | 'drop' | 'info' = 'ok',
    params: Record<string, string | number> = {},
  ): void => ctx.log({ ...base, kind: 'rx', proto: 'DHCP', status, msg: { key, params } });
  if (m.op === 'offer' && c.state === 'selecting') {
    c.offered = {
      ip: m.yiaddr,
      mask: m.options.mask ?? '255.255.255.0',
      router: m.options.router,
      dns: m.options.dns,
      leaseSec: m.options.leaseSec ?? 86400,
    };
    c.server = m.options.serverId ?? m.siaddr;
    c.state = 'requesting';
    log('dhcp.gotOffer', 'ok', { ip: m.yiaddr, server: c.server });
    send(ctx, node, h, 'request', { requestedIp: m.yiaddr, serverId: c.server });
    ctx.setTimer('dhcp:retry', RETRY_US);
  } else if (m.op === 'ack' && c.state === 'rebooting' && c.offered) {
    ctx.cancelTimer('dhcp:retry');
    c.boundAt = ctx.now;
    c.leaseSec = m.options.leaseSec ?? c.leaseSec;
    c.state = 'bound';
    log('dhcp.renewed', 'ok', { ip: m.yiaddr });
    armLease(ctx, c.leaseSec);
  } else if (m.op === 'ack' && (c.state === 'requesting' || c.state === 'renewing') && c.offered) {
    if (c.state === 'renewing') {
      c.boundAt = ctx.now;
      c.leaseSec = m.options.leaseSec ?? c.leaseSec;
      c.state = 'bound';
      log('dhcp.renewed', 'ok', { ip: m.yiaddr });
      armLease(ctx, c.leaseSec);
      return true;
    }
    // Konflikterkennung: ARP-Probe für die angebotene Adresse
    c.state = 'probing';
    c.leaseSec = m.options.leaseSec ?? c.offered.leaseSec;
    log('dhcp.gotAck', 'ok', { ip: m.yiaddr });
    ctx.cancelTimer('dhcp:retry');
    const iface = pseudoIface(node);
    if (iface) {
      const probe = {
        kind: 'arp' as const,
        op: 'request' as const,
        senderMac: iface.mac,
        senderIp: '0.0.0.0',
        targetMac: '00:00:00:00:00:00',
        targetIp: c.offered.ip,
      };
      node.xmit(ctx, iface, eth(iface.mac, 'ff:ff:ff:ff:ff:ff', probe));
    }
    ctx.setTimer('dhcp:probe', PROBE_US);
  } else if (m.op === 'nak') {
    log('dhcp.gotNak', 'drop');
    node.cfg.arpCache = {};
    dhcpStart(ctx, node, h);
  } else return false;
  return true;
}

function armLease(ctx: DeviceCtx, leaseSec: number): void {
  ctx.setTimer('dhcp:renew', (leaseSec * 1_000_000) / 2);
  ctx.setTimer('dhcp:expire', leaseSec * 1_000_000);
}

/** ARP-Antwort während der Probe-Phase ⇒ Adresse ist bereits vergeben. */
export function dhcpProbeReply(ctx: DeviceCtx, node: IpNode, h: HostConfig, ip: Ipv4Addr): boolean {
  const c = h.dhcpClient;
  if (c.state !== 'probing' || c.offered?.ip !== ip) return false;
  ctx.cancelTimer('dhcp:probe');
  ctx.log({
    kind: 'error',
    proto: 'DHCP',
    status: 'error',
    msg: { key: 'dhcp.clientConflict', params: { ip } },
  });
  send(ctx, node, h, 'decline', { requestedIp: ip, serverId: c.server });
  c.state = 'init';
  ctx.setTimer('dhcp:retry', 10_000_000);
  return true;
}

export function dhcpTimer(ctx: DeviceCtx, node: IpNode, h: HostConfig, name: string): boolean {
  const c = h.dhcpClient;
  if (!name.startsWith('dhcp:')) return false;
  if (!c.enabled) return true;
  switch (name) {
    case 'dhcp:retry':
      if (c.state === 'rebooting') node.cfg.arpCache = {};
      if (
        c.state === 'rebooting' ||
        c.state === 'requesting' ||
        c.state === 'selecting' ||
        c.state === 'init'
      )
        dhcpStart(ctx, node, h);
      break;
    case 'dhcp:probe':
      if (c.state === 'probing' && c.offered) {
        h.ip = c.offered.ip;
        h.mask = c.offered.mask;
        h.gateway = c.offered.router;
        h.dnsServers = c.offered.dns ?? [];
        c.state = 'bound';
        c.boundAt = ctx.now;
        ctx.log({
          kind: 'info',
          proto: 'DHCP',
          status: 'ok',
          msg: { key: 'dhcp.bound', params: { ip: h.ip } },
        });
        armLease(ctx, c.leaseSec);
      }
      break;
    case 'dhcp:renew':
      if (c.state === 'bound' && c.server && h.ip) {
        c.state = 'renewing';
        send(
          ctx,
          node,
          h,
          'request',
          { requestedIp: h.ip, serverId: c.server },
          { ciaddr: h.ip, unicastTo: c.server },
        );
        ctx.setTimer('dhcp:renewRetry', 5_000_000);
      }
      break;
    case 'dhcp:expire':
      ctx.log({ kind: 'error', proto: 'DHCP', status: 'error', msg: { key: 'dhcp.expired' } });
      dhcpStart(ctx, node, h);
      break;
  }
  return true;
}
