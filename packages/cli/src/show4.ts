import { ipv6Network } from '@netsim/protocols';
import type {
  BgpPath,
  Device,
  Engine,
  EigrpCfg,
  HsrpCfg,
  Iface6,
  OspfCfg,
  OspfIfState,
  OspfNbr,
} from '@netsim/engine';
import { listIfaces6, newHsrp, virtualLl6, vmac6Of, vmacOf } from '@netsim/engine';
import { ciscoMac } from './format';
import { ifDisplay, ifShort } from './ifnames';

type D = Device;
const l3 = (d: D) =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;

const p2 = (n: number): string => String(n).padStart(2, '0');
const clock = (us: number): string => {
  const s = Math.max(0, Math.floor(us / 1e6));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
};
const up6 = (s: string): string => s.toUpperCase();
const hex8 = (n: number): string => '0x' + (n >>> 0).toString(16).padStart(8, '0');
/** Deterministische „Prüfsumme“ für die Datenbankanzeige. */
const fakeSum = (s: string): string => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return '0x' + h.toString(16).padStart(4, '0').toUpperCase();
};
const wcOf = (plen: number): string => {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  const w = ~m >>> 0;
  return [w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255].join('.');
};
void wcOf;

// ---------------------------------------------------------------- show ip protocols

export function showIpProtocols(e: Engine, d: D): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const now = e.state.now;
  const out: string[] = [];
  const r = cfg.routing;
  if (r.rip) {
    const c = r.rip;
    out.push('Routing Protocol is "rip"');
    out.push('  Outgoing update filter list for all interfaces is not set');
    out.push('  Incoming update filter list for all interfaces is not set');
    out.push(
      `  Sending updates every ${c.timers.update} seconds`,
      `  Invalid after ${c.timers.invalid} seconds, hold down ${c.timers.holddown}, flushed after ${c.timers.flush}`,
    );
    out.push(
      `  Redistributing: rip${c.redistribute.map((x) => `, ${x.source}${x.id ? ' ' + x.id : ''}`).join('')}`,
    );
    out.push('  Default version control: send version 2, receive version 2');
    out.push(
      `  Automatic network summarization is ${c.autoSummary ? 'in effect' : 'not in effect'}`,
    );
    out.push(`  Maximum path: ${c.maxPaths ?? 4}`, '  Routing for Networks:');
    for (const n of c.networks) out.push(`    ${n}`);
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    const gws = new Map<string, number>();
    for (const x of Object.values(c.routes))
      if (x.origin === 'rip' && x.nextHop)
        gws.set(x.nextHop, Math.max(gws.get(x.nextHop) ?? 0, x.updatedAt ?? 0));
    for (const [g, t] of gws)
      out.push(`    ${g.padEnd(16)}${'120'.padStart(8)}      ${clock(now - t)}`);
    out.push('  Distance: (default is 120)', '');
  }
  for (const c of Object.values(r.ospf)) out.push(...ospfProto(e, d, c, now));
  for (const c of Object.values(r.eigrp)) out.push(...eigrpProto(e, d, c, now));
  if (r.bgp) {
    const c = r.bgp;
    out.push(`Routing Protocol is "bgp ${c.asn}"`);
    out.push('  Outgoing update filter list for all interfaces is not set');
    out.push('  Incoming update filter list for all interfaces is not set');
    out.push('  IGP synchronization is disabled', '  Automatic route summarization is disabled');
    out.push(
      '  Neighbor(s):',
      '    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap',
    );
    for (const n of Object.values(c.neighbors)) out.push(`    ${n.ip}`);
    out.push(
      `  Maximum path: ${c.maxPaths ?? 1}`,
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
    );
    for (const n of Object.values(c.neighbors))
      if (n.state === 'established')
        out.push(
          `    ${n.ip.padEnd(16)}${String(n.asn === c.asn ? 200 : 20).padStart(8)}      ${clock(now - n.lastRx)}`,
        );
    out.push('  Distance: external 20 internal 200 local 200', '');
  }
  return out.length ? out : ['*** IP Routing is NSF aware ***', ''];
}

