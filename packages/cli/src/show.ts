import { maskToPrefix, parseIpv4, sameSubnet } from '@netsim/protocols';
import type { Device, Engine, Port, RibEntry, SwitchConfig, SysConfig } from '@netsim/engine';
import { formatClock } from './clock';
import { ifaceUp, listIfaces, networkOf, prefixMask } from '@netsim/engine';
import { ciscoMac, shortName } from './format';
import { compressVlans, ifDisplay, ifShort } from './ifnames';
import { aclEntryText, isCliDevice, renderRunningConfig } from './render';

type D = Device;

const portStatus = (p: Port): { status: string; proto: string } =>
  p.errdisabled
    ? { status: 'err-disabled', proto: 'down' }
    : !p.adminUp
      ? { status: 'administratively down', proto: 'down' }
      : p.operUp
        ? { status: 'up', proto: 'up' }
        : { status: 'down', proto: 'down' };

const sw = (d: D): SwitchConfig | undefined => (d.config.kind === 'switch' ? d.config : undefined);
const l3 = (d: D) =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;

export function ifaceIp(d: D, id: string): { ip: string; mask: string } | undefined {
  const c = l3(d)?.ifaces[id];
  return c?.ip && c.mask ? { ip: c.ip, mask: c.mask } : undefined;
}

const clock = (t: number): string => {
  const s = Math.floor(t / 1e6);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

// ---------------------------------------------------------------- IP

export function showIpInterfaceBrief(_e: Engine, d: D): string[] {
  const cfg = l3(d);
  const out = ['Interface              IP-Address      OK? Method Status                Protocol'];
  const row = (name: string, ip: string | undefined, status: string, proto: string): void => {
    out.push(
      `${name.padEnd(23)}${(ip ?? 'unassigned').padEnd(16)}${'YES'.padEnd(4)}${(ip ? 'manual' : 'unset').padEnd(7)}${status.padEnd(22)}${proto}`,
    );
  };
  for (const p of d.ports) {
    const s = portStatus(p);
    row(p.name, ifaceIp(d, p.id)?.ip, s.status, s.proto);
    for (const [id, c] of Object.entries(cfg?.ifaces ?? {})) {
      if (c.kind !== 'sub' || c.portId !== p.id) continue;
      const up = cfg ? ifaceUp(d, cfg, id, c) : false;
      row(
        ifDisplay(d, id),
        c.ip,
        up ? 'up' : c.shutdown ? 'administratively down' : 'down',
        up ? 'up' : 'down',
      );
    }
  }
  for (const [id, c] of Object.entries(cfg?.ifaces ?? {})) {
    if (c.kind !== 'loop' && c.kind !== 'tunnel') continue;
    const up = cfg ? ifaceUp(d, cfg, id, c) : false;
    row(
      ifDisplay(d, id),
      c.ip,
      up ? 'up' : c.shutdown ? 'administratively down' : 'down',
      up ? 'up' : 'down',
    );
  }
  if (d.config.kind === 'switch') {
    const svis = Object.entries(d.config.ifaces).filter(([, c]) => c.kind === 'svi');
    if (!svis.some(([id]) => id === 'vlan1'))
      row('Vlan1', undefined, 'administratively down', 'down');
    for (const [id, c] of svis) {
      const up = ifaceUp(d, d.config, id, c);
      row(
        ifDisplay(d, id),
        c.ip,
        up ? 'up' : c.shutdown ? 'administratively down' : 'down',
        up ? 'up' : 'down',
      );
    }
  }
  return out;
}

export function showIpInterface(d: D, id: string): string[] {
  const cfg = l3(d);
  const c = cfg?.ifaces[id];
  const name = ifDisplay(d, id);
  const port = d.ports.find((p) => p.id === id);
  const up = port ? port.operUp && port.adminUp : !!cfg && !!c && ifaceUp(d, cfg, id, c);
  const out = [`${name} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'}`];
  if (c?.ip && c.mask) {
    out.push(
      `  Internet address is ${c.ip}/${maskToPrefix(c.mask)}`,
      '  Broadcast address is 255.255.255.255',
    );
  } else out.push('  Internet protocol processing disabled');
  for (const h of c?.helpers ?? []) out.push(`  Helper address is ${h}`);
  out.push(`  MTU is ${port?.mtu ?? 1500} bytes`);
  out.push(`  Outgoing access list is ${c?.aclOut ?? 'not set'}`);
  out.push(`  Inbound  access list is ${c?.aclIn ?? 'not set'}`);
  if (c?.natSide) out.push(`  NAT ${c.natSide}`);
  return out;
}

const CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       + - replicated route, % - next hop override',
];

