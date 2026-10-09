import { parseIpv4, formatIpv4, type Ipv4Addr, type Ipv4Pdu } from '@netsim/protocols';
import { aclEval, l4Of } from './acl';
import type { Iface } from './ifaces';
import type { L3Cfg, NatCfg, NatEntry, NatRule } from './types';

const FOREVER = Number.MAX_SAFE_INTEGER;
/** Idle-Timeout dynamischer Einträge; `ip nat translation timeout` überschreibt die Defaults (außer ICMP). */
const timeoutUs = (nat: NatCfg, proto: 'icmp' | 'udp' | 'tcp' | 'ip'): number =>
  nat.timeoutSec !== undefined && proto !== 'icmp'
    ? nat.timeoutSec * 1_000_000
    : DEFAULT_TIMEOUT_US[proto];

const DEFAULT_TIMEOUT_US = {
  icmp: 60_000_000,
  udp: 300_000_000,
  tcp: 86_400_000_000,
  ip: 300_000_000,
};

/** Firewall-Regel (mit Schnittstellenpaar)? Router-NAT-Regeln tragen kein Paar. */
const paired = (r: NatRule): boolean => r.fromIf !== undefined && r.toIf !== undefined;

/** Passt die Regel zum Weg `inIf → outIf`? Regeln ohne Paar gelten immer (Router: natSide steuert den Aufruf). */
const ruleFits = (r: NatRule, inIf: string | undefined, outIf: string): boolean =>
  !paired(r) || (r.fromIf === inIf && r.toIf === outIf);

const entryFits = (e: NatEntry, inIf: string | undefined, outIf: string): boolean =>
  e.fromIf === undefined || (e.fromIf === inIf && e.toIf === outIf);

/** Ist die Schnittstelle bei einer Firewall-Regel die gemappte (Outside-)Seite / die reale (Inside-)Seite? */
export const natMappedAt = (l3: L3Cfg, ifaceId: string): boolean =>
  l3.nat.rules.some((r) => r.toIf === ifaceId);
export const natRealAt = (l3: L3Cfg, ifaceId: string): boolean =>
  l3.nat.rules.some((r) => r.fromIf === ifaceId);

export function natPurge(nat: NatCfg, now: number): void {
  if (nat.table.some((e) => e.expiresAt <= now))
    nat.table = nat.table.filter((e) => e.expiresAt > now);
}

function setPorts(ip: Ipv4Pdu, src?: number, dst?: number): Ipv4Pdu {
  const out = structuredClone(ip);
  const p = out.payload;
  if (p.kind === 'icmp') {
    // Echo: die Kennung dient als „Port“.
    if (src !== undefined) p.id = src;
    if (dst !== undefined) p.id = dst;
  } else if (p.kind === 'tcp' || p.kind === 'udp') {
    if (src !== undefined) p.srcPort = src;
    if (dst !== undefined) p.dstPort = dst;
  }
  return out;
}

function poolAddrs(nat: NatCfg, name: string): Ipv4Addr[] {
  const p = nat.pools[name];
  if (!p) return [];
  const a = parseIpv4(p.start);
  const b = parseIpv4(p.end);
  if (a === undefined || b === undefined) return [];
  const out: Ipv4Addr[] = [];
  for (let n = a; n <= b && out.length < 256; n++) out.push(formatIpv4(n));
  return out;
}

const used = (nat: NatCfg, proto: NatEntry['proto'], ip: Ipv4Addr, port: number): boolean =>
  nat.table.some(
    (e) => e.proto === proto && e.insideGlobal.ip === ip && e.insideGlobal.port === port,
  );

function createDynamic(
  l3: L3Cfg,
  rule: Extract<NatRule, { kind: 'dynamic' | 'interface' }>,
  ip: Ipv4Pdu,
  out: Iface,
  now: number,
): NatEntry | 'blocked' | undefined {
  const nat = l3.nat;
  const k = l4Of(ip);
  if (aclEval(l3.acls[rule.acl], ip).action !== 'permit') return undefined;
  let gip: Ipv4Addr | undefined;
  let overload = true;
  if (rule.kind === 'interface') gip = out.ip;
  else {
    overload = rule.overload;
    const addrs = poolAddrs(nat, rule.pool);
    if (overload) gip = addrs[0];
    else gip = addrs.find((a) => !nat.table.some((e) => e.insideGlobal.ip === a));
  }
  if (!gip) return 'blocked';
  let gport = k.sport;
  if (overload || used(nat, k.proto, gip, gport)) {
    do gport = nat.nextPort++;
    while (used(nat, k.proto, gip, gport));
    if (nat.nextPort > 65535) nat.nextPort = 1024;
  }
  return {
    proto: k.proto,
    insideLocal: { ip: ip.src, port: k.sport },
    insideGlobal: { ip: gip, port: gport },
    outside: { ip: ip.dst, port: k.dport },
    kind: 'dynamic',
    expiresAt: now + timeoutUs(nat, k.proto),
    ...(rule.fromIf !== undefined ? { fromIf: rule.fromIf, toIf: rule.toIf } : {}),
  };
}

