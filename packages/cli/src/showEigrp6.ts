import type { Device, EigrpCfg, Engine } from '@netsim/engine';
import { ifDisplay, ifShort } from './ifnames';

type D = Device;
const procs = (d: D): EigrpCfg[] =>
  d.config.kind === 'router' || d.config.kind === 'switch'
    ? Object.values(d.config.routing.eigrp6 ?? {})
    : [];
const up6 = (a: string): string => a.toUpperCase();
const p2 = (n: number): string => String(n).padStart(2, '0');
const clock = (us: number): string => {
  const s = Math.max(0, Math.floor(us / 1e6));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
};

export function neighbors(e: Engine, d: D): string[] {
  const out: string[] = [];
  for (const c of procs(d)) {
    out.push(`EIGRP-IPv6 Neighbors for AS(${c.asn})`);
    out.push('H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq');
    out.push('                                                   (sec)         (ms)       Cnt Num');
    Object.values(c.neighbors).forEach((n, i) => {
      const hold = Math.max(0, Math.round(n.holdSec - (e.state.now - n.lastHeard) / 1e6));
      out.push(
        `${String(i).padEnd(4)}${'Link-local address:'.padEnd(24)}${ifShort(d, n.ifaceId).padEnd(23)}${String(hold).padStart(3)} ${clock(e.state.now - n.uptime)}${'1'.padStart(5)}${'200'.padStart(6)}${String(n.queue.length).padStart(3)}${String(n.seqIn).padStart(5)}`,
        `    ${up6(n.ip)}`,
      );
    });
    out.push('');
  }
  return out;
}

export function topology(_e: Engine, d: D): string[] {
  const out: string[] = [];
  for (const c of procs(d)) {
    out.push(
      `EIGRP-IPv6 Topology Table for AS(${c.asn})/ID(${c.rid ?? c.routerId ?? '0.0.0.0'})`,
      '',
    );
    out.push(
      'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
      '       r - reply Status, s - sia Status',
      '',
    );
    const topo = Object.values(c.topology).sort(
      (a, b) => a.prefix.localeCompare(b.prefix) || a.plen - b.plen,
    );
    for (const t of topo) {
      const succ = t.paths.filter((p) => p.via === t.succ);
      out.push(
        `${t.active ? 'A' : 'P'} ${up6(t.prefix)}/${t.plen}, ${succ.length} successors, FD is ${t.fd === Number.MAX_SAFE_INTEGER ? 'Infinity' : t.fd}`,
      );
      for (const p of t.paths) {
        const where =
          p.via === 'local'
            ? `Connected, ${ifDisplay(d, p.ifaceId)}`
            : `${up6(p.via)} (${p.dist}/${p.rd}), ${ifDisplay(d, p.ifaceId)}`;
        out.push(`        via ${where}`);
      }
    }
    out.push('');
  }
  return out;
}

export function interfaces(_e: Engine, d: D): string[] {
  const out: string[] = [];
  for (const c of procs(d)) {
    out.push(`EIGRP-IPv6 Interfaces for AS(${c.asn})`);
    out.push(
      '                              Xmit Queue   Mean   Pacing Time   Multicast    Pending',
    );
    out.push('Interface              Peers  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes');
    for (const id of c.helloIfs) {
      const peers = Object.values(c.neighbors).filter((n) => n.ifaceId === id).length;
      out.push(
        `${ifShort(d, id).padEnd(23)}${String(peers).padEnd(7)}0/0${'1'.padStart(13)}${'0/1'.padStart(10)}${'50'.padStart(14)}${'0'.padStart(10)}`,
      );
    }
    out.push('');
  }
  return out;
}

/** Abschnitt für `show ipv6 protocols`. */
export function protocols(d: D): string[] {
  const out: string[] = [];
  for (const c of procs(d)) {
    out.push(
      `IPv6 Routing Protocol is "eigrp ${c.asn}"`,
      `  EIGRP-IPv6 Protocol for AS(${c.asn})`,
      '    Metric weight K1=1, K2=0, K3=1, K4=0, K5=0',
      `    NSF-aware route hold timer is 240`,
      `    Router-ID: ${c.rid ?? c.routerId ?? '0.0.0.0'}`,
      `    Topology : 0 (base)`,
      `      Active Timer: 3 min`,
      `      Distance: internal 90 external 170`,
      `      Maximum path: ${c.maxPaths ?? 4}`,
      `      Maximum hopcount 100`,
      `      Maximum metric variance ${c.variance}`,
      '  Interfaces:',
    );
    for (const id of c.helloIfs) out.push(`    ${ifDisplay(d, id)}`);
    out.push(
      '  Redistribution:',
      c.redistribute.length ? `    ${c.redistribute.map((x) => x.source).join(', ')}` : '    None',
      '',
    );
  }
  return out;
}