function ospfProto(e: Engine, d: D, c: OspfCfg, now: number): string[] {
  const out = [`Routing Protocol is "ospf ${c.pid}"`];
  out.push('  Outgoing update filter list for all interfaces is not set');
  out.push('  Incoming update filter list for all interfaces is not set');
  out.push(`  Router ID ${c.rid ?? c.routerId ?? '0.0.0.0'}`);
  const areas = [...new Set(Object.values(c.ifs).map((i) => i.area))];
  const kinds = areas.map((a) => c.areas?.[a]?.type ?? 'normal');
  out.push(
    `  Number of areas in this router is ${areas.length}. ${kinds.filter((k) => k === 'normal').length} normal ${kinds.filter((k) => k === 'stub').length} stub ${kinds.filter((k) => k === 'nssa').length} nssa`,
  );
  if (c.redistribute.length) out.push(`  It is an autonomous system boundary router`);
  out.push(`  Maximum path: ${c.maxPaths ?? 4}`, '  Routing for Networks:');
  for (const n of c.networks) out.push(`    ${n.prefix} ${n.wildcard} area ${n.area}`);
  out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
  const seen = new Set<string>();
  for (const ifs of Object.values(c.ifs))
    for (const n of Object.values(ifs.neighbors))
      if (!seen.has(n.rid)) {
        seen.add(n.rid);
        out.push(`    ${n.rid.padEnd(16)}${'110'.padStart(8)}      ${clock(now - n.lastHeard)}`);
      }
  out.push('  Distance: (default is 110)', '');
  void e;
  void d;
  return out;
}

function eigrpProto(e: Engine, d: D, c: EigrpCfg, now: number): string[] {
  const out = [`Routing Protocol is "eigrp ${c.asn}"`];
  out.push('  Outgoing update filter list for all interfaces is not set');
  out.push('  Incoming update filter list for all interfaces is not set');
  out.push(
    '  Default networks flagged in outgoing updates',
    '  Default networks accepted from incoming updates',
  );
  out.push(
    `  EIGRP-IPv4 Protocol for AS(${c.asn})`,
    '    Metric weight K1=1, K2=0, K3=1, K4=0, K5=0',
  );
  out.push(
    `    Automatic network summarization is ${c.autoSummary ? 'in effect' : 'not in effect'}`,
  );
  out.push(
    `    Maximum path: ${c.maxPaths ?? 4}`,
    `    Maximum metric variance ${c.variance}`,
    '    Routing for Networks:',
  );
  for (const n of c.networks)
    out.push(`      ${n.prefix}${isClassfulWc(n.prefix, n.wildcard) ? '' : ' ' + n.wildcard}`);
  out.push('    Routing Information Sources:', '      Gateway         Distance      Last Update');
  for (const n of Object.values(c.neighbors))
    out.push(`      ${n.ip.padEnd(16)}${'90'.padStart(8)}      ${clock(now - n.lastHeard)}`);
  out.push('    Distance: internal 90 external 170', '');
  void e;
  void d;
  return out;
}

const isClassfulWc = (net: string, wc: string): boolean => {
  const f = Number(net.split('.')[0]);
  return wc === (f < 128 ? '0.255.255.255' : f < 192 ? '0.0.255.255' : '0.0.0.255');
};

// ---------------------------------------------------------------- RIP

export function showRipDatabase(e: Engine, d: D): string[] {
  const c = l3(d)?.routing.rip;
  if (!c) return [];
  const out: string[] = [];
  const now = e.state.now;
  const rows = Object.values(c.routes).sort((a, b) =>
    a.prefix.localeCompare(b.prefix, undefined, { numeric: true }),
  );
  for (const r of rows) {
    const ifn = r.ifaceId ? ifDisplay(d, r.ifaceId) : '';
    if (r.origin === 'rip') {
      out.push(`${r.prefix}/${r.plen}`);
      out.push(
        `    [${r.metric}] via ${r.nextHop}, ${clock(now - (r.updatedAt ?? now))}${r.metric >= 16 ? ' (down)' : ''}, ${ifn}`,
      );
    } else if (r.origin === 'default') out.push(`${r.prefix}/${r.plen}    redistributed`);
    else if (r.origin === 'redistributed') out.push(`${r.prefix}/${r.plen}    redistributed`);
    else out.push(`${r.prefix}/${r.plen}    directly connected, ${ifn}`);
  }
  return out;
}

// ---------------------------------------------------------------- OSPF

const nbrRole = (ifs: OspfIfState, n: OspfNbr): string =>
  ifs.state === 'p2p' ? '-' : n.rid === ifs.dr ? 'DR' : n.rid === ifs.bdr ? 'BDR' : 'DROTHER';

