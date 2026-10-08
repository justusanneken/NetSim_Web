import {
  type BpduPdu,
  type DhcpPdu,
  type DnsPdu,
  type EthernetPdu,
  type HeaderField,
  type HttpPdu,
  type IcmpPdu,
  type Ipv4Pdu,
  type LayerView,
  type Pdu,
  type ProtoTag,
  type TcpPdu,
  type UdpPdu,
  type VtpPdu,
} from './types';

const ETH_HEADER = 14;
const DOT1Q = 4;
const ETH_FCS = 4;
const ETH_MIN_FRAME = 64;
const IPV4_HEADER = 20;
const ICMP_HEADER = 8;
const UDP_HEADER = 8;
const TCP_HEADER = 20;
const ARP_SIZE = 28;
const DHCP_SIZE = 300;
const BPDU_SIZE = 35;

function appSize(p: UdpPdu['app'] | TcpPdu['app']): number {
  if (!p) return 0;
  switch (p.kind) {
    case 'dhcp':
      return DHCP_SIZE;
    case 'dns':
      return 12 + 20 + p.answers.length * 16;
    case 'http':
      return (p.body?.length ?? 0) + 60 + (p.path?.length ?? 0);
  }
}

export function pduSize(pdu: Pdu): number {
  switch (pdu.kind) {
    case 'arp':
      return ARP_SIZE;
    case 'icmp':
      return ICMP_HEADER + pdu.dataSize;
    case 'udp':
      return UDP_HEADER + pdu.dataSize + appSize(pdu.app);
    case 'tcp':
      return TCP_HEADER + pdu.dataSize + appSize(pdu.app);
    case 'dhcp':
      return DHCP_SIZE;
    case 'dns':
      return appSize(pdu);
    case 'http':
      return appSize(pdu);
    case 'bpdu':
      return BPDU_SIZE;
    case 'vtp':
      return 40 + pdu.vlans.length * 12;
    case 'ipv4':
      return IPV4_HEADER + (pdu.dataLen ?? pduSize(pdu.payload));
    case 'ethernet':
      return Math.max(
        ETH_MIN_FRAME,
        ETH_HEADER + (pdu.vlan ? DOT1Q : 0) + pduSize(pdu.payload) + ETH_FCS,
      );
  }
}

export function clonePdu<T extends Pdu>(pdu: T): T {
  return structuredClone(pdu);
}

/** Schichten von außen (L2) nach innen. */
export function layersOf(pdu: Pdu): Pdu[] {
  switch (pdu.kind) {
    case 'ethernet':
    case 'ipv4':
      return [pdu, ...layersOf(pdu.payload)];
    case 'udp':
    case 'tcp':
      return pdu.app ? [pdu, pdu.app] : [pdu];
    default:
      return [pdu];
  }
}

const ICMP_TYPE_TEXT = {
  'echo-request': '8 (echo request)',
  'echo-reply': '0 (echo reply)',
  'dest-unreachable': '3 (destination unreachable)',
  'time-exceeded': '11 (time exceeded)',
} as const;

const hex = (n: number, w = 4): string => '0x' + n.toString(16).padStart(w, '0');
const f = (name: string, value: string | number | boolean): HeaderField => ({
  name,
  value: typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
});

const tcpFlags = (p: TcpPdu): string =>
  (['syn', 'ack', 'fin', 'rst', 'psh'] as const)
    .filter((k) => p.flags[k])
    .map((k) => k.toUpperCase())
    .join(',') || '-';

