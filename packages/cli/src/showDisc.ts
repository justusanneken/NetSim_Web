import { liveNeighbors, discOf, type Device, type DiscNeighbor, type L3Cfg } from '@netsim/engine';
import { ciscoMac, shortName } from './format';

const l3 = (d: Device): (L3Cfg & { kind: 'router' | 'switch' }) | undefined =>
  d.config.kind === 'router' || d.config.kind === 'switch'
    ? (d.config as L3Cfg & { kind: 'router' | 'switch' })
    : undefined;

/** `FastEthernet0/24` -> `Fas 0/24`, `GigabitEthernet0/1` -> `Gig 0/1` (CDP-Tabelle). */
export const cdpShort = (name: string): string =>
  name
    .replace(/^TenGigabitEthernet/, 'Ten ')
    .replace(/^GigabitEthernet/, 'Gig ')
    .replace(/^FastEthernet/, 'Fas ')
    .replace(/^Serial/, 'Ser ');

const CAP_WORD: Record<string, string> = {
  R: 'Router',
  S: 'Switch',
  I: 'IGMP',
  T: 'Trans-Bridge',
  B: 'Source-Route-Bridge',
  H: 'Host',
  r: 'Repeater',
};

const portName = (d: Device, id: string): string => d.ports.find((p) => p.id === id)?.name ?? id;

export function showCdp(d: Device): string[] {
  const c = l3(d);
  if (!c || !discOf(c).cdpRun) return ['% CDP is not enabled'];
  const x = discOf(c);
  return [
    'Global CDP information:',
    `\tSending CDP packets every ${x.cdpTimer} seconds`,
    `\tSending a holdtime value of ${x.cdpHold} seconds`,
    '\tSending CDPv2 advertisements is  enabled',
  ];
}

const CDP_CODES = [
  'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
  '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone, ',
  '                  D - Remote, C - CVTA, M - Two-port Mac Relay ',
  '',
];

const holdLeft = (n: DiscNeighbor, now: number): number =>
  Math.max(0, Math.ceil((n.holdUntil - now) / 1e6));

const platShort = (p: string): string => p.replace(/^cisco /i, '').slice(0, 9);

export function showCdpNeighbors(d: Device, now: number, iface?: string): string[] {
  const c = l3(d);
  if (!c || !discOf(c).cdpRun) return ['% CDP is not enabled'];
  const list = liveNeighbors(d, now, 'cdp').filter((n) => !iface || n.localPortId === iface);
  const out = [
    ...CDP_CODES,
    'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
  ];
  for (const n of list) {
    const local = cdpShort(portName(d, n.localPortId));
    const head = n.deviceId.length > 16 ? [n.deviceId, ''.padEnd(17)] : [n.deviceId.padEnd(17)];
    if (head.length === 2) out.push(head[0] as string);
    out.push(
      `${head[head.length - 1]}${local.padEnd(18)}${String(holdLeft(n, now)).padEnd(11)}${n.capabilities.join(' ').padEnd(12)}${platShort(n.platform).padEnd(10)}${cdpShort(n.remotePort)}`,
    );
  }
  out.push('', `Total cdp entries displayed : ${list.length}`);
  return out;
}

function cdpDetailBlock(d: Device, n: DiscNeighbor, now: number): string[] {
  const L = ['-------------------------', `Device ID: ${n.deviceId}`, 'Entry address(es): '];
  if (n.addr) L.push(`  IP address: ${n.addr}`);
  L.push(
    `Platform: ${n.platform},  Capabilities: ${n.capabilities.map((c) => CAP_WORD[c] ?? c).join(' ')} `,
    `Interface: ${portName(d, n.localPortId)},  Port ID (outgoing port): ${n.remotePort}`,
    `Holdtime : ${holdLeft(n, now)} sec`,
    '',
    'Version :',
    n.version,
    '',
    'advertisement version: 2',
  );
  if (n.nativeVlan !== undefined) L.push(`Native VLAN: ${n.nativeVlan}`);
  if (n.duplex) L.push(`Duplex: ${n.duplex}`);
  if (n.addr) L.push('Management address(es): ', `  IP address: ${n.addr}`);
  L.push('');
  return L;
}

export function showCdpDetail(d: Device, now: number, name?: string, iface?: string): string[] {
  const c = l3(d);
  if (!c || !discOf(c).cdpRun) return ['% CDP is not enabled'];
  const list = liveNeighbors(d, now, 'cdp').filter(
    (n) =>
      (!name || n.deviceId.toLowerCase() === name.toLowerCase()) &&
      (!iface || n.localPortId === iface),
  );
  if (name && list.length === 0) return [];
  const out = list.flatMap((n) => cdpDetailBlock(d, n, now));
  if (!name) out.push(`Total cdp entries displayed : ${list.length}`);
  return out;
}

