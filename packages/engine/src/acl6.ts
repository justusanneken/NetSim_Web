import { ipv6Network, type Ipv6Pdu } from '@netsim/protocols';
import type { Acl6, Acl6Entry, Acl6Match } from './types';

function matchAddr6(m: Acl6Match, ip: string): boolean {
  if ('any' in m) return true;
  return ipv6Network(ip, m.plen) === ipv6Network(m.prefix, m.plen);
}

function portOk(m: Acl6Entry['srcPort'], port: number): boolean {
  if (!m) return true;
  switch (m.op) {
    case 'eq':
      return port === m.a;
    case 'neq':
      return port !== m.a;
    case 'lt':
      return port < m.a;
    case 'gt':
      return port > m.a;
    case 'range':
      return port >= m.a && port <= (m.b ?? m.a);
  }
}

/**
 * Wertet eine IPv6-ACL aus. Wie in IOS gibt es vor dem impliziten `deny ipv6 any any` zwei
 * implizite Einträge, die Neighbor Discovery erlauben (`permit icmp any any nd-ns/nd-na`).
 * Ohne Treffer: `deny` (entry = undefined).
 */
export function acl6Eval(
  acl: Acl6 | undefined,
  pkt: Ipv6Pdu,
): { action: 'permit' | 'deny'; entry?: Acl6Entry } {
  if (!acl) return { action: 'permit' };
  const p = pkt.payload;
  for (const e of acl.entries) {
    if (!matchAddr6(e.src, pkt.src) || !matchAddr6(e.dst, pkt.dst)) continue;
    if (e.proto !== 'ipv6') {
      const kind = p.kind === 'icmp6' ? 'icmp' : p.kind;
      if (kind !== e.proto) continue;
    }
    if (p.kind === 'tcp' || p.kind === 'udp') {
      if (!portOk(e.srcPort, p.srcPort) || !portOk(e.dstPort, p.dstPort)) continue;
      if (e.established && p.kind === 'tcp' && !(p.flags.ack || p.flags.rst)) continue;
    } else if (e.srcPort || e.dstPort) continue;
    e.matches++;
    return { action: e.action, entry: e };
  }
  if (p.kind === 'icmp6' && (p.type === 'ns' || p.type === 'na')) return { action: 'permit' };
  return { action: 'deny' };
}
