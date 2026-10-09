import {
  type BpduPdu,
  type EigrpMsg,
  type PppoePdu,
  type Icmp6Pdu,
  type Ipv6Pdu,
  type OspfLsa,
  type OspfMsg,
  type RoutingPdu,
  type DhcpPdu,
  type DnsPdu,
  type EthernetPdu,
  type HeaderField,
  type HttpPdu,
  type Ipv4Pdu,
  type LayerView,
  type Pdu,
  type ProtoTag,
  type TcpPdu,
  type UdpPdu,
  type SvcPdu,
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

const lsaSize = (l: OspfLsa): number => {
  const b = l.body;
  return (
    20 + (b.type === 1 ? 4 + b.links.length * 12 : b.type === 2 ? 8 + b.attached.length * 4 : 12)
  );
};

function ospfSize(m: OspfMsg): number {
  switch (m.type) {
    case 'hello':
      return 44 + m.neighbors.length * 4;
    case 'dbd':
      return 32 + m.headers.length * 20;
    case 'lsr':
      return 24 + m.requests.length * 12;
    case 'lsu':
      return 28 + m.lsas.reduce((a, l) => a + lsaSize(l), 0);
    case 'lsack':
      return 24 + m.headers.length * 20;
  }
}

function pppoeSize(p: PppoePdu): number {
  if (p.code !== 'SESSION' || !p.ppp) return 6 + 20;
  const m = p.ppp;
  switch (m.proto) {
    case 'lcp':
      return 6 + 2 + 14;
    case 'chap':
      return 6 + 2 + 20;
    case 'ipcp':
      return 6 + 2 + 10;
    case 'ip':
      return 6 + 2 + pduSize(m.inner);
  }
}

function routingSize(p: RoutingPdu): number {
  switch (p.proto) {
    case 'ospf':
      return ospfSize(p.msg);
    case 'eigrp':
      return 20 + (p.msg.routes?.length ?? 0) * 28;
    case 'bgp': {
      const m = p.msg;
      if (m.type === 'open') return 29;
      if (m.type === 'keepalive') return 19;
      if (m.type === 'notification') return 21;
      return (
        23 +
        (m.nlri.length + (m.nlri6?.length ?? 0)) * 5 +
        (m.withdrawn.length + (m.withdrawn6?.length ?? 0)) * 5 +
        (m.attrs ? 20 + m.attrs.asPath.length * 2 : 0)
      );
    }
  }
}

function appSize(p: UdpPdu['app'] | TcpPdu['app']): number {
  if (!p) return 0;
  switch (p.kind) {
    case 'rip':
      return 4 + p.entries.length * 20;
    case 'hsrp':
      return 20;
    case 'dhcp':
      return DHCP_SIZE;
    case 'dhcp6':
      return 40 + (p.dns?.length ?? 0) * 16;
    case 'dns':
      return 12 + 20 + p.answers.length * 16;
    case 'ike':
      return 120 + (p.selector ? 24 : 0);
    case 'http':
      return (p.body?.length ?? 0) + 60 + (p.path?.length ?? 0);
    case 'svc':
      if (p.bgp)
        return routingSize({ kind: 'routing', proto: 'bgp', sport: 0, dport: 0, msg: p.bgp });
      return 24 + (p.body?.length ?? 0) + Object.keys(p.args).length * 12;
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
    case 'svc':
      return appSize(pdu);
    case 'bpdu':
      return BPDU_SIZE;
    case 'vtp':
      return 40 + pdu.vlans.length * 12;
    case 'cdp':
      return 80 + pdu.deviceId.length + pdu.platform.length + pdu.version.length;
    case 'lldp':
      return 60 + pdu.sysName.length + pdu.sysDesc.length;
    case 'rip':
    case 'hsrp':
    case 'dhcp6':
      return appSize(pdu);
    case 'routing':
      return routingSize(pdu);
    case 'gre':
      return 4 + pduSize(pdu.inner);
    case 'esp':
      // SPI + Sequenz + IV + Auth-Tag + Padding um das gekapselte Paket
      return 8 + 16 + 12 + 2 + pduSize(pdu.inner);
    case 'ike':
      return 120 + (pdu.selector ? 24 : 0);
    case 'pppoe':
      return pppoeSize(pdu);
    case 'icmp6':
      return (
        ICMP_HEADER +
        pdu.dataSize +
        (pdu.type === 'ns' || pdu.type === 'na' ? 24 : 0) +
        (pdu.prefixes?.length ?? 0) * 32
      );
    case 'ipv6':
      return 40 + pduSize(pdu.payload);
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
    case 'ipv6':
      return [pdu, ...layersOf(pdu.payload)];
    case 'gre':
      return [pdu, ...layersOf(pdu.inner)];
    case 'pppoe':
      return pdu.ppp?.proto === 'ip' ? [pdu, ...layersOf(pdu.ppp.inner)] : [pdu];
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

const SVC_TAG: Record<SvcPdu['proto'], ProtoTag> = {
  tftp: 'TFTP',
  ftp: 'FTP',
  smtp: 'SMTP',
  pop3: 'POP3',
  ntp: 'NTP',
  syslog: 'SYSLOG',
  snmp: 'SNMP',
  radius: 'RADIUS',
  tacacs: 'TACACS',
  telnet: 'TELNET',
  ssh: 'SSH',
  iot: 'IOT',
  capwap: 'CAPWAP',
  bgp: 'BGP',
};

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
    case 'dhcp6':
      return [
        f('Message Type', pdu.op.toUpperCase()),
        f('Transaction ID', hex(pdu.xid, 6)),
        f('Client DUID', pdu.clientId),
        ...(pdu.serverId ? [f('Server DUID', pdu.serverId)] : []),
        ...(pdu.addr ? [f('IA_NA Address', `${pdu.addr}/${pdu.plen ?? 128}`)] : []),
        ...(pdu.leaseSec !== undefined ? [f('Lease', `${pdu.leaseSec} s`)] : []),
        ...(pdu.dns?.length ? [f('DNS Servers', pdu.dns.join(', '))] : []),
        ...(pdu.domain ? [f('Domain Search List', pdu.domain)] : []),
      ];
    case 'dns':
      return describeDns(pdu);
    case 'http':
      return pdu.method
        ? [f('Request', `${pdu.method} ${pdu.path}`), f('Host', pdu.host ?? '')]
        : [f('Status', pdu.status ?? 0), f('Body', `${pdu.body?.length ?? 0} bytes`)];
    case 'svc':
      return describeSvc(pdu);
    case 'bpdu':
      return describeBpdu(pdu);
    case 'vtp':
      return describeVtp(pdu);
    case 'cdp':
      return [
        f('Device ID', pdu.deviceId),
        f('Port ID', pdu.portName),
        f('Platform', pdu.platform),
        f('Capabilities', pdu.capabilities.join(' ')),
        f('Holdtime', `${pdu.holdtime} s`),
        ...(pdu.addr ? [f('Address', pdu.addr)] : []),
        ...(pdu.nativeVlan !== undefined ? [f('Native VLAN', pdu.nativeVlan)] : []),
        ...(pdu.duplex ? [f('Duplex', pdu.duplex)] : []),
      ];
    case 'lldp':
      return [
        f('Chassis ID', pdu.chassisId),
        f('Port ID', pdu.portId),
        f('Port Description', pdu.portDesc),
        f('TTL', `${pdu.ttl} s`),
        f('System Name', pdu.sysName),
        f('System Capabilities', pdu.capabilities.join(',')),
        ...(pdu.mgmtAddr ? [f('Management Address', pdu.mgmtAddr)] : []),
      ];
    case 'rip':
      return [
        f('Command', pdu.command),
        f('Version', 2),
        ...pdu.entries.map((e) => f('Route', `${e.prefix}/${e.mask} metric ${e.metric}`)),
      ];
    case 'hsrp':
      return [
        f('Group', pdu.group),
        f('Op', pdu.op),
        f('State', pdu.state),
        f('Hello', `${pdu.helloSec} s`),
        f('Hold', `${pdu.holdSec} s`),
        f('Priority', pdu.priority),
        f('Virtual IP', pdu.vip),
      ];
    case 'routing':
      return describeRouting(pdu);
    case 'gre':
      return [f('Protocol Type', hex(pdu.protocolType))];
    case 'esp':
      return [
        f('SPI', hex(pdu.spi, 8)),
        f('Sequence', pdu.seq),
        f('Cipher', pdu.cipher),
        f('Payload', `encrypted (${pduSize(pdu.inner)} bytes)`),
      ];
    case 'ike':
      return [
        f('Exchange', pdu.op),
        f('Cookie', hex(pdu.cookie, 8)),
        f('Encryption', pdu.encr),
        f('Hash', pdu.hash),
        f('DH Group', pdu.group),
        f('Auth Digest', '********'),
        f('Transform', pdu.transform),
        ...(pdu.selector ? [f('Proxy ID', `${pdu.selector.src} > ${pdu.selector.dst}`)] : []),
        f('SPI', hex(pdu.spi, 8)),
        ...(pdu.reason ? [f('Reason', pdu.reason)] : []),
      ];
    case 'pppoe':
      return describePppoe(pdu);
    case 'ipv6':
      return [
        f('Version', 6),
        f('Payload Length', pduSize(pdu.payload)),
        f('Next Header', pdu.nextHeader),
        f('Hop Limit', pdu.hopLimit),
        f('Source', pdu.src),
        f('Destination', pdu.dst),
      ];
    case 'icmp6':
      return describeIcmp6(pdu);
  }
}

function describePppoe(p: PppoePdu): HeaderField[] {
  const head = [f('Code', p.code), f('Session ID', hex(p.sessionId))];
  if (p.code !== 'SESSION' || !p.ppp)
    return [
      ...head,
      ...(p.serviceName !== undefined ? [f('Service-Name', p.serviceName || '(any)')] : []),
      ...(p.acName ? [f('AC-Name', p.acName)] : []),
      ...(p.hostUniq ? [f('Host-Uniq', p.hostUniq)] : []),
    ];
  const m = p.ppp;
  switch (m.proto) {
    case 'lcp':
      return [
        ...head,
        f('PPP Protocol', 'LCP (0xc021)'),
        f('Code', m.op),
        f('MRU', m.mru),
        ...(m.auth ? [f('Authentication', 'CHAP')] : []),
        f('Magic Number', hex(m.magic, 8)),
      ];
    case 'chap':
      return [
        ...head,
        f('PPP Protocol', 'CHAP (0xc223)'),
        f('Code', m.op),
        f('Identifier', m.id),
        ...(m.name ? [f('Name', m.name)] : []),
        ...(m.value ? [f('Value', m.op === 'challenge' ? m.value : '********')] : []),
      ];
    case 'ipcp':
      return [
        ...head,
        f('PPP Protocol', 'IPCP (0x8021)'),
        f('Code', m.op),
        f('IP-Address', m.addr),
        ...(m.peer ? [f('Peer', m.peer)] : []),
      ];
    case 'ip':
      return [...head, f('PPP Protocol', 'IP (0x0021)')];
  }
}

function describeSvc(p: SvcPdu): HeaderField[] {
  return [
    f('Protocol', p.proto.toUpperCase()),
    f('Operation', p.op),
    // Geheimnisse (Passwörter, Schlüssel) werden im Inspektor nicht angezeigt
    ...Object.entries(p.args).map(([k, v]) =>
      f(k, /pass|secret|key/i.test(k) ? '********' : String(v)),
    ),
    ...(p.bgp ? [f('BGP message', p.bgp.type)] : []),
    ...(p.body !== undefined
      ? [f('Data', p.encrypted ? `${p.body.length} bytes (encrypted)` : `${p.body.length} bytes`)]
      : []),
  ];
}

function describeIcmp6(p: Icmp6Pdu): HeaderField[] {
  return [
    f('Type', p.type),
    f('Code', p.code),
    ...(p.target ? [f('Target', p.target)] : []),
    ...(p.lladdr ? [f('Link-Layer Address', p.lladdr)] : []),
    ...(p.naFlags
      ? [f('Flags', `R=${+p.naFlags.router} S=${+p.naFlags.solicited} O=${+p.naFlags.override}`)]
      : []),
    ...(p.prefixes?.map((x) =>
      f('Prefix', `${x.prefix}/${x.plen}${x.autonomous ? ' (A)' : ''}${x.onLink ? ' (L)' : ''}`),
    ) ?? []),
    ...(p.type === 'echo-request' || p.type === 'echo-reply'
      ? [f('Identifier', p.id), f('Sequence', p.seq), f('Data', `${p.dataSize} bytes`)]
      : []),
  ];
}

function describeRouting(p: RoutingPdu): HeaderField[] {
  if (p.proto === 'ospf') {
    const m = p.msg;
    const out = [
      f('Version', p.v),
      f('Type', m.type),
      f('Router ID', m.routerId),
      f('Area', m.areaId),
    ];
    if (m.type === 'hello')
      out.push(
        f('Hello / Dead', `${m.helloSec} / ${m.deadSec} s`),
        f('Priority', m.priority),
        f('DR', m.dr),
        f('BDR', m.bdr),
        f('Neighbors', m.neighbors.join(', ')),
      );
    else if (m.type === 'dbd')
      out.push(
        f('Flags', `I=${+m.init} M=${+m.more} MS=${+m.master}`),
        f('Headers', m.headers.length),
      );
    else if (m.type === 'lsr') out.push(f('Requests', m.requests.length));
    else if (m.type === 'lsu')
      for (const l of m.lsas)
        out.push(f('LSA', `type ${l.type} id ${l.id} adv ${l.advRouter} seq ${l.seq}`));
    else out.push(f('Acked', m.headers.length));
    if (m.auth)
      out.push(f('Auth', m.auth.type === 'simple' ? 'simple password' : `MD5 key ${m.auth.keyId}`));
    if (m.type === 'hello' && m.areaType && m.areaType !== 'normal')
      out.push(f('Area type', m.areaType));
    return out;
  }
  if (p.proto === 'eigrp') return describeEigrp(p.msg);
  const m = p.msg;
  const out = [f('Type', m.type)];
  if (m.type === 'open')
    out.push(f('AS', m.asn), f('Hold Time', m.holdSec), f('BGP Identifier', m.routerId));
  if (m.type === 'update') {
    if (m.attrs)
      out.push(
        f('Origin', m.attrs.origin),
        f('AS_PATH', m.attrs.asPath.join(' ') || '(empty)'),
        f('NEXT_HOP', m.attrs.nextHop),
        ...(m.attrs.med !== undefined ? [f('MED', m.attrs.med)] : []),
        ...(m.attrs.localPref !== undefined ? [f('LOCAL_PREF', m.attrs.localPref)] : []),
        ...(m.attrs.communities?.length ? [f('COMMUNITY', m.attrs.communities.join(' '))] : []),
        ...(m.attrs.originatorId ? [f('ORIGINATOR_ID', m.attrs.originatorId)] : []),
        ...(m.attrs.clusterList?.length ? [f('CLUSTER_LIST', m.attrs.clusterList.join(' '))] : []),
        ...(m.attrs.nextHop6 ? [f('MP_NEXT_HOP', m.attrs.nextHop6)] : []),
      );
    for (const n of m.nlri) out.push(f('NLRI', `${n.prefix}/${n.plen}`));
    for (const n of m.nlri6 ?? []) out.push(f('MP_REACH_NLRI', `${n.prefix}/${n.plen}`));
    for (const n of m.withdrawn6 ?? []) out.push(f('MP_UNREACH_NLRI', `${n.prefix}/${n.plen}`));
    for (const n of m.withdrawn) out.push(f('Withdrawn', `${n.prefix}/${n.plen}`));
  }
  if (m.type === 'notification') out.push(f('Error', `${m.code} ${m.text}`));
  return out;
}

function describeEigrp(m: EigrpMsg): HeaderField[] {
  return [
    f('Opcode', m.op),
    f('AS', m.asn),
    f('Router ID', m.routerId),
    f('Hold Time', m.holdSec),
    f('Sequence', m.seq),
    f('Acknowledge', m.ack),
    ...(m.routes ?? []).map((r) =>
      f(
        'Route',
        `${r.prefix}/${r.plen} delay ${r.delay} bw ${r.bandwidth}${r.unreachable ? ' (unreachable)' : ''}`,
      ),
    ),
  ];
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
  cdp: { osi: 2, name: 'CDP' },
  lldp: { osi: 2, name: 'LLDP' },
  ipv4: { osi: 3, name: 'IPv4' },
  ipv6: { osi: 3, name: 'IPv6' },
  icmp6: { osi: 3, name: 'ICMPv6' },
  gre: { osi: 3, name: 'GRE' },
  esp: { osi: 3, name: 'ESP' },
  ike: { osi: 7, name: 'IKE (ISAKMP)' },
  pppoe: { osi: 2, name: 'PPPoE' },
  routing: { osi: 4, name: 'Routing' },
  rip: { osi: 7, name: 'RIPv2' },
  hsrp: { osi: 7, name: 'HSRP' },
  icmp: { osi: 3, name: 'ICMP' },
  udp: { osi: 4, name: 'UDP' },
  tcp: { osi: 4, name: 'TCP' },
  dhcp: { osi: 7, name: 'DHCP' },
  dhcp6: { osi: 7, name: 'DHCPv6' },
  dns: { osi: 7, name: 'DNS' },
  http: { osi: 7, name: 'HTTP' },
  svc: { osi: 7, name: 'Application' },
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
    case 'cdp':
      return { proto: 'CDP', info: `Device ID: ${p.deviceId}  Port ID: ${p.portName}` };
    case 'lldp':
      return { proto: 'LLDP', info: `System Name = ${p.sysName}  Port ID = ${p.portId}` };
    case 'ipv4':
      return summarizeIp(p);
    case 'ipv6':
      return summarizeIp6(p);
    case 'pppoe':
      return summarizePppoe(p);
  }
}