export function describePdu(pdu: Pdu): HeaderField[] {
  switch (pdu.kind) {
    case 'ethernet':
      return [
        f('Destination', pdu.dst),
        f('Source', pdu.src),
        ...(pdu.vlan ? [f('802.1Q VLAN', pdu.vlan.vid), f('802.1Q PCP', pdu.vlan.pcp)] : []),
        f('EtherType', hex(pdu.etherType)),
      ];
    case 'arp':
      return [
        f('Operation', pdu.op === 'request' ? '1 (request)' : '2 (reply)'),
        f('Sender MAC', pdu.senderMac),
        f('Sender IP', pdu.senderIp),
        f('Target MAC', pdu.targetMac),
        f('Target IP', pdu.targetIp),
      ];
    case 'ipv4':
      return [
        f('Version', 4),
        f('Total Length', pduSize(pdu)),
        f('Identification', pdu.id),
        f('DF', pdu.df),
        f('MF', pdu.mf),
        f('Fragment Offset', pdu.fragOffset),
        f('TTL', pdu.ttl),
        f('Protocol', pdu.protocol),
        f('Source', pdu.src),
        f('Destination', pdu.dst),
      ];
    case 'icmp':
      return [
        f('Type', ICMP_TYPE_TEXT[pdu.type]),
        f('Code', pdu.code),
        ...(pdu.orig
          ? [f('Original', `${pdu.orig.src} → ${pdu.orig.dst}`)]
          : [f('Identifier', pdu.id), f('Sequence', pdu.seq)]),
        ...(pdu.nextHopMtu !== undefined ? [f('Next-Hop MTU', pdu.nextHopMtu)] : []),
        f('Data', `${pdu.dataSize} bytes`),
      ];
    case 'udp':
      return [
        f('Source Port', pdu.srcPort),
        f('Destination Port', pdu.dstPort),
        f('Length', pduSize(pdu)),
      ];
    case 'tcp':
      return [
        f('Source Port', pdu.srcPort),
        f('Destination Port', pdu.dstPort),
        f('Flags', tcpFlags(pdu)),
        f('Sequence', pdu.seq),
        f('Acknowledgment', pdu.ack),
        f('Window', pdu.window),
      ];
    case 'dhcp':
      return describeDhcp(pdu);
    case 'dns':
      return describeDns(pdu);
    case 'http':
      return pdu.method
        ? [f('Request', `${pdu.method} ${pdu.path}`), f('Host', pdu.host ?? '')]
        : [f('Status', pdu.status ?? 0), f('Body', `${pdu.body?.length ?? 0} bytes`)];
    case 'bpdu':
      return describeBpdu(pdu);
    case 'vtp':
      return describeVtp(pdu);
  }
}

function describeDhcp(p: DhcpPdu): HeaderField[] {
  const o = p.options;
  return [
    f('Message Type', p.op.toUpperCase()),
    f('Transaction ID', hex(p.xid, 8)),
    f('Client MAC', p.chaddr),
    f('Client IP', p.ciaddr),
    f('Your IP', p.yiaddr),
    f('Server IP', p.siaddr),
    f('Relay IP', p.giaddr),
    ...(o.mask ? [f('Option 1 Subnet Mask', o.mask)] : []),
    ...(o.router ? [f('Option 3 Router', o.router)] : []),
    ...(o.dns ? [f('Option 6 DNS', o.dns.join(', '))] : []),
    ...(o.domain ? [f('Option 15 Domain', o.domain)] : []),
    ...(o.leaseSec !== undefined ? [f('Option 51 Lease', `${o.leaseSec} s`)] : []),
    ...(o.serverId ? [f('Option 54 Server ID', o.serverId)] : []),
    ...(o.requestedIp ? [f('Option 50 Requested IP', o.requestedIp)] : []),
    ...(o.tftp ? [f('Option 66 TFTP', o.tftp)] : []),
  ];
}

function describeDns(p: DnsPdu): HeaderField[] {
  return [
    f('ID', p.id),
    f('Type', p.response ? 'response' : 'query'),
    f('Question', `${p.question.name} ${p.question.type}`),
    ...(p.response ? [f('RCODE', p.rcode === 0 ? '0 (NOERROR)' : '3 (NXDOMAIN)')] : []),
    ...p.answers.map((a) => f('Answer', `${a.name} ${a.type} ${a.data} (TTL ${a.ttl})`)),
  ];
}

function describeBpdu(p: BpduPdu): HeaderField[] {
  return [
    f('Protocol', p.rstp ? 'RSTP' : 'STP'),
    f('VLAN', p.vlan),
    f('Root ID', p.rootId),
    f('Root Path Cost', p.rootCost),
    f('Bridge ID', p.bridgeId),
    f('Port ID', p.portId),
    f('Role', p.flags.role),
    f('Proposal', p.flags.proposal),
    f('Agreement', p.flags.agreement),
    f('Topology Change', p.flags.topologyChange),
  ];
}

