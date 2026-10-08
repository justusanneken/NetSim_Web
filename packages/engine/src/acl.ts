import { parseIpv4, type Ipv4Addr, type Ipv4Pdu } from '@netsim/protocols';
import type { Acl, AclEntry, AddrMatch, PortMatch } from './types';

export function matchAddr(m: AddrMatch | undefined, ip: Ipv4Addr): boolean {
  if (!m || 'any' in m) return true;
  const a = parseIpv4(ip);
  const b = parseIpv4(m.ip);
  const w = parseIpv4(m.wildcard);
  if (a === undefined || b === undefined || w === undefined) return false;
  return ((a ^ b) & ~w) >>> 0 === 0;
}

export function matchPort(m: PortMatch | undefined, port: number): boolean {
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

export interface L4Key {
  proto: 'icmp' | 'tcp' | 'udp' | 'ip';
  sport: number;
  dport: number;
  /** TCP: ACK oder RST gesetzt. */
  established: boolean;
}

export function l4Of(ip: Ipv4Pdu): L4Key {
  const p = ip.payload;
  switch (p.kind) {
    case 'icmp':
      return { proto: 'icmp', sport: p.id, dport: p.id, established: false };
    case 'udp':
      return { proto: 'udp', sport: p.srcPort, dport: p.dstPort, established: false };
    case 'tcp':
      return {
        proto: 'tcp',
        sport: p.srcPort,
        dport: p.dstPort,
        established: p.flags.ack || p.flags.rst,
      };
  }
}

function entryMatches(e: AclEntry, acl: Acl, ip: Ipv4Pdu, k: L4Key): boolean {
  if (!matchAddr(e.src, ip.src)) return false;
  if (acl.type === 'standard') return true;
  if (e.proto !== 'ip' && e.proto !== k.proto) return false;
  if (!matchAddr(e.dst, ip.dst)) return false;
  if (ip.fragOffset > 0) return true; // Nicht-Erst-Fragmente tragen keine Ports
  if (!matchPort(e.srcPort, k.sport) || !matchPort(e.dstPort, k.dport)) return false;
  if (e.established && !k.established) return false;
  return true;
}

/** Wertet eine ACL aus (Trefferzähler werden erhöht). Fehlende ACL = permit. */
export function aclEval(
  acl: Acl | undefined,
  ip: Ipv4Pdu,
): { action: 'permit' | 'deny'; entry?: AclEntry } {
  if (!acl) return { action: 'permit' };
  const k = l4Of(ip);
  for (const e of acl.entries) {
    if (entryMatches(e, acl, ip, k)) {
      e.matches++;
      return { action: e.action, entry: e };
    }
  }
  return { action: 'deny' };
}