function classful(ip: string): { net: string; plen: number } {
  const first = (parseIpv4(ip) ?? 0) >>> 24;
  const plen = first < 128 ? 8 : first < 192 ? 16 : 24;
  return { net: networkOf(ip, plen), plen };
}

export function showIpRoute(e: Engine, d: D, target?: string, proto?: string): string[] {
  const allRib = e.routingTable(d.id);
  const codeOf: Record<string, string> = {
    rip: 'R',
    ospf: 'O',
    eigrp: 'D',
    bgp: 'B',
    static: 'S',
    connected: 'C',
  };
  const rib = proto
    ? allRib.filter((r) => r.type === codeOf[proto] || (proto === 'connected' && r.type === 'L'))
    : allRib;
  if (target) return showRouteEntry(e, d, rib, target);
  const def = rib.find((r) => r.plen === 0 && r.type !== 'C' && r.type !== 'L');
  const out = [...CODES, ''];
  out.push(
    def?.nextHop
      ? `Gateway of last resort is ${def.nextHop} to network 0.0.0.0`
      : 'Gateway of last resort is not set',
    '',
  );
  const sorted = [...rib].sort(
    (a, b) => (parseIpv4(a.prefix) ?? 0) - (parseIpv4(b.prefix) ?? 0) || a.plen - b.plen,
  );
  const groups = new Map<string, RibEntry[]>();
  for (const r of sorted) {
    if (r.plen === 0) continue;
    const key = classful(r.prefix).net + '/' + classful(r.prefix).plen;
    (groups.get(key) ?? groups.set(key, []).get(key))?.push(r);
  }
  const where = (r: RibEntry): string => {
    const ifn = r.ifaceId ? ifDisplay(d, r.ifaceId) : '';
    if (r.type === 'C' || r.type === 'L') return `is directly connected, ${ifn}`;
    if (r.nextHop) {
      const age = r.type === 'S' ? '' : `, ${clock(e.state.now - (r.since ?? 0))}, ${ifn}`;
      return `[${r.ad}/${r.metric}] via ${r.nextHop}${age}`;
    }
    return `[${r.ad}/${r.metric}] is directly connected, ${ifn}`;
  };
  /** Eine Zeile je Pfad; weitere gleichwertige Pfade (ECMP) stehen eingerückt darunter. */
  const lines = (list: RibEntry[], width: number): string[] => {
    const r = list[0] as RibEntry;
    const star = r.plen === 0 ? '*' : '';
    const code = (
      r.sub ? (star ? `${r.type}*${r.sub}` : `${r.type} ${r.sub}`) : `${r.type}${star}`
    ).padEnd(width);
    const head = `${code}${r.prefix}/${r.plen} `;
    return list.map((x, i) =>
      i === 0 ? `${head}${where(x)}` : `${' '.repeat(head.length)}${where(x)}`,
    );
  };
  const byPrefix = (entries: RibEntry[]): RibEntry[][] => {
    const m = new Map<string, RibEntry[]>();
    for (const x of entries) {
      const k = `${x.prefix}/${x.plen}`;
      (m.get(k) ?? m.set(k, []).get(k))?.push(x);
    }
    return [...m.values()];
  };
  if (def)
    out.push(
      ...lines(
        rib.filter((x) => x.plen === 0 && x.type !== 'C' && x.type !== 'L'),
        5,
      ),
    );
  for (const [key, entries] of groups) {
    const masks = new Set(entries.map((x) => x.plen));
    const subnets = new Set(entries.map((x) => `${x.prefix}/${x.plen}`)).size;
    if (masks.size > 1) {
      out.push(`      ${key} is variably subnetted, ${subnets} subnets, ${masks.size} masks`);
    } else {
      const only = [...masks][0] as number;
      out.push(`      ${key.split('/')[0]}/${only} is subnetted, ${subnets} subnets`);
    }
    for (const g of byPrefix(entries)) out.push(...lines(g, 9));
  }
  return out;
}