export function showOspf(e: Engine, d: D, pid?: number): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  for (const c of Object.values(cfg.routing.ospf)) {
    if (pid !== undefined && c.pid !== pid) continue;
    out.push(` Routing Process "ospf ${c.pid}" with ID ${c.rid ?? c.routerId ?? '0.0.0.0'}`);
    out.push(' Supports only single TOS(TOS0) routes', ' Supports opaque LSA');
    if (c.redistribute.length) out.push(' It is an autonomous system boundary router');
    const areas = [...new Set(Object.values(c.ifs).map((i) => i.area))].sort();
    if (areas.length > 1) out.push(' It is an area border router');
    out.push(` Reference bandwidth unit is ${c.refBwMbps} mbps`);
    const kinds = areas.map((a) => c.areas?.[a]?.type ?? 'normal');
    out.push(
      ` Number of areas in this router is ${areas.length}. ${kinds.filter((k) => k === 'normal').length} normal ${kinds.filter((k) => k === 'stub').length} stub ${kinds.filter((k) => k === 'nssa').length} nssa`,
    );
    for (const a of areas) {
      const ac = c.areas?.[a];
      out.push(`    Area ${a === '0' ? 'BACKBONE(0)' : a}`);
      out.push(
        `        Number of interfaces in this area is ${Object.values(c.ifs).filter((i) => i.area === a).length}`,
      );
      if (ac?.type === 'stub')
        out.push(`        It is a stub area${ac.noSummary ? ', no summary LSA in this area' : ''}`);
      if (ac?.type === 'nssa')
        out.push(`        It is a NSSA area${ac.noSummary ? ', no summary LSA in this area' : ''}`);
      out.push(
        ac?.auth === 'md5'
          ? '        Area has message digest authentication'
          : ac?.auth === 'simple'
            ? '        Area has simple password authentication'
            : '        Area has no authentication',
      );
      out.push(`        SPF algorithm last executed ${clock(e.state.now - c.lastSpf)}.000 ago`);
      out.push(`        SPF algorithm executed ${c.spfRuns} times`);
      out.push(`        Number of LSA ${Object.keys(c.lsdb[a] ?? {}).length}`);
    }
    out.push('');
  }
  return out;
}

export function showOspfNeighbors(e: Engine, d: D, v6: boolean): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out = ['Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  const procs = Object.values(v6 ? cfg.routing.ospf6 : cfg.routing.ospf);
  for (const c of procs) {
    for (const [id, ifs] of Object.entries(c.ifs)) {
      for (const n of Object.values(ifs.neighbors)) {
        const dead = (ifs.neighbors[n.rid] ? 40 : 0) * 1e6 - (e.state.now - n.lastHeard);
        const st =
          n.state === 'full' ? 'FULL' : n.state === '2way' ? '2WAY' : n.state.toUpperCase();
        out.push(
          `${n.rid.padEnd(16)}${String(n.priority).padStart(3)}   ${(st + '/' + nbrRole(ifs, n)).padEnd(16)}${clock(dead).padEnd(12)}${(v6 ? up6(n.ip) : n.ip).padEnd(16)}${ifDisplay(d, id)}`,
        );
      }
    }
  }
  return out;
}

export function showOspfInterfaces(e: Engine, d: D, v6: boolean, brief?: boolean): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  const procs = Object.values(v6 ? cfg.routing.ospf6 : cfg.routing.ospf);
  if (brief) out.push('Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C');
  for (const c of procs) {
    for (const [id, ifs] of Object.entries(c.ifs)) {
      const ic = cfg.ifaces[id];
      if (!ic) continue;
      const nb = Object.values(ifs.neighbors);
      const full = nb.filter((n) => n.state === 'full').length;
      const ip = v6
        ? ''
        : `${ic.ip ?? ''}/${ic.mask ? ic.mask.split('.').reduce((a, o) => a + Number(o).toString(2).replace(/0/g, '').length, 0) : ''}`;
      const cost = ic.ospf?.cost ?? ic.v6?.ospf?.cost ?? 1;
      const state =
        ifs.state === 'loopback' ? 'LOOP' : ifs.state === 'p2p' ? 'P2P' : ifs.state.toUpperCase();
      if (brief) {
        out.push(
          `${ifShort(d, id).padEnd(13)}${String(c.pid).padEnd(6)}${ifs.area.padEnd(16)}${ip.padEnd(19)}${String(cost).padEnd(6)}${state.padEnd(6)}${full}/${nb.length}`,
        );
        continue;
      }
      out.push(`${ifDisplay(d, id)} is up, line protocol is up`);
      out.push(`  ${v6 ? 'Link Local Address' : 'Internet Address'} ${ip}, Area ${ifs.area}`);
      out.push(
        `  Process ID ${c.pid}, Router ID ${c.rid ?? c.routerId ?? '0.0.0.0'}, Network Type ${ifs.state === 'p2p' ? 'POINT_TO_POINT' : ifs.state === 'loopback' ? 'LOOPBACK' : 'BROADCAST'}, Cost: ${cost}`,
      );
      out.push(`  Transmit Delay is 1 sec, State ${state}, Priority ${ic.ospf?.priority ?? 1}`);
      if (ifs.state !== 'p2p' && ifs.state !== 'loopback') {
        out.push(`  Designated Router (ID) ${ifs.dr}, Interface address ${ifs.drAddr}`);
        out.push(`  Backup Designated router (ID) ${ifs.bdr}, Interface address ${ifs.bdrAddr}`);
      }
      out.push(
        `  Timer intervals configured, Hello ${ic.ospf?.helloSec ?? ic.v6?.ospf?.helloSec ?? 10}, Dead ${ic.ospf?.deadSec ?? ic.v6?.ospf?.deadSec ?? 40}, Wait 40, Retransmit 5`,
      );
      out.push(`  Neighbor Count is ${nb.length}, Adjacent neighbor count is ${full}`, '');
    }
  }
  void e;
  return out;
}

