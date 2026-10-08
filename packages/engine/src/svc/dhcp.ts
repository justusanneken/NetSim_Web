import {
  formatIpv4,
  maskToPrefix,
  parseIpv4,
  sameSubnet,
  type DhcpOp,
  type DhcpPdu,
  type Frame,
  type Ipv4Addr,
  type Ipv4Pdu,
  type UdpPdu,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { clientRx } from './dhcpclient';
import type { Iface } from '../ifaces';
import { newIpPacket, sendBroadcast, sendUdp, type Base, type IpNode } from '../l3';
import type { DhcpPool, DhcpServerCfg } from '../types';

const OFFER_HOLD_US = 10_000_000;

const serverOf = (node: IpNode): DhcpServerCfg | undefined => {
  if (node.l3) return node.l3.dhcp.pools.length ? node.l3.dhcp : undefined;
  const d = node.host?.services.dhcp;
  return d?.enabled ? d : undefined;
};

function num(ip: Ipv4Addr): number {
  return parseIpv4(ip) ?? 0;
}

function poolFor(srv: DhcpServerCfg, ref: Ipv4Addr): DhcpPool | undefined {
  return srv.pools.find((p) => sameSubnet(p.network, ref, p.mask));
}

function purge(srv: DhcpServerCfg, now: number): void {
  for (const [ip, b] of Object.entries(srv.bindings)) {
    if (b.expiresAt <= now) delete srv.bindings[ip];
  }
}

function excluded(srv: DhcpServerCfg, ip: Ipv4Addr): boolean {
  const n = num(ip);
  return srv.excluded.some((e) => n >= num(e.from) && n <= num(e.to));
}

function allocate(srv: DhcpServerCfg, pool: DhcpPool, mac: string, now: number): Ipv4Addr | undefined {
  purge(srv, now);
  const have = Object.entries(srv.bindings).find(([, b]) => b.mac === mac && b.poolName === pool.name);
  if (have) return have[0];
  const plen = maskToPrefix(pool.mask) ?? 24;
  const net = num(pool.network) & (plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0);
  const bcast = (net | (~(plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0) >>> 0)) >>> 0;
  const from = pool.rangeStart ? num(pool.rangeStart) : net + 1;
  const to = pool.rangeEnd ? num(pool.rangeEnd) : bcast - 1;
  for (let n = from; n <= to; n++) {
    const ip = formatIpv4(n >>> 0);
    if (excluded(srv, ip) || srv.bindings[ip] || srv.conflicts.includes(ip) || ip === pool.router) continue;
    return ip;
  }
  return undefined;
}

function reply(
  op: DhcpOp,
  req: DhcpPdu,
  pool: DhcpPool | undefined,
  yiaddr: Ipv4Addr,
  serverId: Ipv4Addr,
): DhcpPdu {
  return {
    kind: 'dhcp',
    op,
    xid: req.xid,
    chaddr: req.chaddr,
    ciaddr: '0.0.0.0',
    yiaddr: op === 'nak' ? '0.0.0.0' : yiaddr,
    siaddr: serverId,
    giaddr: req.giaddr,
    options:
      op === 'nak' || !pool
        ? { serverId }
        : {
            mask: pool.mask,
            router: pool.router,
            dns: pool.dns.length ? pool.dns : undefined,
            domain: pool.domain,
            leaseSec: pool.leaseSec,
            serverId,
            tftp: pool.tftp,
          },
  };
}

/** Antwort an den Client (direkt oder über den Relay-Agent). */
function sendReply(ctx: DeviceCtx, node: IpNode, iface: Iface, req: DhcpPdu, rep: DhcpPdu): void {
  if (req.giaddr !== '0.0.0.0') {
    sendUdp(ctx, node, { dst: req.giaddr, sport: 67, dport: 67, app: rep });
    return;
  }
  const pkt = newIpPacket(node, iface.ip, '255.255.255.255', {
    kind: 'udp',
    srcPort: 67,
    dstPort: 68,
    dataSize: 0,
    app: rep,
  });
  sendBroadcast(ctx, node, iface, pkt);
}

function serve(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  srv: DhcpServerCfg,
  req: DhcpPdu,
): void {
  const ref = req.giaddr !== '0.0.0.0' ? req.giaddr : iface.ip;
  const pool = poolFor(srv, ref);
  const serverId = iface.ip;
  const log = (key: string, params: Record<string, string | number>, status: 'ok' | 'drop' = 'ok'): void =>
    ctx.log({ ...base, kind: status === 'ok' ? 'rx' : 'drop', proto: 'DHCP', status, msg: { key, params } });
  if (!pool) return log('dhcp.noPool', { mac: req.chaddr }, 'drop');
  if (req.op === 'discover') {
    const ip = allocate(srv, pool, req.chaddr, ctx.now);
    if (!ip) return log('dhcp.exhausted', { pool: pool.name }, 'drop');
    srv.bindings[ip] = { mac: req.chaddr, poolName: pool.name, expiresAt: ctx.now + OFFER_HOLD_US, offered: true };
    log('dhcp.offer', { ip, mac: req.chaddr });
    sendReply(ctx, node, iface, req, reply('offer', req, pool, ip, serverId));
  } else if (req.op === 'request') {
    const want = req.options.requestedIp ?? req.ciaddr;
    if (req.options.serverId && req.options.serverId !== serverId) {
      const b = srv.bindings[want];
      if (b?.offered && b.mac === req.chaddr) delete srv.bindings[want];
      return;
    }
    purge(srv, ctx.now);
    const b = srv.bindings[want];
    const free = !b && sameSubnet(pool.network, want, pool.mask) && !excluded(srv, want) && !srv.conflicts.includes(want);
    if ((b && b.mac === req.chaddr) || free) {
      srv.bindings[want] = { mac: req.chaddr, poolName: pool.name, expiresAt: ctx.now + pool.leaseSec * 1_000_000 };
      log('dhcp.ack', { ip: want, mac: req.chaddr });
      sendReply(ctx, node, iface, req, reply('ack', req, pool, want, serverId));
    } else {
      log('dhcp.nak', { ip: want, mac: req.chaddr }, 'drop');
      sendReply(ctx, node, iface, req, reply('nak', req, pool, want, serverId));
    }
  } else if (req.op === 'decline') {
    const ip = req.options.requestedIp ?? '';
    delete srv.bindings[ip];
    if (!srv.conflicts.includes(ip)) srv.conflicts.push(ip);
    log('dhcp.conflict', { ip });
  } else if (req.op === 'release') {
    delete srv.bindings[req.ciaddr];
    log('dhcp.release', { ip: req.ciaddr });
  }
}

/** Relay-Agent: Client-Nachricht (Broadcast) an die Helper-Adressen weiterreichen. */
function relayUp(ctx: DeviceCtx, node: IpNode, iface: Iface, base: Base, req: DhcpPdu): void {
  const out: DhcpPdu = { ...structuredClone(req), giaddr: iface.ip };
  for (const h of iface.cfg.helpers ?? []) {
    ctx.log({
      ...base,
      kind: 'rx',
      proto: 'DHCP',
      status: 'ok',
      msg: { key: 'dhcp.relay', params: { helper: h, op: req.op } },
    });
    sendUdp(ctx, node, { src: iface.ip, dst: h, sport: 67, dport: 67, app: out });
  }
}

/** Relay-Agent: Server-Antwort an den Client im Netz von `giaddr` ausliefern. */
function relayDown(ctx: DeviceCtx, node: IpNode, base: Base, rep: DhcpPdu): boolean {
  const out = node.ifaces.find((i) => i.ip === rep.giaddr);
  if (!out) return false;
  ctx.log({
    ...base,
    kind: 'rx',
    proto: 'DHCP',
    status: 'ok',
    msg: { key: 'dhcp.relayDown', params: { op: rep.op, mac: rep.chaddr } },
  });
  const pkt = newIpPacket(node, out.ip, '255.255.255.255', {
    kind: 'udp',
    srcPort: 67,
    dstPort: 68,
    dataSize: 0,
    app: { ...structuredClone(rep), giaddr: '0.0.0.0' },
  });
  sendBroadcast(ctx, node, out, pkt);
  return true;
}

const CLIENT_OPS: DhcpOp[] = ['discover', 'request', 'decline', 'release'];

/** Verarbeitet DHCP-Nachrichten; `true` = verbraucht. */
export function dhcpRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  udp: UdpPdu,
  app: DhcpPdu,
  frame: Frame,
): boolean {
  void frame;
  const fromClient = CLIENT_OPS.includes(app.op);
  if (fromClient && udp.dstPort === 67) {
    if (node.l3 && iface.cfg.helpers?.length && app.giaddr === '0.0.0.0') {
      relayUp(ctx, node, iface, base, app);
      return true;
    }
    const srv = serverOf(node);
    if (!srv) return false;
    serve(ctx, node, iface, base, srv, app);
    return true;
  }
  if (!fromClient) {
    if (node.l3 && udp.dstPort === 67 && ip.dst !== '255.255.255.255') return relayDown(ctx, node, base, app);
    if (node.host && udp.dstPort === 68) return clientRx(ctx, node, node.host, base, app);
  }
  return false;
}