function showRouteEntry(e: Engine, d: D, rib: RibEntry[], target: string): string[] {
  let best: RibEntry | undefined;
  for (const r of rib) {
    if (r.type === 'L' && r.prefix !== target) continue;
    if (!sameSubnet(r.prefix, target, prefixMask(r.plen))) continue;
    if (!best || r.plen > best.plen || (r.plen === best.plen && r.ad < best.ad)) best = r;
  }
  if (!best) return ['% Network not in table'];
  const names: Record<string, string> = {
    C: 'connected',
    L: 'receive',
    S: 'static',
    R: 'rip',
    O: 'ospf',
    D: 'eigrp',
    B: 'bgp',
  };
  const paths = rib.filter(
    (r) =>
      r.type === best.type &&
      r.prefix === best.prefix &&
      r.plen === best.plen &&
      r.ad === best.ad &&
      (r.metric === best.metric || r.share !== undefined),
  );
  const out = [
    `Routing entry for ${best.prefix}/${best.plen}`,
    `  Known via "${names[best.type]}", distance ${best.ad}, metric ${best.metric}${best.type === 'C' ? ' (connected, via interface)' : ''}`,
    '  Routing Descriptor Blocks:',
  ];
  const minShare = Math.min(...paths.map((p) => p.share ?? 1));
  paths.forEach((p, i) => {
    const ifn = p.ifaceId ? ifDisplay(d, p.ifaceId) : '';
    out.push(
      `${i === 0 ? '  * ' : '    '}${p.nextHop ? (p.type === 'S' ? p.nextHop : `${p.nextHop}, from ${p.nextHop}, ${clock(e.state.now - (p.since ?? 0))} ago, via ${ifn}`) : `directly connected, via ${ifn}`}`,
    );
    out.push(
      `      Route metric is ${p.metric}, traffic share count is ${p.share !== undefined ? Math.max(1, Math.round(p.share / minShare)) : 1}`,
    );
  });
  return out;
}

// ---------------------------------------------------------------- ARP / MAC

export function showIpArp(e: Engine, d: D): string[] {
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const cfg = l3(d);
  if (!cfg) return out;
  const rows: { ip: string; age: string; mac: string; port: string }[] = [];
  for (const i of listIfaces(d, cfg)) {
    rows.push({ ip: i.ip, age: '-', mac: ciscoMac(i.mac), port: ifDisplay(d, i.id) });
  }
  for (const [ip, ent] of Object.entries(cfg.arpCache)) {
    if (ent.expiresAt <= e.state.now) continue;
    const learned = ent.expiresAt - 14_400_000_000;
    const i = listIfaces(d, cfg).find((x) => sameSubnet(x.ip, ip, x.mask));
    rows.push({
      ip,
      age: String(Math.max(0, Math.floor((e.state.now - learned) / 60_000_000))),
      mac: ciscoMac(ent.mac),
      port: i ? ifDisplay(d, i.id) : '',
    });
  }
  rows.sort((a, b) => (parseIpv4(a.ip) ?? 0) - (parseIpv4(b.ip) ?? 0));
  for (const r of rows) {
    out.push(
      `Internet  ${r.ip.padEnd(16)} ${r.age.padStart(9)}  ${r.mac.padEnd(14)}  ARPA   ${r.port}`,
    );
  }
  return out;
}

export function showMacTable(e: Engine, d: D): string[] {
  const rows = e.macTable(d.id);
  const out = [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
  ];
  for (const r of rows) {
    const port = r.portId.startsWith('po')
      ? `Po${r.portId.slice(2)}`
      : shortName(d.ports.find((x) => x.id === r.portId)?.name ?? '');
    out.push(
      `${String(r.vlan).padStart(4)}    ${ciscoMac(r.mac).padEnd(15)}   DYNAMIC     ${port}`,
    );
  }
  out.push(`Total Mac Addresses for this criterion: ${rows.length}`);
  return out;
}

// ---------------------------------------------------------------- Interfaces

export function showInterface(d: D, p: Port): string[] {
  const s = portStatus(p);
  const a = ifaceIp(d, p.id);
  const c = p.counters;
  const bw = (p.operSpeed || (p.kind === 'ge' ? 1000 : 100)) * 1000;
  const lineStatus = p.errdisabled
    ? 'down (err-disabled)'
    : !p.adminUp
      ? 'administratively down'
      : p.operUp
        ? 'up'
        : 'down';
  const desc = isCliDevice(d) ? d.config.sys.descriptions[p.id] : undefined;
  const out = [
    `${p.name} is ${lineStatus}, line protocol is ${s.proto}`,
    `  Hardware is ${p.kind === 'ge' ? 'CN Gigabit Ethernet' : 'Fast Ethernet'}, address is ${ciscoMac(p.mac)} (bia ${ciscoMac(p.mac)})`,
  ];
  if (desc) out.push(`  Description: ${desc}`);
  if (a) out.push(`  Internet address is ${a.ip}/${maskToPrefix(a.mask)}`);
  out.push(
    `  MTU ${p.mtu} bytes, BW ${bw} Kbit/sec, DLY 10 usec,`,
    '     reliability 255/255, txload 1/255, rxload 1/255',
    '  Encapsulation ARPA, loopback not set',
    '  Keepalive set (10 sec)',
  );
  if (p.operUp) {
    out.push(
      `  ${p.operDuplex === 'full' ? 'Full' : 'Half'}-duplex, ${p.operSpeed}Mb/s, media type is RJ45`,
    );
  } else out.push('  Auto-duplex, Auto Speed, media type is RJ45');
  if (d.config.kind === 'router') out.push('  ARP type: ARPA, ARP Timeout 04:00:00');
  out.push(
    `  ${c.inPkts} packets input, ${c.inBytes} bytes`,
    `  ${c.inErrors} input errors`,
    `  ${c.outPkts} packets output, ${c.outBytes} bytes`,
    `  ${c.outErrors} output errors, ${c.collisions} collisions`,
  );
  return out;
}

