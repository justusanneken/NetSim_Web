import { isValidIpv4 } from '@netsim/protocols';
import type { AclEntry, AddrMatch, PortMatch } from '@netsim/engine';

const PORTS: Record<string, number> = {
  ftp: 21,
  'ftp-data': 20,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  bootps: 67,
  bootpc: 68,
  tftp: 69,
  www: 80,
  pop3: 110,
  ntp: 123,
  snmp: 161,
  https: 443,
  syslog: 514,
};

export class AclParseError extends Error {}

const portNum = (t: string | undefined): number => {
  if (t === undefined) throw new AclParseError('% Incomplete command.');
  const n = /^\d+$/.test(t) ? Number(t) : PORTS[t];
  if (n === undefined || n > 65535) throw new AclParseError(`% Unknown port "${t}"`);
  return n;
};

/** Parst `any`, `host A`, `A W` (oder bei Standard-ACL nur `A`). */
function addr(t: string[], standard: boolean): AddrMatch {
  const first = t.shift();
  if (first === 'any') return { any: true };
  if (first === 'host') {
    const ip = t.shift();
    if (!ip || !isValidIpv4(ip)) throw new AclParseError('% Invalid host address');
    return { ip, wildcard: '0.0.0.0' };
  }
  if (!first || !isValidIpv4(first)) throw new AclParseError('% Invalid address');
  if (t[0] && isValidIpv4(t[0])) return { ip: first, wildcard: t.shift() as string };
  if (standard) return { ip: first, wildcard: '0.0.0.0' };
  throw new AclParseError('% Incomplete command.');
}

function portMatch(t: string[]): PortMatch | undefined {
  const op = t[0];
  if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt') {
    t.shift();
    return { op, a: portNum(t.shift()) };
  }
  if (op === 'range') {
    t.shift();
    const a = portNum(t.shift());
    return { op: 'range', a, b: portNum(t.shift()) };
  }
  return undefined;
}

/**
 * Parst `[seq] permit|deny …` (Standard: Quelle; Extended: Protokoll Quelle [Port] Ziel [Port]
 * [established] [log]). Wirft `AclParseError` bei ungültiger Eingabe.
 */
export function parseAclEntry(
  type: 'standard' | 'extended',
  text: string,
): Omit<AclEntry, 'seq'> & { seq?: number } {
  const t = text.trim().split(/\s+/);
  let seq: number | undefined;
  if (/^\d+$/.test(t[0] ?? '')) seq = Number(t.shift());
  const action = t.shift();
  if (action !== 'permit' && action !== 'deny') throw new AclParseError('% Invalid input detected');
  if (type === 'standard') {
    const src = addr(t, true);
    const log = t[0] === 'log';
    return { seq, action, proto: 'ip', src, log, matches: 0 };
  }
  const proto = t.shift();
  if (proto !== 'ip' && proto !== 'icmp' && proto !== 'tcp' && proto !== 'udp') {
    throw new AclParseError('% Invalid protocol');
  }
  const src = addr(t, false);
  const srcPort = proto === 'tcp' || proto === 'udp' ? portMatch(t) : undefined;
  const dst = addr(t, false);
  const dstPort = proto === 'tcp' || proto === 'udp' ? portMatch(t) : undefined;
  let established = false;
  let log = false;
  while (t.length) {
    const w = t.shift();
    if (w === 'established' && proto === 'tcp') established = true;
    else if (w === 'log') log = true;
    else if (proto === 'icmp')
      continue; // ICMP-Typnamen werden ignoriert
    else throw new AclParseError('% Invalid input detected');
  }
  return { seq, action, proto, src, dst, srcPort, dstPort, established, log, matches: 0 };
}

/** Fügt einen Eintrag ein (Sequenznummer vergeben bzw. sortiert einfügen). */
export function addEntry(entries: AclEntry[], e: Omit<AclEntry, 'seq'> & { seq?: number }): void {
  const seq = e.seq ?? (entries.length ? (entries[entries.length - 1] as AclEntry).seq + 10 : 10);
  entries.push({ ...e, seq });
  entries.sort((a, b) => a.seq - b.seq);
}