function summarizePppoe(p: PppoePdu): { proto: ProtoTag; info: string } {
  if (p.code !== 'SESSION' || !p.ppp)
    return {
      proto: 'PPPOE',
      info: `${p.code}${p.acName ? ' ' + p.acName : ''}${p.sessionId ? ' session ' + hex(p.sessionId) : ''}`,
    };
  const m = p.ppp;
  if (m.proto === 'ip') {
    const s = summarizeIp(m.inner);
    return { proto: s.proto, info: `[PPPoE ${hex(p.sessionId)}] ${s.info}` };
  }
  return {
    proto: 'PPP',
    info: `${m.proto.toUpperCase()} ${m.op}${m.proto === 'ipcp' ? ' ' + m.addr : ''} (session ${hex(p.sessionId)})`,
  };
}

function summarizeRouting(r: RoutingPdu, tail: string): { proto: ProtoTag; info: string } {
  if (r.proto === 'ospf') {
    const m = r.msg;
    const extra =
      m.type === 'hello'
        ? ` rid ${m.routerId} area ${m.areaId} nbrs ${m.neighbors.length}`
        : m.type === 'lsu'
          ? ` ${m.lsas.length} LSA`
          : m.type === 'dbd'
            ? ` ${m.headers.length} hdr`
            : m.type === 'lsr'
              ? ` ${m.requests.length} req`
              : ` ${m.headers.length} ack`;
    return { proto: 'OSPF', info: `${m.type.toUpperCase()}${extra}${tail}` };
  }
  if (r.proto === 'eigrp') {
    const m = r.msg;
    return {
      proto: 'EIGRP',
      info: `${m.op.toUpperCase()} AS ${m.asn} seq ${m.seq} ack ${m.ack}${m.routes ? ` ${m.routes.length} route(s)` : ''}${tail}`,
    };
  }
  const m = r.msg;
  const extra =
    m.type === 'update'
      ? ` +${m.nlri.length} -${m.withdrawn.length}`
      : m.type === 'open'
        ? ` AS ${m.asn}`
        : '';
  return { proto: 'BGP', info: `${m.type.toUpperCase()}${extra}${tail}` };
}