export function showInterfacesStatus(_e: Engine, d: D): string[] {
  const out = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  const sys = isCliDevice(d) ? d.config.sys : undefined;
  const cfg = sw(d);
  for (const p of d.ports) {
    const pc = cfg?.ports[p.id];
    const status = p.errdisabled
      ? 'err-disabled'
      : !p.adminUp
        ? 'disabled'
        : p.operUp
          ? 'connected'
          : 'notconnect';
    const vlan = !cfg
      ? '1'
      : pc?.routed
        ? 'routed'
        : cfg.operTrunk[p.id]
          ? 'trunk'
          : String(pc?.accessVlan ?? 1);
    const duplex = p.operUp ? `a-${p.operDuplex}` : 'auto';
    const speed = p.operUp ? `a-${p.operSpeed}` : 'auto';
    const type = p.kind === 'ge' ? '10/100/1000BaseTX' : '10/100BaseTX';
    out.push(
      `${shortName(p.name).padEnd(10)}${(sys?.descriptions[p.id] ?? '').slice(0, 18).padEnd(19)}${status.padEnd(13)}${vlan.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}`,
    );
  }
  return out;
}

export function showInterfacesSwitchport(d: D, p: Port): string[] {
  const cfg = sw(d);
  const pc = cfg?.ports[p.id];
  if (!cfg || !pc) return [];
  const trunk = cfg.operTrunk[p.id];
  const mode =
    pc.mode === 'dynamic-auto'
      ? 'dynamic auto'
      : pc.mode === 'dynamic-desirable'
        ? 'dynamic desirable'
        : pc.mode;
  return [
    `Name: ${shortName(p.name)}`,
    `Switchport: ${pc.routed ? 'Disabled' : 'Enabled'}`,
    `Administrative Mode: ${mode}`,
    `Operational Mode: ${pc.routed ? 'down' : trunk ? 'trunk' : 'static access'}`,
    `Administrative Trunking Encapsulation: dot1q`,
    `Access Mode VLAN: ${pc.accessVlan} (${cfg.vlans[pc.accessVlan]?.name ?? 'inactive'})`,
    `Trunking Native Mode VLAN: ${pc.nativeVlan}`,
    `Trunking VLANs Enabled: ${pc.allowed === 'all' ? 'ALL' : compressVlans(pc.allowed)}`,
  ];
}

// ---------------------------------------------------------------- Switching

function wrapPorts(list: string[], width = 31): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const item of list) {
    const add = cur ? `, ${item}` : item;
    if (cur && (cur + add).length > width) {
      lines.push(cur + ',');
      cur = item;
    } else cur += add;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function showVlanBrief(d: D): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  const out = [
    'VLAN Name                             Status    Ports',
    '---- -------------------------------- --------- -------------------------------',
  ];
  const ids = Object.keys(cfg.vlans)
    .map(Number)
    .sort((a, b) => a - b);
  for (const v of ids) {
    const ports = d.ports
      .filter((p) => {
        const pc = cfg.ports[p.id];
        return (
          pc &&
          !pc.routed &&
          !cfg.operTrunk[p.id] &&
          pc.accessVlan === v &&
          !(pc.channel !== undefined)
        );
      })
      .map((p) => shortName(p.name));
    const lines = wrapPorts(ports);
    out.push(
      `${String(v).padEnd(5)}${(cfg.vlans[v]?.name ?? '').padEnd(33)}${'active'.padEnd(10)}${lines[0] ?? ''}`,
    );
    for (const l of lines.slice(1)) out.push(`${' '.repeat(48)}${l}`);
  }
  for (const [v, n] of [
    [1002, 'fddi-default'],
    [1003, 'token-ring-default'],
    [1004, 'fddinet-default'],
    [1005, 'trnet-default'],
  ] as const) {
    out.push(`${String(v).padEnd(5)}${n.padEnd(33)}${'act/unsup'}`);
  }
  return out;
}

