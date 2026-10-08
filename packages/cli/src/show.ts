import { maskToPrefix, parseIpv4, sameSubnet } from '@netsim/protocols';
import type { Device, Engine, Port, RibEntry } from '@netsim/engine';
import { networkOf, prefixMask } from '@netsim/engine';
import { ciscoMac, shortName } from './format';
import { isCliDevice, renderRunningConfig } from './render';

type D = Device;

const portStatus = (p: Port): { status: string; proto: string } =>
  !p.adminUp
    ? { status: 'administratively down', proto: 'down' }
    : p.operUp
      ? { status: 'up', proto: 'up' }
      : { status: 'down', proto: 'down' };

export function ifaceIp(d: D, p: Port): { ip: string; mask: string } | undefined {
  if (d.config.kind !== 'router') return undefined;
  const i = d.config.ifaces[p.id];
  return i?.ip && i.mask ? { ip: i.ip, mask: i.mask } : undefined;
}

export function showIpInterfaceBrief(_e: Engine, d: D): string[] {
  const out = ['Interface              IP-Address      OK? Method Status                Protocol'];
  for (const p of d.ports) {
    const a = ifaceIp(d, p);
    const s = portStatus(p);
    out.push(
      `${p.name.padEnd(23)}${(a?.ip ?? 'unassigned').padEnd(16)}${'YES'.padEnd(4)}${(a ? 'manual' : 'unset').padEnd(7)}${s.status.padEnd(22)}${s.proto}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------- show ip route

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

export function showIpRoute(e: Engine, d: D, target?: string): string[] {
  const rib = e.routingTable(d.id);
  if (target) return showRouteEntry(d, rib, target);
  const def = rib.find((r) => r.type === 'S' && r.plen === 0);
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
  const line = (r: RibEntry, width: number): string => {
    const code = (r.type === 'S' && r.plen === 0 ? 'S*' : r.type).padEnd(width);
    const port = d.ports.find((p) => p.id === r.portId);
    const where =
      r.type === 'S' && r.nextHop
        ? `[${r.ad}/${r.metric}] via ${r.nextHop}`
        : r.type === 'S'
          ? `[${r.ad}/${r.metric}] is directly connected, ${port?.name ?? ''}`
          : `is directly connected, ${port?.name ?? ''}`;
    return `${code}${r.prefix}/${r.plen} ${where}`;
  };
  if (def) out.push(line(def, 5));
  for (const [key, entries] of groups) {
    const masks = new Set(entries.map((x) => x.plen));
    const subnets = new Set(entries.map((x) => `${x.prefix}/${x.plen}`)).size;
    if (masks.size > 1) {
      out.push(`      ${key} is variably subnetted, ${subnets} subnets, ${masks.size} masks`);
    } else {
      const only = [...masks][0] as number;
      out.push(`      ${key.split('/')[0]}/${only} is subnetted, ${subnets} subnets`);
    }
    for (const r of entries) out.push(line(r, 9));
  }
  return out;
}

function showRouteEntry(d: D, rib: RibEntry[], target: string): string[] {
  let best: RibEntry | undefined;
  for (const r of rib) {
    if (r.type === 'L' && r.prefix !== target) continue;
    if (!sameSubnet(r.prefix, target, prefixMask(r.plen))) continue;
    if (!best || r.plen > best.plen || (r.plen === best.plen && r.ad < best.ad)) best = r;
  }
  if (!best) return ['% Network not in table'];
  const known = best.type === 'C' ? 'connected' : best.type === 'L' ? 'receive' : 'static';
  const port = d.ports.find((p) => p.id === best.portId);
  const out = [
    `Routing entry for ${best.prefix}/${best.plen}`,
    `  Known via "${known}", distance ${best.ad}, metric ${best.metric}${best.type === 'C' ? ' (connected, via interface)' : ''}`,
    '  Routing Descriptor Blocks:',
  ];
  out.push(
    best.nextHop ? `  * ${best.nextHop}` : `  * directly connected, via ${port?.name ?? ''}`,
  );
  out.push(`      Route metric is ${best.metric}, traffic share count is 1`);
  return out;
}

// ---------------------------------------------------------------- ARP / MAC

export function showIpArp(e: Engine, d: D): string[] {
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const cfg = d.config;
  if (cfg.kind !== 'router') return out;
  const rows: { ip: string; age: string; mac: string; port: string }[] = [];
  for (const p of d.ports) {
    const a = ifaceIp(d, p);
    if (a && p.operUp) rows.push({ ip: a.ip, age: '-', mac: ciscoMac(p.mac), port: p.name });
  }
  for (const [ip, ent] of Object.entries(cfg.arpCache)) {
    if (ent.expiresAt <= e.state.now) continue;
    const learned = ent.expiresAt - 14_400_000_000;
    const port = d.ports.find((p) => {
      const a = ifaceIp(d, p);
      return a && sameSubnet(a.ip, ip, a.mask);
    });
    rows.push({
      ip,
      age: String(Math.max(0, Math.floor((e.state.now - learned) / 60_000_000))),
      mac: ciscoMac(ent.mac),
      port: port?.name ?? '',
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
    const p = d.ports.find((x) => x.id === r.portId);
    out.push(
      `${'1'.padStart(4)}    ${ciscoMac(r.mac).padEnd(15)}   DYNAMIC     ${shortName(p?.name ?? '')}`,
    );
  }
  out.push(`Total Mac Addresses for this criterion: ${rows.length}`);
  return out;
}

// ---------------------------------------------------------------- Interfaces

export function showInterface(d: D, p: Port): string[] {
  const s = portStatus(p);
  const a = ifaceIp(d, p);
  const c = p.counters;
  const bw = (p.operSpeed || (p.kind === 'ge' ? 1000 : 100)) * 1000;
  const lineStatus = !p.adminUp ? 'administratively down' : p.operUp ? 'up' : 'down';
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
  for (const p of d.ports) {
    const status = !p.adminUp ? 'disabled' : p.operUp ? 'connected' : 'notconnect';
    const duplex = p.operUp ? `a-${p.operDuplex}` : 'auto';
    const speed = p.operUp ? `a-${p.operSpeed}` : 'auto';
    const type = p.kind === 'ge' ? '10/100/1000BaseTX' : '10/100BaseTX';
    out.push(
      `${shortName(p.name).padEnd(10)}${(sys?.descriptions[p.id] ?? '').slice(0, 18).padEnd(19)}${status.padEnd(13)}${'1'.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}`,
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

const BASE_DATE = Date.UTC(2024, 0, 1, 0, 0, 0);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function showClock(e: Engine): string[] {
  const t = new Date(BASE_DATE + e.state.now / 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return [
    `*${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}.${String(t.getUTCMilliseconds()).padStart(3, '0')} UTC ${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()} ${t.getUTCFullYear()}`,
  ];
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