/** Inside → Outside: Quelladresse (und Port) übersetzen. Liefert das (ggf. veränderte) Paket. */
export function natInside2Outside(
  l3: L3Cfg,
  ip: Ipv4Pdu,
  out: Iface,
  now: number,
  inIf?: string,
): { pkt: Ipv4Pdu; entry?: NatEntry; blocked?: boolean } {
  const nat = l3.nat;
  natPurge(nat, now);
  if (ip.fragOffset > 0) return { pkt: ip };
  const k = l4Of(ip);
  let e = nat.table.find(
    (x) =>
      x.proto === k.proto &&
      x.insideLocal.ip === ip.src &&
      x.insideLocal.port === k.sport &&
      x.outside.ip === ip.dst &&
      (x.proto === 'icmp' || x.outside.port === k.dport) &&
      entryFits(x, inIf, out.id),
  );
  if (!e) {
    for (const r of nat.rules) {
      if (!ruleFits(r, inIf, out.id)) continue;
      if (r.kind === 'static') {
        if (r.local !== ip.src) continue;
        if (r.proto && (r.proto !== k.proto || (r.lport !== undefined && r.lport !== k.sport)))
          continue;
        e = {
          proto: k.proto,
          insideLocal: { ip: ip.src, port: k.sport },
          insideGlobal: { ip: r.global, port: r.gport ?? k.sport },
          outside: { ip: ip.dst, port: k.dport },
          kind: 'static',
          expiresAt: FOREVER,
          ...(r.fromIf !== undefined ? { fromIf: r.fromIf, toIf: r.toIf } : {}),
        };
      } else {
        const c = createDynamic(l3, r, ip, out, now);
        if (c === 'blocked') {
          nat.misses++;
          return { pkt: ip, blocked: true };
        }
        e = c;
      }
      if (e) break;
    }
    if (!e) {
      nat.misses++;
      return { pkt: ip };
    }
    nat.table.push(e);
  } else if (e.kind === 'dynamic') e.expiresAt = now + timeoutUs(nat, e.proto);
  nat.hits++;
  const pkt = setPorts({ ...structuredClone(ip), src: e.insideGlobal.ip }, e.insideGlobal.port);
  return { pkt, entry: e };
}

/** Outside → Inside: Zieladresse (und Port) zurückübersetzen (Antworten bzw. Static NAT). */
export function natOutside2Inside(
  l3: L3Cfg,
  ip: Ipv4Pdu,
  now: number,
  inIf?: string,
): { pkt: Ipv4Pdu; entry?: NatEntry } {
  const nat = l3.nat;
  natPurge(nat, now);
  if (ip.fragOffset > 0) return { pkt: ip };
  const k = l4Of(ip);
  let e = nat.table.find(
    (x) =>
      x.proto === k.proto &&
      x.insideGlobal.ip === ip.dst &&
      x.insideGlobal.port === k.dport &&
      x.outside.ip === ip.src &&
      (x.proto === 'icmp' || x.outside.port === k.sport) &&
      (x.toIf === undefined || x.toIf === inIf),
  );
  if (!e) {
    for (const r of nat.rules) {
      if (r.kind !== 'static' || r.global !== ip.dst) continue;
      if (paired(r) && r.toIf !== inIf) continue;
      if (r.proto && (r.proto !== k.proto || (r.gport !== undefined && r.gport !== k.dport)))
        continue;
      e = {
        proto: k.proto,
        insideLocal: { ip: r.local, port: r.lport ?? k.dport },
        insideGlobal: { ip: r.global, port: k.dport },
        outside: { ip: ip.src, port: k.sport },
        kind: 'static',
        expiresAt: FOREVER,
        ...(r.fromIf !== undefined ? { fromIf: r.fromIf, toIf: r.toIf } : {}),
      };
      nat.table.push(e);
      break;
    }
  } else if (e.kind === 'dynamic') e.expiresAt = now + timeoutUs(nat, e.proto);
  if (!e) return { pkt: ip };
  nat.hits++;
  const pkt = setPorts(
    { ...structuredClone(ip), dst: e.insideLocal.ip },
    undefined,
    e.insideLocal.port,
  );
  return { pkt, entry: e };
}

/** Gibt es eine Rückübersetzung (Tabelle oder Static-Regel) für ein Paket an `ip.dst`? */
export function natHasInbound(l3: L3Cfg, ip: Ipv4Pdu, now: number, inIf?: string): boolean {
  if (ip.fragOffset > 0) return false;
  natPurge(l3.nat, now);
  const k = l4Of(ip);
  return (
    l3.nat.table.some(
      (x) =>
        x.proto === k.proto &&
        x.insideGlobal.ip === ip.dst &&
        x.insideGlobal.port === k.dport &&
        x.outside.ip === ip.src &&
        // wie natOutside2Inside: auch der Gegenport muss passen (sonst würde z. B. die BGP-Antwort an die
        // eigene Verbindung des Routers als NAT-Verkehr weitergeleitet)
        (x.proto === 'icmp' || x.outside.port === k.sport) &&
        (x.toIf === undefined || x.toIf === inIf),
    ) ||
    l3.nat.rules.some(
      (r) =>
        r.kind === 'static' &&
        r.global === ip.dst &&
        (!paired(r) || r.toIf === inIf) &&
        (!r.proto || (r.proto === k.proto && (r.gport === undefined || r.gport === k.dport))),
    )
  );
}