export function showTrunk(d: D): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  const trunks = d.ports.filter((p) => cfg.operTrunk[p.id] && p.operUp);
  if (trunks.length === 0) return [];
  const out = ['Port        Mode             Encapsulation  Status        Native vlan'];
  for (const p of trunks) {
    const pc = cfg.ports[p.id];
    out.push(
      `${shortName(p.name).padEnd(12)}${(pc?.mode === 'trunk' ? 'on' : 'desirable').padEnd(17)}${'802.1q'.padEnd(15)}${'trunking'.padEnd(14)}${pc?.nativeVlan ?? 1}`,
    );
  }
  const active = Object.keys(cfg.vlans).map(Number);
  const section = (title: string, f: (allowed: number[]) => string): void => {
    out.push('', `Port        ${title}`);
    for (const p of trunks) {
      const pc = cfg.ports[p.id];
      const allowed =
        pc?.allowed === 'all' ? Array.from({ length: 4094 }, (_, i) => i + 1) : (pc?.allowed ?? []);
      out.push(`${shortName(p.name).padEnd(12)}${f(allowed)}`);
    }
  };
  section('Vlans allowed on trunk', (a) => (a.length === 4094 ? '1-4094' : compressVlans(a)));
  section('Vlans allowed and active in management domain', (a) =>
    compressVlans(a.filter((v) => active.includes(v))),
  );
  section('Vlans in spanning tree forwarding state and not pruned', (a) =>
    compressVlans(
      a.filter((v) => {
        const ports = cfg.stp.instances[v]?.ports ?? {};
        return Object.values(ports).some((ps) => ps.state === 'forwarding');
      }),
    ),
  );
  return out;
}

export function showSpanningTree(d: D, vlan?: number): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  const out: string[] = [];
  const vlans =
    vlan !== undefined
      ? [vlan]
      : Object.keys(cfg.stp.instances)
          .map(Number)
          .sort((a, b) => a - b);
  for (const v of vlans) {
    const inst = cfg.stp.instances[v];
    if (!inst) continue;
    const own = `${String((cfg.stp.priority[v] ?? 32768) + v).padStart(5, '0')}.${d.ports[0]?.mac ?? ''}`;
    const isRoot = inst.rootId === own;
    const prio = Number(inst.rootId.split('.')[0]);
    const rootMac = ciscoMac(inst.rootId.split('.')[1] ?? '');
    const proto = cfg.stp.mode === 'rapid-pvst' ? 'rstp' : 'ieee';
    out.push(`VLAN${String(v).padStart(4, '0')}`, `  Spanning tree enabled protocol ${proto}`);
    out.push(`  Root ID    Priority    ${prio}`, `             Address     ${rootMac}`);
    if (isRoot) out.push('             This bridge is the root');
    else {
      const rp = inst.rootPort
        ? d.ports.find(
            (p) => p.id === (inst.rootPort?.startsWith('po') ? undefined : inst.rootPort),
          )
        : undefined;
      out.push(
        `             Cost        ${inst.rootCost}`,
        `             Port        ${rp ? `${d.ports.indexOf(rp) + 1} (${rp.name})` : inst.rootPort}`,
      );
    }
    out.push('             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec', '');
    const base = cfg.stp.priority[v] ?? 32768;
    out.push(`  Bridge ID  Priority    ${base + v}  (priority ${base} sys-id-ext ${v})`);
    out.push(`             Address     ${ciscoMac(d.ports[0]?.mac ?? '')}`);
    out.push(
      '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
      `             Aging Time  ${cfg.agingSec} sec`,
      '',
    );
    out.push(
      'Interface           Role Sts Cost      Prio.Nbr Type',
      '------------------- ---- --- --------- -------- --------------------------------',
    );
    for (const [lp, ps] of Object.entries(inst.ports)) {
      const first = lp.startsWith('po') ? undefined : d.ports.find((p) => p.id === lp);
      const name = first ? shortName(first.name) : `Po${lp.slice(2)}`;
      const idx = first ? d.ports.indexOf(first) + 1 : 0;
      const role = { root: 'Root', designated: 'Desg', alternate: 'Altn', disabled: 'Dis' }[
        ps.role
      ];
      const sts = { discarding: 'BLK', listening: 'LIS', learning: 'LRN', forwarding: 'FWD' }[
        ps.state
      ];
      const cost = (first?.operSpeed ?? 100) >= 1000 ? 4 : 19;
      out.push(
        `${name.padEnd(20)}${role.padEnd(5)}${sts.padEnd(4)}${String(cost).padEnd(10)}${`128.${idx}`.padEnd(9)}${ps.edge ? 'P2p Edge' : 'P2p'}`,
      );
    }
    out.push('');
  }
  return out;
}

