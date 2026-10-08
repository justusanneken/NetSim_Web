import {
  formatIpv6,
  isLinkLocalIpv6,
  normalizeIpv6,
  parseIpv6,
  type Dhcp6Pdu,
  type Ipv6Addr,
  type Ipv6Pdu,
  type Mac,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Base } from '../l3';
import { ip6SendVia, newIp6, sendMcast6, type Ip6Host, type Iface6 } from '../l3v6';
import type { Dhcp6Pool, L3Cfg } from '../types';

/** DHCPv6 (vereinfacht: Solicit/Advertise/Request/Reply und Information-Request/Reply, IA_NA, DNS, Domain). */

export const ALL_DHCP_AGENTS = 'ff02::1:2';
const CLIENT_PORT = 546;
const SERVER_PORT = 547;
const RETRY_US = 2_000_000;
const MAX_TRIES = 4;

export const newDhcp6Pool = (name: string): Dhcp6Pool => ({
  name,
  dns: [],
  leaseSec: 86400,
});

const isRouterCfg = (cfg: Ip6Host['cfg']): cfg is L3Cfg => 'ifaces' in cfg;

// ------------------------------------------------------------------ Server

function addrAt(prefix: Ipv6Addr, index: number): Ipv6Addr {
  const w = parseIpv6(prefix) ?? [0, 0, 0, 0, 0, 0, 0, 0];
  // Hostanteil in den untersten 16 Bit (Präfixlängen ≤ 112)
  return formatIpv6([...w.slice(0, 7), index & 0xffff]);
}

function allocate(cfg: L3Cfg, pool: Dhcp6Pool, client: Mac, now: number): Ipv6Addr | undefined {
  if (!pool.prefix) return undefined;
  const bindings = (cfg.dhcp6 ??= { pools: [], bindings: {} }).bindings;
  const cur = bindings[client];
  if (cur && cur.pool === pool.name && cur.expiresAt > now) return cur.addr;
  const taken = new Set(Object.values(bindings).map((b) => b.addr));
  for (let i = 0x100; i < 0x100 + 4096; i++) {
    const a = addrAt(pool.prefix.prefix, i);
    if (!taken.has(a)) return a;
  }
  return undefined;
}

export function dhcp6ServerRx(
  ctx: DeviceCtx,
  n: Ip6Host,
  iface: Iface6,
  base: Base,
  pkt: Ipv6Pdu,
  m: Dhcp6Pdu,
): boolean {
  if (!isRouterCfg(n.cfg)) return false;
  const cfg = n.cfg;
  const poolName = iface.cfg.v6?.dhcp6Server;
  const pool = cfg.dhcp6?.pools.find((p) => p.name === poolName);
  if (!pool) return false;
  if (m.op !== 'solicit' && m.op !== 'request' && m.op !== 'information-request') return true;
  if (m.op === 'request' && m.serverId && m.serverId !== iface.mac) return true;
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'dhcp6.rx', params: { op: m.op, client: m.clientId } },
  });
  const reply: Dhcp6Pdu = {
    kind: 'dhcp6',
    op: m.op === 'solicit' ? 'advertise' : 'reply',
    xid: m.xid,
    clientId: m.clientId,
    serverId: iface.mac,
    dns: pool.dns,
    domain: pool.domain,
    leaseSec: pool.leaseSec,
  };
  if (m.op !== 'information-request') {
    const addr = allocate(cfg, pool, m.clientId, ctx.now);
    if (!addr || !pool.prefix) return true;
    reply.addr = addr;
    reply.plen = pool.prefix.plen;
    if (m.op === 'request') {
      (cfg.dhcp6 ??= { pools: [], bindings: {} }).bindings[m.clientId] = {
        addr,
        pool: pool.name,
        expiresAt: ctx.now + pool.leaseSec * 1_000_000,
      };
      ctx.log({
        kind: 'info',
        proto: 'DHCP',
        status: 'ok',
        msg: { key: 'dhcp6.bind', params: { addr, client: m.clientId } },
      });
    }
  }
  // Antwort unicast an die Link-Local-Adresse des Clients (MAC bekannt aus dem Frame)
  if (isLinkLocalIpv6(pkt.src)) {
    const key = normalizeIpv6(pkt.src) ?? pkt.src;
    n.cfg.nd[key] = { mac: base.frame.src, expiresAt: ctx.now + 300_000_000 };
    ip6SendVia(
      ctx,
      n,
      { nextHop: pkt.src, iface },
      newIp6(
        n.v6,
        iface.ll,
        pkt.src,
        { kind: 'udp', srcPort: SERVER_PORT, dstPort: CLIENT_PORT, dataSize: 0, app: reply },
        255,
      ),
    );
  }
  return true;
}