export function showCdpInterface(d: Device, only?: string): string[] {
  const c = l3(d);
  if (!c || !discOf(c).cdpRun) return ['% CDP is not enabled'];
  const x = discOf(c);
  const out: string[] = [];
  for (const p of d.ports) {
    if ((only && p.id !== only) || x.cdpOff.includes(p.id)) continue;
    const state = !p.adminUp
      ? 'administratively down, line protocol is down'
      : p.operUp
        ? 'up, line protocol is up'
        : 'down, line protocol is down';
    out.push(
      `${p.name} is ${state}`,
      '  Encapsulation ARPA',
      `  Sending CDP packets every ${x.cdpTimer} seconds`,
      `  Holdtime is ${x.cdpHold} seconds`,
    );
  }
  return out;
}

export function showCdpTraffic(d: Device): string[] {
  const c = l3(d);
  if (!c || !discOf(c).cdpRun) return ['% CDP is not enabled'];
  const s = discOf(c).stats;
  return [
    'CDP counters : ',
    `\tTotal packets output: ${s.cdpSent}, Input: ${s.cdpRecv} `,
    '\tHdr syntax: 0, Chksum error: 0, Encaps failed: 0',
    '\tNo memory: 0, Invalid packet: 0, ',
    '\tCDP version 1 advertisements output: 0, Input: 0',
    `\tCDP version 2 advertisements output: ${s.cdpSent}, Input: ${s.cdpRecv}`,
  ];
}

// ---------------------------------------------------------------- LLDP

export function showLldp(d: Device): string[] {
  const c = l3(d);
  if (!c || !discOf(c).lldpRun) return ['% LLDP is not enabled'];
  const x = discOf(c);
  return [
    'Global LLDP Information:',
    '    Status: ACTIVE',
    `    LLDP advertisements are sent every ${x.lldpTimer} seconds`,
    `    LLDP hold time advertised is ${x.lldpHold} seconds`,
    `    LLDP interface reinitialisation delay is ${x.lldpReinit} seconds`,
  ];
}

const LLDP_CODES = [
  'Capability codes:',
  '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
  '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
  '',
];

export function showLldpNeighbors(
  d: Device,
  now: number,
  detail: boolean,
  name?: string,
): string[] {
  const c = l3(d);
  if (!c || !discOf(c).lldpRun) return ['% LLDP is not enabled'];
  const list = liveNeighbors(d, now, 'lldp').filter(
    (n) => !name || n.deviceId.toLowerCase() === name.toLowerCase(),
  );
  const out: string[] = [];
  if (!detail) {
    out.push(
      ...LLDP_CODES,
      'Device ID           Local Intf      Hold-time  Capability      Port ID',
    );
    for (const n of list)
      out.push(
        `${n.deviceId.padEnd(20)}${shortName(portName(d, n.localPortId)).padEnd(16)}${String(holdLeft(n, now)).padEnd(11)}${n.capabilities.join(',').padEnd(16)}${shortName(n.remotePort)}`,
      );
  } else {
    for (const n of list)
      out.push(
        '------------------------------------------------',
        `Local Intf: ${shortName(portName(d, n.localPortId))}`,
        `Chassis id: ${ciscoMac(n.chassisId ?? '')}`,
        `Port id: ${shortName(n.remotePort)}`,
        `Port Description: ${n.remotePort}`,
        `System Name: ${n.deviceId}`,
        '',
        'System Description: ',
        n.sysDesc ?? '',
        '',
        `Time remaining: ${holdLeft(n, now)} seconds`,
        `System Capabilities: ${n.capabilities.join(',')}`,
        `Enabled Capabilities: ${n.capabilities.join(',')}`,
        'Management Addresses:',
        ...(n.addr ? [`    IP: ${n.addr}`] : ['        - not advertised']),
        'Auto Negotiation - supported, enabled',
        '',
      );
  }
  out.push('', `Total entries displayed: ${list.length}`);
  return out;
}

export function showLldpInterface(d: Device, only?: string): string[] {
  const c = l3(d);
  if (!c || !discOf(c).lldpRun) return ['% LLDP is not enabled'];
  const x = discOf(c);
  const out: string[] = [];
  for (const p of d.ports.filter((x) => !only || x.id === only))
    out.push(
      `${p.name}:`,
      `    Tx: ${x.lldpTxOff.includes(p.id) ? 'disabled' : 'enabled'}`,
      `    Rx: ${x.lldpRxOff.includes(p.id) ? 'disabled' : 'enabled'}`,
      `    Tx state: ${x.lldpTxOff.includes(p.id) ? 'INIT' : 'IDLE'}`,
      `    Rx state: ${x.lldpRxOff.includes(p.id) ? 'INIT' : 'WAIT FOR FRAME'}`,
      '',
    );
  return out;
}

export function showLldpTraffic(d: Device): string[] {
  const c = l3(d);
  if (!c || !discOf(c).lldpRun) return ['% LLDP is not enabled'];
  const s = discOf(c).stats;
  return [
    'LLDP traffic statistics:',
    `    Total frames out: ${s.lldpSent}`,
    '    Total entries aged: 0',
    `    Total frames in: ${s.lldpRecv}`,
    '    Total frames received in error: 0',
    '    Total frames discarded: 0',
    '    Total TLVs discarded: 0',
    '    Total TLVs unrecognized: 0',
  ];
}