export function showSpanningTreeSummary(d: D): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  const proto = cfg.stp.mode === 'rapid-pvst' ? 'rapid-pvst' : 'pvst';
  const out = [`Switch is in ${proto} mode`, 'Root bridge for: ' + rootFor(d, cfg), ''];
  out.push('Name                   Blocking Listening Learning Forwarding STP Active');
  out.push('---------------------- -------- --------- -------- ---------- ----------');
  let tb = 0,
    tl = 0,
    tn = 0,
    tf = 0,
    n = 0;
  for (const v of Object.keys(cfg.stp.instances)
    .map(Number)
    .sort((a, b) => a - b)) {
    const ports = Object.values(cfg.stp.instances[v]?.ports ?? {}).filter(
      (p) => p.role !== 'disabled',
    );
    const c = (s: string): number => ports.filter((p) => p.state === s).length;
    const row = [c('discarding'), c('listening'), c('learning'), c('forwarding'), ports.length];
    tb += row[0] as number;
    tl += row[1] as number;
    tn += row[2] as number;
    tf += row[3] as number;
    n++;
    out.push(
      `${('VLAN' + String(v).padStart(4, '0')).padEnd(23)}${row.map((x, i) => String(x).padEnd([9, 10, 9, 11, 0][i] as number)).join('')}`.trimEnd(),
    );
  }
  out.push('---------------------- -------- --------- -------- ---------- ----------');
  out.push(
    `${(n + ' vlans').padEnd(23)}${String(tb).padEnd(9)}${String(tl).padEnd(10)}${String(tn).padEnd(9)}${String(tf).padEnd(11)}${tb + tl + tn + tf}`,
  );
  return out;
}

function rootFor(d: D, cfg: NonNullable<ReturnType<typeof sw>>): string {
  const mine = Object.entries(cfg.stp.instances)
    .filter(
      ([v, i]) =>
        i.rootId ===
        `${String((cfg.stp.priority[Number(v)] ?? 32768) + Number(v)).padStart(5, '0')}.${d.ports[0]?.mac ?? ''}`,
    )
    .map(([v]) => 'VLAN' + String(v).padStart(4, '0'));
  return mine.length ? mine.join(', ') : 'none';
}

export function showEtherchannel(d: D): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  const groups = new Map<number, string[]>();
  for (const p of d.ports) {
    const n = cfg.ports[p.id]?.channel;
    if (n !== undefined) (groups.get(n) ?? groups.set(n, []).get(n))?.push(p.id);
  }
  const out = [
    'Flags:  D - down        P - bundled in port-channel',
    '        I - stand-alone s - suspended',
    '        H - Hot-standby (LACP only)',
    '        R - Layer3      S - Layer2',
    '        U - in use      f - failed to allocate aggregator',
    '',
    `Number of channel-groups in use: ${groups.size}`,
    `Number of aggregators:           ${groups.size}`,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
  ];
  for (const [n, members] of [...groups].sort(([a], [b]) => a - b)) {
    const bundled = cfg.bundles[n] ?? [];
    const mode = cfg.ports[members[0] as string]?.channelMode ?? 'on';
    const proto = mode === 'on' ? '-' : mode === 'active' || mode === 'passive' ? 'LACP' : 'PAgP';
    const ports = members
      .map(
        (m) =>
          `${shortName(d.ports.find((p) => p.id === m)?.name ?? '')}(${bundled.includes(m) ? 'P' : d.ports.find((p) => p.id === m)?.operUp ? 'I' : 'D'})`,
      )
      .join('   ');
    out.push(
      `${String(n).padEnd(7)}Po${n}(${bundled.length ? 'SU' : 'SD'})`.padEnd(30) +
        `${proto.padEnd(8)}  ${ports}`,
    );
  }
  return out;
}

export function showPortSecurity(d: D, portId?: string): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  if (portId) {
    const p = d.ports.find((x) => x.id === portId);
    const ps = cfg.ports[portId]?.psec;
    if (!p || !ps) return [];
    const status = !ps.enabled
      ? 'Secure-down'
      : p.errdisabled
        ? 'Secure-shutdown'
        : p.operUp
          ? 'Secure-up'
          : 'Secure-down';
    return [
      `Port Security              : ${ps.enabled ? 'Enabled' : 'Disabled'}`,
      `Port Status                : ${status}`,
      `Violation Mode             : ${ps.violation[0]?.toUpperCase()}${ps.violation.slice(1)}`,
      'Aging Time                 : 0 mins',
      'Aging Type                 : Absolute',
      'SecureStatic Address Aging : Disabled',
      `Maximum MAC Addresses      : ${ps.max}`,
      `Total MAC Addresses        : ${ps.macs.length + ps.dynMacs.length}`,
      `Configured MAC Addresses   : ${ps.sticky ? 0 : ps.macs.length}`,
      `Sticky MAC Addresses       : ${ps.sticky ? ps.macs.length : 0}`,
      `Last Source Address:Vlan   : ${ps.lastMac ? ciscoMac(ps.lastMac) : '0000.0000.0000'}:${cfg.ports[portId]?.accessVlan ?? 1}`,
      `Security Violation Count   : ${ps.violations}`,
    ];
  }
  const out = [
    'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
    '                (Count)       (Count)          (Count)',
    '--------------------------------------------------------------------',
  ];
  for (const p of d.ports) {
    const ps = cfg.ports[p.id]?.psec;
    if (!ps?.enabled) continue;
    const act = ps.violation[0]?.toUpperCase() + ps.violation.slice(1);
    out.push(
      `${shortName(p.name).padStart(12)}${String(ps.max).padStart(15)}${String(ps.macs.length + ps.dynMacs.length).padStart(13)}${String(ps.violations).padStart(19)}${act.padStart(17)}`,
    );
  }
  out.push(
    '----------------------------------------------------------------------',
    'Total Addresses in System (excluding one mac per port)     : 0',
    'Max Addresses limit in System (excluding one mac per port) : 6144',
  );
  return out;
}