const LSA_TITLE: Record<number, string> = {
  1: 'Router Link States',
  2: 'Net Link States',
  3: 'Summary Net Link States',
  4: 'Summary ASB Link States',
  5: 'Type-5 AS External Link States',
};

export function showOspfDatabase(e: Engine, d: D, kind?: string, v6 = false): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const want: Record<string, number> = {
    router: 1,
    network: 2,
    summary: 3,
    'asbr-summary': 4,
    external: 5,
  };
  const out: string[] = [];
  for (const c of Object.values(v6 ? cfg.routing.ospf6 : cfg.routing.ospf)) {
    out.push(
      `            OSPF Router with ID (${c.rid ?? c.routerId ?? '0.0.0.0'}) (Process ID ${c.pid})`,
      '',
    );
    const areas = [...Object.keys(c.lsdb)].filter((a) => a !== 'as').sort();
    for (const type of [1, 2, 3, 4, 5]) {
      if (kind && want[kind] !== type) continue;
      const groups =
        type === 5
          ? [['as', c.lsdb['as'] ?? {}] as const]
          : areas.map((a) => [a, c.lsdb[a] ?? {}] as const);
      for (const [area, db] of groups) {
        const rows = Object.entries(db).filter(([, l]) => l.type === type);
        if (rows.length === 0) continue;
        out.push(`                ${LSA_TITLE[type]}${type === 5 ? '' : ` (Area ${area})`}`, '');
        out.push(
          type === 1
            ? 'Link ID         ADV Router      Age         Seq#       Checksum Link count'
            : type === 5
              ? 'Link ID         ADV Router      Age         Seq#       Checksum Tag'
              : 'Link ID         ADV Router      Age         Seq#       Checksum',
        );
        for (const [k, l] of rows) {
          const age = Math.min(
            3600,
            l.age + Math.floor((e.state.now - (c.installed[`${area}|${k}`] ?? e.state.now)) / 1e6),
          );
          const extra =
            l.body.type === 1
              ? String(l.body.links.length)
              : l.body.type === 5
                ? String(l.body.tag)
                : '';
          out.push(
            `${l.id.padEnd(16)}${l.advRouter.padEnd(16)}${String(age).padEnd(12)}${hex8(l.seq).padEnd(11)}${fakeSum(k).padEnd(9)}${extra}`,
          );
        }
        out.push('');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- EIGRP

export function showEigrpNeighbors(e: Engine, d: D): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  for (const c of Object.values(cfg.routing.eigrp)) {
    out.push(`EIGRP-IPv4 Neighbors for AS(${c.asn})`);
    out.push('H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq');
    out.push('                                                   (sec)         (ms)       Cnt Num');
    Object.values(c.neighbors).forEach((n, i) => {
      const hold = Math.max(0, Math.round(n.holdSec - (e.state.now - n.lastHeard) / 1e6));
      out.push(
        `${String(i).padEnd(4)}${n.ip.padEnd(24)}${ifShort(d, n.ifaceId).padEnd(23)}${String(hold).padStart(3)} ${clock(e.state.now - n.uptime)}${'1'.padStart(5)}${'200'.padStart(6)}${String(n.queue.length).padStart(3)}${String(n.seqIn).padStart(5)}`,
      );
    });
    out.push('');
  }
  return out;
}

export function showEigrpTopology(e: Engine, d: D): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  for (const c of Object.values(cfg.routing.eigrp)) {
    out.push(
      `EIGRP-IPv4 Topology Table for AS(${c.asn})/ID(${c.rid ?? c.routerId ?? '0.0.0.0'})`,
      '',
    );
    out.push(
      'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
      '       r - reply Status, s - sia Status',
      '',
    );
    const topo = Object.values(c.topology).sort((a, b) =>
      a.prefix.localeCompare(b.prefix, undefined, { numeric: true }),
    );
    for (const t of topo) {
      const succ = t.paths.filter((p) => p.via === t.succ);
      out.push(
        `${t.active ? 'A' : 'P'} ${t.prefix}/${t.plen}, ${succ.length} successors, FD is ${t.fd === Number.MAX_SAFE_INTEGER ? 'Infinity' : t.fd}`,
      );
      for (const p of t.paths) {
        const where =
          p.via === 'local'
            ? `Connected, ${ifDisplay(d, p.ifaceId)}`
            : `${p.via} (${p.dist}/${p.rd}), ${ifDisplay(d, p.ifaceId)}`;
        out.push(`        via ${where}`);
      }
    }
    out.push('');
  }
  void e;
  return out;
}

export function showEigrpInterfaces(e: Engine, d: D): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  for (const c of Object.values(cfg.routing.eigrp)) {
    out.push(`EIGRP-IPv4 Interfaces for AS(${c.asn})`);
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
  void e;
  return out;
}

// ---------------------------------------------------------------- HSRP

export function showStandby(e: Engine, d: D, brief: boolean): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  if (brief) {
    out.push('                     P indicates configured to preempt.', '                     |');
    out.push('Interface   Grp  Pri P State   Active          Standby         Virtual IP');
  }
  for (const [id, ic] of Object.entries(cfg.ifaces)) {
    const ver = ic.hsrpVersion ?? 1;
    for (const g of [
      ...Object.values(ic.hsrp ?? {}),
      ...Object.values(ic.hsrp6 ?? {}).map((x) => ({ ...x, v6: true })),
    ]) {
      const pri = effective(cfg, g);
      const vip = g.v6 && g.autoconfig ? virtualLl6(g.group) : g.vip;
      const mac = ciscoMac(g.v6 ? vmac6Of(g.group) : vmacOf(g.group, ver));
      const active = g.state === 'active' ? 'local' : (g.activeIp ?? 'unknown');
      const standby = g.state === 'standby' ? 'local' : (g.standbyIp ?? 'unknown');
      if (brief) {
        out.push(
          `${ifShort(d, id).padEnd(12)}${String(g.group).padEnd(5)}${String(pri).padEnd(4)}${g.preempt ? 'P' : ' '} ${cap(g.state).padEnd(8)}${active.padEnd(16)}${standby.padEnd(16)}${vip ?? 'unknown'}`,
        );
        continue;
      }
      out.push(`${ifDisplay(d, id)} - Group ${g.group}${g.v6 ? ' (IPv6)' : ''}`);
      if (ver === 2 || g.v6) out.push('  (HSRP version 2)');
      out.push(
        `  State is ${cap(g.state)}`,
        `    last state change ${clock(e.state.now - g.stateSince)}`,
      );
      out.push(`  Virtual ${g.v6 ? 'IPv6' : 'IP'} address is ${vip ?? 'unknown'}`);
      out.push(`  Active virtual MAC address is ${mac}`);
      out.push(
        `    Local virtual MAC address is ${mac} (${g.v6 ? 'v2 IPv6 default' : ver === 2 ? 'v2 default' : 'v1 default'})`,
      );
      if (g.authKey !== undefined) out.push(`  Authentication text "${g.authKey}"`);
      out.push(`  Hello time ${g.helloSec} sec, hold time ${g.holdSec} sec`);
      out.push(`  Preemption ${g.preempt ? 'enabled' : 'disabled'}`);
      out.push(
        `  Active router is ${active}${g.state !== 'active' && g.activeIp ? `, priority ${g.activePriority}` : ''}`,
      );
      out.push(
        `  Standby router is ${standby}${g.state !== 'standby' && g.standbyIp ? `, priority ${g.standbyPriority}` : ''}`,
      );
      out.push(`  Priority ${pri} (configured ${g.priority})`);
      for (const t of g.track)
        out.push(
          `    Track interface ${ifDisplay(d, t.ifaceId)} state ${cfg.ifaces[t.ifaceId] ? 'Up' : 'Down'} decrement ${t.decrement}`,
        );
      out.push(
        `  Group name is "${g.name ?? `hsrp-${ifShort(d, id)}-${g.group}`}" (${g.name ? 'cfgd' : 'default'})`,
      );
    }
  }
  void newHsrp;
  return out;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function effective(cfg: NonNullable<ReturnType<typeof l3>>, g: HsrpCfg): number {
  let p = g.priority;
  for (const t of g.track) {
    const ic = cfg.ifaces[t.ifaceId];
    if (!ic || ic.shutdown === true) p -= t.decrement;
  }
  return Math.max(0, p);
}

// ---------------------------------------------------------------- BGP

const pathText = (p: BgpPath): string =>
  `${p.attrs.asPath.join(' ')}${p.attrs.asPath.length ? ' ' : ''}${p.attrs.origin === 'igp' ? 'i' : p.attrs.origin === 'egp' ? 'e' : '?'}`;

export function showBgp(e: Engine, d: D): string[] {
  const c = l3(d)?.routing.bgp;
  if (!c) return [];
  const out = [
    `BGP table version is ${Object.keys(c.locRib).length}, local router ID is ${c.rid ?? c.routerId ?? '0.0.0.0'}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,',
    '              r RIB-failure, S Stale',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    '',
    '   Network          Next Hop            Metric LocPrf Weight Path',
  ];
  const all = new Map<string, BgpPath[]>();
  for (const [k, p] of Object.entries(c.locRib)) all.set(k, [p]);
  for (const n of Object.values(c.neighbors))
    for (const [k, p] of Object.entries(n.ribIn)) {
      const list = all.get(k) ?? [];
      if (!list.some((x) => x.from === p.from)) list.push(p);
      all.set(k, list);
    }
  const keys = [...all.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const k of keys) {
    const best = c.locRib[k];
    for (const p of all.get(k) ?? []) {
      const isBest = best !== undefined && best.from === p.from;
      const net = p === all.get(k)?.[0] ? k : '';
      const lp = p.attrs.localPref !== undefined ? String(p.attrs.localPref) : '';
      out.push(
        `${isBest ? '*>' : '* '}${p.ebgp || p.local ? ' ' : 'i'}${net.padEnd(17)}${p.attrs.nextHop.padEnd(20)}${String(p.attrs.med ?? 0).padStart(6)} ${lp.padStart(6)} ${String(p.weight).padStart(6)} ${pathText(p)}`,
      );
    }
  }
  void e;
  return out;
}

export function showBgpSummary(e: Engine, d: D): string[] {
  const c = l3(d)?.routing.bgp;
  if (!c) return ['% BGP not active'];
  const n = Object.keys(c.locRib).length;
  const out = [
    `BGP router identifier ${c.rid ?? c.routerId ?? '0.0.0.0'}, local AS number ${c.asn}`,
    `BGP table version is ${n}, main routing table version ${n}`,
    `${n} network entries using ${n * 208} bytes of memory`,
    '',
    'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
  ];
  for (const nb of Object.values(c.neighbors)) {
    out.push(
      `${nb.ip.padEnd(16)}4${String(nb.asn).padStart(12)}${'0'.padStart(8)}${'0'.padStart(8)}${String(n).padStart(9)}${'0'.padStart(5)}${'0'.padStart(5)} ${(nb.established !== undefined ? clock(e.state.now - nb.established) : 'never').padEnd(9)} ${nb.state === 'established' ? String(nb.prefixesRx) : cap(nb.state)}`,
    );
  }
  return out;
}

export function showBgpNeighbors(e: Engine, d: D): string[] {
  const c = l3(d)?.routing.bgp;
  if (!c) return [];
  const out: string[] = [];
  for (const n of Object.values(c.neighbors)) {
    out.push(
      `BGP neighbor is ${n.ip},  remote AS ${n.asn}, ${n.asn === c.asn ? 'internal' : 'external'} link`,
    );
    if (n.description) out.push(`  Description: ${n.description}`);
    out.push(`  BGP version 4, remote router ID ${n.routerId ?? '0.0.0.0'}`);
    out.push(
      `  BGP state = ${cap(n.state)}${n.established !== undefined ? `, up for ${clock(e.state.now - n.established)}` : ''}`,
    );
    out.push(
      `  Last read ${clock(e.state.now - n.lastRx)}, last write ${clock(e.state.now - n.lastTx)}, hold time is ${n.holdSec}, keepalive interval is 60 seconds`,
    );
    if (n.updateSource) out.push(`  Update source is ${ifDisplay(d, n.updateSource)}`);
    if (n.ebgpMultihop)
      out.push(`  External BGP neighbor may be up to ${n.ebgpMultihop} hops away.`);
    if (n.nextHopSelf) out.push('  NEXT_HOP is always this router');
    out.push(`  Prefixes received: ${n.prefixesRx}`, '');
  }
  return out;
}

// ---------------------------------------------------------------- IPv6

function ifaces6(d: D): Iface6[] {
  const cfg = l3(d);
  return cfg ? listIfaces6(d, cfg) : [];
}

export function showIpv6Route(e: Engine, d: D): string[] {
  const rib = e.routingTable6(d.id);
  const out = [
    `IPv6 Routing Table - default - ${rib.length} entries`,
    'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route',
    '       B - BGP, R - RIP, I1 - ISIS L1, I2 - ISIS L2',
    '       IA - ISIS interarea, IS - ISIS summary, D - EIGRP, EX - EIGRP external',
    '       O - OSPF Intra, OI - OSPF Inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
    '       ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2',
  ];
  const sorted = [...rib].sort((a, b) => a.prefix.localeCompare(b.prefix) || a.plen - b.plen);
  for (const r of sorted) {
    const code =
      r.type === 'O'
        ? r.sub === 'IA'
          ? 'OI'
          : r.sub === 'E1'
            ? 'OE1'
            : r.sub === 'E2'
              ? 'OE2'
              : 'O'
        : r.type;
    out.push(`${code.padEnd(4)}${up6(r.prefix)}/${r.plen} [${r.ad}/${r.metric}]`);
    const ifn = r.ifaceId ? ifDisplay(d, r.ifaceId) : '';
    out.push(
      r.nextHop ? `     via ${up6(r.nextHop)}, ${ifn}` : `     via ${ifn}, directly connected`,
    );
  }
  // Local-Routen (wie IOS) ergänzen
  for (const i of ifaces6(d))
    for (const a of i.addrs)
      out.push(`L   ${up6(a.addr)}/128 [0/0]`, `     via ${ifDisplay(d, i.id)}, receive`);
  return out;
}

export function showIpv6Interface(e: Engine, d: D, brief: boolean): string[] {
  const out: string[] = [];
  for (const i of ifaces6(d)) {
    const name = ifDisplay(d, i.id);
    if (brief) {
      out.push(`${name.padEnd(23)}[up/up]`, `    ${up6(i.ll)}`);
      for (const a of i.addrs) out.push(`    ${up6(a.addr)}`);
      continue;
    }
    out.push(
      `${name} is up, line protocol is up`,
      `  IPv6 is enabled, link-local address is ${up6(i.ll)}`,
    );
    out.push('  No Virtual link-local address(es):');
    if (i.addrs.length) out.push('  Global unicast address(es):');
    for (const a of i.addrs)
      out.push(`    ${up6(a.addr)}, subnet is ${up6(ipv6Network(a.addr, a.plen))}/${a.plen}`);
    out.push(
      '  Joined group address(es):',
      '    FF02::1',
      ...(l3(d)?.ipv6Routing ? ['    FF02::2'] : []),
    );
    out.push(
      `  MTU is ${i.mtu} bytes`,
      '  ND DAD is not supported',
      '  ND reachable time is 30000 milliseconds',
    );
    out.push('');
  }
  void e;
  return out;
}

export function showIpv6Neighbors(e: Engine, d: D): string[] {
  const out = ['IPv6 Address                              Age Link-layer Addr State Interface'];
  for (const n of e.ndTable(d.id)) {
    out.push(
      `${up6(n.ip).padEnd(42)}${'0'.padStart(3)} ${ciscoMac(n.mac)}  REACH ${ifShort(d, d.ports[0]?.id ?? 'p0')}`,
    );
  }
  return out;
}

export function showIpv6Protocols(e: Engine, d: D): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const out: string[] = [];
  for (const c of Object.values(cfg.routing.ospf6)) {
    out.push(`IPv6 Routing Protocol is "ospf ${c.pid}"`);
    out.push(`  Router ID ${c.rid ?? c.routerId ?? '0.0.0.0'}`);
    const areas = [...new Set(Object.values(c.ifs).map((i) => i.area))];
    out.push(`  Number of areas: ${areas.length} normal, 0 stub, 0 nssa`);
    out.push('  Interfaces (Area 0):');
    for (const id of Object.keys(c.ifs)) out.push(`    ${ifDisplay(d, id)}`);
    out.push('  Redistribution:', '    None', '');
  }
  if (!out.length) out.push('IPv6 Routing Protocol is "connected"', '');
  void e;
  return out;
}

export function showDebugging(d: D): string[] {
  const cfg = l3(d);
  const tags = cfg?.routing.debug ?? [];
  if (tags.length === 0) return [];
  const names: Record<string, string> = {
    rip: 'RIP protocol debugging is on',
    'ospf.events': 'OSPF events debugging is on',
    'ospf.adj': 'OSPF adjacency events debugging is on',
    'ospf.hello': 'OSPF hello events debugging is on',
    'ospf.packet': 'OSPF packet debugging is on',
    'ospf.spf': 'OSPF spf debugging is on',
    'ospf.lsa': 'OSPF lsa generation debugging is on',
    'eigrp.packet': 'EIGRP Packets debugging is on',
    'eigrp.fsm': 'EIGRP FSM Events/Actions debugging is on',
    'eigrp.neighbor': 'EIGRP Neighbors debugging is on',
    hsrp: 'HSRP debugging is on',
    bgp: 'BGP debugging is on',
    routing: 'IP routing debugging is on',
    gre: 'Tunnel debugging is on',
  };
  return ['', ...tags.map((t) => names[t] ?? `${t} debugging is on`)];
}

export function showOspfVirtualLinks(e: Engine, d: D): string[] {
  const cfg = l3(d);
  const out: string[] = [];
  if (!cfg) return out;
  for (const c of Object.values(cfg.routing.ospf)) {
    for (const v of c.vlinks ?? []) {
      const ifs = c.ifs[`vl-${v.rid.replaceAll('.', '_')}`];
      const n = ifs ? Object.values(ifs.neighbors)[0] : undefined;
      out.push(
        `Virtual Link OSPF_VL0 to router ${v.rid} is ${n?.state === 'full' ? 'up' : 'down'}`,
        `  Run as demand circuit`,
        `  DoNotAge LSA allowed.`,
        `  Transit area ${v.area}, cost of using ${v.cost ?? 'unknown'}`,
        `  Adjacency State ${n ? n.state.toUpperCase() : 'DOWN'}`,
      );
    }
  }
  void e;
  return out;
}

export function showBgp6(e: Engine, d: D): string[] {
  const c = l3(d)?.routing.bgp;
  if (!c) return [];
  const out = [
    `BGP table version is ${Object.keys(c.locRib6 ?? {}).length}, local router ID is ${c.rid ?? c.routerId ?? '0.0.0.0'}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,',
    '              r RIB-failure, S Stale',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    '',
    '   Network          Next Hop                  Metric LocPrf Weight Path',
  ];
  for (const [k, p] of Object.entries(c.locRib6 ?? {})) {
    const lp = p.attrs.localPref !== undefined ? String(p.attrs.localPref) : '';
    out.push(
      `*>${p.ebgp || p.local ? ' ' : 'i'}${k.toUpperCase()}`,
      `${' '.repeat(20)}${(p.attrs.nextHop6 ?? '::').toUpperCase().padEnd(26)}${String(p.attrs.med ?? 0).padStart(6)} ${lp.padStart(6)} ${String(p.weight).padStart(6)} ${pathText(p)}`,
    );
  }
  void e;
  return out;
}

export function showBgpDetail(d: D, net: string): string[] {
  const c = l3(d)?.routing.bgp;
  if (!c) return [];
  const hits = Object.entries(c.locRib).filter(([k]) => k.split('/')[0] === net);
  if (hits.length === 0) return ['% Network not in table'];
  const out: string[] = [];
  for (const [k, best] of hits) {
    out.push(`BGP routing table entry for ${k}`);
    const all = [
      best,
      ...Object.values(c.neighbors)
        .map((n) => n.ribIn[k])
        .filter((x): x is BgpPath => !!x && x.from !== best.from),
    ];
    out.push(`Paths: (${all.length} available, best #1)`);
    for (const p of all) {
      out.push(`  ${p.attrs.asPath.join(' ') || 'Local'}`);
      out.push(
        `    ${p.attrs.nextHop} from ${p.local ? '0.0.0.0 (' + (c.rid ?? c.routerId ?? '0.0.0.0') + ')' : p.from + ' (' + p.fromRid + ')'}`,
      );
      const bits = [
        `Origin ${p.attrs.origin === 'igp' ? 'IGP' : p.attrs.origin === 'egp' ? 'EGP' : 'incomplete'}`,
        `metric ${p.attrs.med ?? 0}`,
        `localpref ${p.attrs.localPref ?? c.defaultLocalPref}`,
        `weight ${p.weight}`,
        p.ebgp || p.local ? 'external' : 'internal',
        ...(p === best ? ['best'] : []),
      ];
      out.push(`      ${bits.join(', ')}`);
      if (p.attrs.communities?.length)
        out.push(`      Community: ${p.attrs.communities.join(' ')}`);
      if (p.attrs.originatorId)
        out.push(
          `      Originator: ${p.attrs.originatorId}, Cluster list: ${(p.attrs.clusterList ?? []).join(', ')}`,
        );
    }
  }
  return out;
}