function describeVtp(p: VtpPdu): HeaderField[] {
  return [
    f('Domain', p.domain),
    f('Revision', p.revision),
    f('VLANs', p.vlans.map((v) => `${v.id}:${v.name}`).join(', ')),
  ];
}

const LAYER_META: Record<Pdu['kind'], { osi: number; name: string }> = {
  ethernet: { osi: 2, name: 'Ethernet II' },
  arp: { osi: 2, name: 'ARP' },
  bpdu: { osi: 2, name: 'STP' },
  vtp: { osi: 2, name: 'VTP' },
  ipv4: { osi: 3, name: 'IPv4' },
  icmp: { osi: 3, name: 'ICMP' },
  udp: { osi: 4, name: 'UDP' },
  tcp: { osi: 4, name: 'TCP' },
  dhcp: { osi: 7, name: 'DHCP' },
  dns: { osi: 7, name: 'DNS' },
  http: { osi: 7, name: 'HTTP' },
};

export function describeFrame(frame: EthernetPdu): LayerView[] {
  return layersOf(frame).map((l) => ({ ...LAYER_META[l.kind], fields: describePdu(l) }));
}

/** Kurzbeschreibung für die Event-Liste: Protokoll-Tag (Farbe) + Info-Text. */
export function summarizeFrame(frame: EthernetPdu): { proto: ProtoTag; info: string } {
  const p = frame.payload;
  switch (p.kind) {
    case 'arp':
      return {
        proto: 'ARP',
        info:
          p.op === 'request'
            ? `Who has ${p.targetIp}? Tell ${p.senderIp}`
            : `${p.senderIp} is at ${p.senderMac}`,
      };
    case 'bpdu':
      return {
        proto: 'STP',
        info: `${p.rstp ? 'RSTP' : 'STP'} VLAN ${p.vlan} root ${p.rootId} cost ${p.rootCost}`,
      };
    case 'vtp':
      return { proto: 'VTP', info: `domain ${p.domain} revision ${p.revision}` };
    case 'ipv4':
      return summarizeIp(p);
  }
}

function summarizeIp(p: Ipv4Pdu): { proto: ProtoTag; info: string } {
  const frag = p.mf || p.fragOffset > 0 ? ` frag@${p.fragOffset * 8}${p.mf ? '+' : ''}` : '';
  const tail = ` ttl=${p.ttl}${frag}`;
  const l4 = p.payload;
  if (l4.kind === 'icmp') {
    const what = l4.orig ? `${l4.type} code=${l4.code}` : `${l4.type} id=${l4.id} seq=${l4.seq}`;
    return { proto: 'ICMP', info: `${what} ${p.src} → ${p.dst}${tail}` };
  }
  if (l4.kind === 'udp') return summarizeUdp(p, l4, tail);
  const a: HttpPdu | undefined = l4.app;
  const app = a ? (a.method ? ` ${a.method} ${a.path}` : ` HTTP ${a.status}`) : '';
  return {
    proto: a ? 'HTTP' : 'TCP',
    info: `${p.src}:${l4.srcPort} → ${p.dst}:${l4.dstPort} [${tcpFlags(l4)}]${app}${tail}`,
  };
}

function summarizeUdp(p: Ipv4Pdu, u: UdpPdu, tail: string): { proto: ProtoTag; info: string } {
  const a = u.app;
  if (a?.kind === 'dhcp') {
    return { proto: 'DHCP', info: `${a.op.toUpperCase()} xid ${hex(a.xid, 8)} ${a.chaddr}${tail}` };
  }
  if (a?.kind === 'dns') {
    const q = `${a.question.name} ${a.question.type}`;
    return { proto: 'DNS', info: `${a.response ? 'response' : 'query'} ${q}${tail}` };
  }
  return { proto: 'UDP', info: `${p.src}:${u.srcPort} → ${p.dst}:${u.dstPort}${tail}` };
}