// ------------------------------------------------------------------ Client

/** Startet DHCPv6 gemäß RA-Flags: M ⇒ zustandsbehaftet, nur O ⇒ zustandslos. */
export function dhcp6ClientStart(
  ctx: DeviceCtx,
  n: Ip6Host,
  managed: boolean,
  other: boolean,
): void {
  const host = n.host;
  if (!host?.v6.dhcp6 || (!managed && !other)) return;
  const cur = host.v6.dh6;
  const mode = managed ? 'stateful' : 'stateless';
  if (cur && (cur.state === 'bound' || cur.state === 'wait') && cur.mode === mode) return;
  host.v6.dh6 = { state: 'wait', mode, xid: 1 + ctx.rand(0xffffff), tries: 0 };
  ctx.setTimer('dhcp6', 100_000 + ctx.rand(400_000));
}

function sendMsg(ctx: DeviceCtx, n: Ip6Host, op: Dhcp6Pdu['op']): void {
  const host = n.host;
  const iface = n.v6.ifaces[0];
  const d = host?.v6.dh6;
  if (!host || !iface || !d) return;
  const m: Dhcp6Pdu = {
    kind: 'dhcp6',
    op,
    xid: d.xid,
    clientId: iface.mac,
    serverId: op === 'request' ? d.server : undefined,
  };
  sendMcast6(ctx, n, iface, ALL_DHCP_AGENTS, {
    kind: 'udp',
    srcPort: CLIENT_PORT,
    dstPort: SERVER_PORT,
    dataSize: 0,
    app: m,
  });
}

export function dhcp6Timer(ctx: DeviceCtx, n: Ip6Host, name: string): boolean {
  if (name !== 'dhcp6') return false;
  const d = n.host?.v6.dh6;
  if (!d || d.state === 'bound') return true;
  if (d.tries >= MAX_TRIES) {
    d.state = 'idle';
    ctx.log({
      kind: 'error',
      proto: 'DHCP',
      status: 'error',
      msg: { key: 'dhcp6.noServer' },
    });
    return true;
  }
  d.tries++;
  if (d.mode === 'stateless') {
    d.state = 'info';
    sendMsg(ctx, n, 'information-request');
  } else if (d.state === 'requesting') sendMsg(ctx, n, 'request');
  else {
    d.state = 'soliciting';
    sendMsg(ctx, n, 'solicit');
  }
  ctx.setTimer('dhcp6', RETRY_US);
  return true;
}

export function dhcp6ClientRx(ctx: DeviceCtx, n: Ip6Host, iface: Iface6, m: Dhcp6Pdu): void {
  const host = n.host;
  const d = host?.v6.dh6;
  if (!host || !d || m.xid !== d.xid || m.clientId !== iface.mac) return;
  if (m.op === 'advertise' && d.state === 'soliciting') {
    d.state = 'requesting';
    d.server = m.serverId;
    d.tries = 0;
    sendMsg(ctx, n, 'request');
    ctx.setTimer('dhcp6', RETRY_US);
    return;
  }
  if (m.op !== 'reply' || (d.state !== 'requesting' && d.state !== 'info')) return;
  ctx.cancelTimer('dhcp6');
  d.state = 'bound';
  if (m.dns) host.v6.dns6 = [...m.dns];
  host.v6.domain6 = m.domain;
  if (m.addr) {
    host.v6.dhcpAddrs = [{ addr: normalizeIpv6(m.addr) ?? m.addr, plen: m.plen ?? 64 }];
    ctx.log({
      kind: 'info',
      proto: 'DHCP',
      status: 'ok',
      msg: { key: 'dhcp6.bound', params: { addr: m.addr } },
    });
    ctx.setTimer('dadscan', 1);
  } else {
    ctx.log({
      kind: 'info',
      proto: 'DHCP',
      status: 'ok',
      msg: { key: 'dhcp6.info', params: { dns: (m.dns ?? []).join(', ') } },
    });
  }
  ctx.requestRefresh();
}