export function showVtp(d: D): string[] {
  const cfg = sw(d);
  if (!cfg) return [];
  return [
    'VTP Version capable             : 1 to 3',
    'VTP version running             : 2',
    `VTP Domain Name                 : ${cfg.vtp.domain}`,
    'VTP Pruning Mode                : Disabled',
    'VTP Traps Generation            : Disabled',
    `Device ID                       : ${ciscoMac(d.ports[0]?.mac ?? '')}`,
    'Feature VLAN:',
    '--------------',
    `VTP Operating Mode                : ${cfg.vtp.mode[0]?.toUpperCase()}${cfg.vtp.mode.slice(1)}`,
    'Maximum VLANs supported locally   : 1005',
    `Number of existing VLANs          : ${Object.keys(cfg.vlans).length + 4}`,
    `Configuration Revision            : ${cfg.vtp.revision}`,
  ];
}

// ---------------------------------------------------------------- DHCP / ACL / NAT

const BASE_DATE = Date.UTC(2024, 0, 1, 0, 0, 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(t: number): string {
  const x = new Date(BASE_DATE + t / 1000);
  const h = x.getUTCHours();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[x.getUTCMonth()]} ${p(x.getUTCDate())} ${x.getUTCFullYear()} ${p(h % 12 === 0 ? 12 : h % 12)}:${p(x.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

const dhcpOf = (d: D) => (d.config.kind === 'host' ? d.config.services.dhcp : l3(d)?.dhcp);

export function showDhcpBinding(e: Engine, d: D): string[] {
  const srv = dhcpOf(d);
  const out = [
    'Bindings from all pools not associated with VRF:',
    'IP address      Client-ID/              Lease expiration        Type',
    '                Hardware address/',
    '                User name',
  ];
  for (const [ip, b] of Object.entries(srv?.bindings ?? {}).sort(
    ([a], [c]) => (parseIpv4(a) ?? 0) - (parseIpv4(c) ?? 0),
  )) {
    if (b.offered || b.expiresAt <= e.state.now) continue;
    out.push(
      `${ip.padEnd(16)}${ciscoMac(b.mac).padEnd(24)}${stamp(b.expiresAt).padEnd(24)}Automatic`,
    );
  }
  return out;
}

export function showDhcpPool(e: Engine, d: D): string[] {
  const srv = dhcpOf(d);
  const out: string[] = [];
  for (const p of srv?.pools ?? []) {
    const plen = maskToPrefix(p.mask) ?? 24;
    const total = Math.max(0, 2 ** (32 - plen) - 2);
    const leased = Object.values(srv?.bindings ?? {}).filter(
      (b) => b.poolName === p.name && !b.offered && b.expiresAt > e.state.now,
    ).length;
    out.push(
      `Pool ${p.name} :`,
      ' Utilization mark (high/low)    : 100 / 0',
      ' Subnet size (first/next)       : 0 / 0 ',
      ` Total addresses                : ${total}`,
      ` Leased addresses               : ${leased}`,
      ' Pending event                  : none',
      ' 1 subnet is currently in the pool :',
      ' Current index        IP address range                    Leased addresses',
      ` ${p.network.padEnd(20)} ${`${p.network} - ${p.network.replace(/\.\d+$/, '.' + (2 ** (32 - plen) - 1))}`.padEnd(35)} ${leased}`,
      '',
    );
  }
  return out;
}

export function showDhcpConflict(e: Engine, d: D): string[] {
  const out = ['IP address        Detection method   Detection time          VRF'];
  for (const ip of dhcpOf(d)?.conflicts ?? [])
    out.push(`${ip.padEnd(18)}${'ARP'.padEnd(19)}${stamp(e.state.now)}`);
  return out;
}

export function showAccessLists(d: D, name?: string): string[] {
  const cfg = l3(d);
  const out: string[] = [];
  const acls = Object.values(cfg?.acls ?? {}).filter((a) => !name || a.name === name);
  acls.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const a of acls) {
    out.push(`${a.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${a.name}`);
    for (const e of a.entries) {
      let text = aclEntryText(e, a.type);
      if (a.type === 'standard') {
        const m = e.src;
        text = 'any' in m ? `${e.action} any` : `${e.action} ${m.ip}, wildcard bits ${m.wildcard}`;
      }
      out.push(
        `    ${e.seq} ${text}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''}`,
      );
    }
  }
  return out;
}

export function showNatTranslations(d: D): string[] {
  const cfg = l3(d);
  const out = ['Pro Inside global      Inside local       Outside local      Outside global'];
  for (const t of cfg?.nat.table ?? []) {
    const ep = (x: { ip: string; port: number }): string =>
      t.proto === 'ip' ? x.ip : `${x.ip}:${x.port}`;
    const out2 = t.proto === 'icmp' ? `${t.outside.ip}:${t.insideGlobal.port}` : ep(t.outside);
    out.push(
      `${t.proto.padEnd(4)}${ep(t.insideGlobal).padEnd(19)}${ep(t.insideLocal).padEnd(19)}${(t.proto === 'icmp' ? `${t.outside.ip}:${t.insideLocal.port}` : ep(t.outside)).padEnd(19)}${out2}`,
    );
  }
  return out;
}

export function showNatStatistics(d: D): string[] {
  const cfg = l3(d);
  if (!cfg) return [];
  const table = cfg.nat.table;
  const stat = table.filter((t) => t.kind === 'static').length;
  const out = [
    `Total active translations: ${table.length} (${stat} static, ${table.length - stat} dynamic; ${table.length - stat} extended)`,
  ];
  const inside = Object.entries(cfg.ifaces).filter(([, c]) => c.natSide === 'inside');
  const outside = Object.entries(cfg.ifaces).filter(([, c]) => c.natSide === 'outside');
  out.push('Outside interfaces:', ...outside.map(([id]) => `  ${ifDisplay(d, id)}`));
  out.push('Inside interfaces:', ...inside.map(([id]) => `  ${ifDisplay(d, id)}`));
  out.push(
    `Hits: ${cfg.nat.hits}  Misses: ${cfg.nat.misses}`,
    'Expired translations: 0',
    'Dynamic mappings:',
  );
  for (const r of cfg.nat.rules) {
    if (r.kind === 'dynamic')
      out.push(
        '-- Inside Source',
        `[Id: 1] access-list ${r.acl} pool ${r.pool} refcount ${table.length}`,
      );
    else if (r.kind === 'interface')
      out.push(
        '-- Inside Source',
        `[Id: 1] access-list ${r.acl} interface ${ifDisplay(d, r.ifaceId)} refcount ${table.length}`,
      );
  }
  return out;
}

// ---------------------------------------------------------------- Sonstiges

export function showVersion(e: Engine, d: D): string[] {
  const sys = isCliDevice(d) ? d.config.sys : undefined;
  const secs = Math.floor(e.state.now / 1_000_000);
  const up = `${Math.floor(secs / 3600)} hours, ${Math.floor((secs % 3600) / 60)} minutes, ${secs % 60} seconds`;
  const ge = d.ports.filter((p) => p.kind === 'ge').length;
  const fe = d.ports.filter((p) => p.kind === 'fe').length;
  return [
    'NetSim Software (SIM-UNIVERSALK9-M), Version 15.1(4)M (simulated)',
    'Technical Support: none (this is a simulator, not Cisco IOS)',
    '',
    `ROM: NetSim ROMMON Version 1.0`,
    '',
    `${sys?.hostname ?? d.name} uptime is ${up}`,
    `Processor board ID SIM${d.id.replace(/\D/g, '').padStart(8, '0')}`,
    `${fe ? `${fe} FastEthernet interface${fe > 1 ? 's' : ''}` : ''}${fe && ge ? ', ' : ''}${ge ? `${ge} Gigabit Ethernet interface${ge > 1 ? 's' : ''}` : ''}`,
    `Model: ${d.model}`,
    '',
    'Configuration register is 0x2102',
  ];
}

export function showClock(e: Engine, sys: SysConfig): string[] {
  return [formatClock(sys, e.state.now)];
}

export function showRunning(e: Engine, d: D): string[] {
  if (!isCliDevice(d)) return [];
  const body = renderRunningConfig(e, d);
  const bytes = body.join('\n').length;
  return ['Building configuration...', '', `Current configuration : ${bytes} bytes`, ...body];
}

export function showStartup(d: D): string[] {
  if (!isCliDevice(d) || d.config.sys.startupConfig === undefined) {
    return ['startup-config is not present'];
  }
  const text = d.config.sys.startupConfig;
  return [`Using ${text.length} bytes`, ...text.split('\n')];
}

export { ifShort };
