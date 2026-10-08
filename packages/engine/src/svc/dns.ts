import type { DnsPdu, DnsRecord, DnsType, Ipv4Addr, Ipv4Pdu, UdpPdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import { sendUdp, type Base, type IpNode } from '../l3';
import type { HostConfig } from '../types';
import { onDnsDone } from './tcp';

const DNS_TIMEOUT_US = 3_000_000;

function answer(records: DnsRecord[], name: string, type: DnsType, depth = 0): DnsRecord[] {
  const lc = name.toLowerCase();
  const out = records.filter((r) => r.name.toLowerCase() === lc && r.type === type);
  if (out.length > 0 || depth > 4) return out;
  const cname = records.find((r) => r.name.toLowerCase() === lc && r.type === 'CNAME');
  return cname ? [cname, ...answer(records, cname.data, type, depth + 1)] : [];
}

/** DNS-Server (Host-Dienst) und Client-Antworten; `true` = verbraucht. */
export function dnsRx(
  ctx: DeviceCtx,
  node: IpNode,
  iface: Iface,
  base: Base,
  ip: Ipv4Pdu,
  udp: UdpPdu,
  q: DnsPdu,
): boolean {
  const h = node.host;
  if (!h) return false;
  if (!q.response && udp.dstPort === 53 && h.services.dns.enabled) {
    const ans = answer(h.services.dns.records, q.question.name, q.question.type);
    ctx.log({
      ...base,
      kind: 'rx',
      proto: 'DNS',
      status: 'ok',
      msg: {
        key: ans.length ? 'dns.answer' : 'dns.nxdomain',
        params: { name: q.question.name, count: ans.length },
      },
    });
    const rep: DnsPdu = { ...q, response: true, rcode: ans.length ? 0 : 3, answers: ans };
    sendUdp(ctx, node, { src: iface.ip, dst: ip.src, sport: 53, dport: udp.srcPort, app: rep });
    return true;
  }
  if (q.response && h.dnsPending[q.id]) {
    const pend = h.dnsPending[q.id] as { name: string; reqId?: number };
    delete h.dnsPending[q.id];
    ctx.cancelTimer(`dns-timeout:${q.id}`);
    const a = q.answers.find((r) => r.type === 'A');
    ctx.log({
      ...base,
      kind: 'rx',
      proto: 'DNS',
      status: q.rcode === 0 ? 'ok' : 'drop',
      msg: {
        key: q.rcode === 0 ? 'dns.resolved' : 'dns.failed',
        params: { name: pend.name, ip: a?.data ?? '' },
      },
    });
    if (a)
      h.dnsCache[pend.name.toLowerCase()] = { ip: a.data, expiresAt: ctx.now + a.ttl * 1_000_000 };
    h.dnsResults[q.id] = { name: pend.name, rcode: q.rcode, answers: q.answers, done: true };
    onDnsDone(ctx, node, h, pend.reqId, a?.data, q.rcode === 0 ? undefined : 'http.err.dns');
    return true;
  }
  return false;
}

/** Namensauflösung starten (Cache → Server). Liefert die Anfrage-ID oder die gecachte Adresse. */
export function dnsResolve(
  ctx: DeviceCtx,
  node: IpNode,
  h: HostConfig,
  name: string,
  reqId?: number,
): { id?: number; cached?: Ipv4Addr; error?: string } {
  const c = h.dnsCache[name.toLowerCase()];
  if (c && c.expiresAt > ctx.now) return { cached: c.ip };
  const server = h.dnsServers[0];
  if (!server) return { error: 'http.err.noDns' };
  const id = h.nextDnsId++;
  h.dnsPending[id] = { name, reqId, started: ctx.now };
  h.dnsResults[id] = { name, rcode: -1, answers: [], done: false };
  const q: DnsPdu = {
    kind: 'dns',
    id,
    response: false,
    rcode: 0,
    question: { name, type: 'A' },
    answers: [],
  };
  const sport = h.nextPort++;
  const r = sendUdp(ctx, node, { dst: server, sport, dport: 53, app: q });
  if (!r.ok) {
    delete h.dnsPending[id];
    h.dnsResults[id] = { name, rcode: -1, answers: [], done: true, error: 'http.err.unreachable' };
    return { id, error: 'http.err.unreachable' };
  }
  ctx.setTimer(`dns-timeout:${id}`, DNS_TIMEOUT_US);
  return { id };
}

export function dnsTimer(ctx: DeviceCtx, node: IpNode, h: HostConfig, name: string): boolean {
  if (!name.startsWith('dns-timeout:')) return false;
  const id = Number(name.slice(12));
  const pend = h.dnsPending[id];
  if (!pend) return true;
  delete h.dnsPending[id];
  h.dnsResults[id] = {
    name: pend.name,
    rcode: -1,
    answers: [],
    done: true,
    error: 'http.err.dnsTimeout',
  };
  ctx.log({
    kind: 'error',
    proto: 'DNS',
    status: 'error',
    msg: { key: 'dns.timeout', params: { name: pend.name } },
  });
  onDnsDone(ctx, node, h, pend.reqId, undefined, 'http.err.dnsTimeout');
  return true;
}