function summarizeIp6(p: Ipv6Pdu): { proto: ProtoTag; info: string } {
  const tail = ` hl=${p.hopLimit}`;
  const l4 = p.payload;
  if (l4.kind === 'icmp6') {
    const nd = l4.type === 'ns' || l4.type === 'na' || l4.type === 'rs' || l4.type === 'ra';
    const what = nd
      ? `${l4.type.toUpperCase()}${l4.target ? ' ' + l4.target : ''}`
      : l4.orig
        ? `${l4.type} code=${l4.code}`
        : `${l4.type} id=${l4.id} seq=${l4.seq}`;
    return { proto: nd ? 'ND' : 'ICMP6', info: `${what} ${p.src} → ${p.dst}${tail}` };
  }
  if (l4.kind === 'routing') return summarizeRouting(l4, tail);
  if (l4.kind === 'gre') return { proto: 'GRE', info: `${p.src} → ${p.dst}${tail}` };
  const a = l4.kind === 'udp' ? l4.app : undefined;
  if (a?.kind === 'dhcp6')
    return { proto: 'DHCP', info: `DHCPv6 ${a.op.toUpperCase()} xid ${hex(a.xid, 6)}${tail}` };
  if (a?.kind === 'rip')
    return {
      proto: 'RIP',
      info: `RIPng ${a.command} ${a.entries.length} route(s) ${p.src} → ${p.dst}${tail}`,
    };
  if (a?.kind === 'hsrp')
    return {
      proto: 'HSRP',
      info: `group ${a.group} ${a.op} ${a.state} prio ${a.priority} vip ${a.vip}${tail}`,
    };
  return {
    proto: l4.kind === 'tcp' ? 'TCP' : 'UDP',
    info: `[${p.src}]:${l4.srcPort} → [${p.dst}]:${l4.dstPort}${tail}`,
  };
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
  if (l4.kind === 'routing') return summarizeRouting(l4, ` ${p.src} → ${p.dst}${tail}`);
  if (l4.kind === 'esp') {
    return {
      proto: 'ESP',
      info: `${p.src} → ${p.dst} SPI ${hex(l4.spi, 8)} seq ${l4.seq} (encrypted)${tail}`,
    };
  }
  if (l4.kind === 'gre') {
    const inner =
      l4.inner.kind === 'ipv4' ? summarizeIp(l4.inner).info : summarizeIp6(l4.inner).info;
    return { proto: 'GRE', info: `${p.src} → ${p.dst} [${inner}]${tail}` };
  }
  const a: HttpPdu | SvcPdu | undefined = l4.app;
  if (a?.kind === 'svc') {
    return {
      proto: SVC_TAG[a.proto],
      info: `${p.src}:${l4.srcPort} → ${p.dst}:${l4.dstPort} [${tcpFlags(l4)}] ${a.op}${tail}`,
    };
  }
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
  if (a?.kind === 'rip') {
    return {
      proto: 'RIP',
      info: `${a.command} ${a.entries.length} route(s) ${p.src} → ${p.dst}${tail}`,
    };
  }
  if (a?.kind === 'svc') {
    return {
      proto: SVC_TAG[a.proto],
      info: `${a.op} ${p.src}:${u.srcPort} → ${p.dst}:${u.dstPort}${tail}`,
    };
  }
  if (a?.kind === 'ike') {
    return {
      proto: 'IKE',
      info: `${a.op.toUpperCase()} ${p.src}:${u.srcPort} → ${p.dst}:${u.dstPort}${a.reason ? ' (' + a.reason + ')' : ''}${tail}`,
    };
  }
  if (a?.kind === 'hsrp') {
    return {
      proto: 'HSRP',
      info: `group ${a.group} ${a.op} ${a.state} prio ${a.priority} vip ${a.vip}${tail}`,
    };
  }
  return { proto: 'UDP', info: `${p.src}:${u.srcPort} → ${p.dst}:${u.dstPort}${tail}` };
}
