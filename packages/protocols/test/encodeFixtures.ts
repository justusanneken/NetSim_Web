import type {
  AppPdu,
  EthernetPdu,
  Icmp6Pdu,
  IcmpPdu,
  Ip6Payload,
  IpPayload,
  Ipv4Pdu,
  Ipv6Pdu,
  OspfLsa,
  OspfMsg,
  PppMsg,
  SvcPdu,
  TcpFlags,
} from '../src';

const MAC_A = '02:00:00:00:00:01';
const MAC_B = '02:00:00:00:00:02';
const flags = (o: Partial<TcpFlags> = {}): TcpFlags => ({
  syn: false,
  ack: false,
  fin: false,
  rst: false,
  psh: false,
  ...o,
});

export const ipv4 = (payload: IpPayload, protocol: number, o: Partial<Ipv4Pdu> = {}): Ipv4Pdu => ({
  kind: 'ipv4',
  src: '10.0.0.1',
  dst: '10.0.0.2',
  ttl: 64,
  protocol,
  id: 7,
  df: false,
  mf: false,
  fragOffset: 0,
  payload,
  ...o,
});
export const ipv6 = (
  payload: Ip6Payload,
  nextHeader: number,
  o: Partial<Ipv6Pdu> = {},
): Ipv6Pdu => ({
  kind: 'ipv6',
  src: '2001:db8::1',
  dst: '2001:db8::2',
  hopLimit: 64,
  nextHeader,
  payload,
  ...o,
});
const eth4 = (p: Ipv4Pdu, dst = MAC_B): EthernetPdu => ({
  kind: 'ethernet',
  dst,
  src: MAC_A,
  etherType: 0x0800,
  payload: p,
});
const eth6 = (p: Ipv6Pdu, dst = MAC_B): EthernetPdu => ({
  kind: 'ethernet',
  dst,
  src: MAC_A,
  etherType: 0x86dd,
  payload: p,
});
const udp4 = (app: AppPdu | undefined, sport: number, dport: number, dataSize = 0): EthernetPdu =>
  eth4(ipv4({ kind: 'udp', srcPort: sport, dstPort: dport, dataSize, app }, 17));
const svcUdp = (
  proto: SvcPdu['proto'],
  op: string,
  port: number,
  args: SvcPdu['args'] = {},
  body?: string,
) => udp4({ kind: 'svc', proto, op, args, body }, 50000, port);
const svcTcp = (
  proto: SvcPdu['proto'],
  op: string,
  port: number,
  args: SvcPdu['args'] = {},
  body?: string,
  enc = false,
) =>
  eth4(
    ipv4(
      {
        kind: 'tcp',
        srcPort: 50000,
        dstPort: port,
        flags: flags({ ack: true, psh: true }),
        seq: 11,
        ack: 22,
        window: 4096,
        dataSize: 0,
        app: { kind: 'svc', proto, op, args, body, encrypted: enc },
      },
      6,
    ),
  );

const lsa = (body: OspfLsa['body'], seq = 1): OspfLsa => ({
  type: body.type,
  id: '1.1.1.1',
  advRouter: '1.1.1.1',
  seq,
  age: 3,
  body,
});

const ospfMsgs = (): OspfMsg[] => {
  const base = { routerId: '1.1.1.1', areaId: '0.0.0.1' };
  const hdr = { type: 1 as const, id: '1.1.1.1', advRouter: '1.1.1.1', seq: 2, age: 9 };
  return [
    {
      type: 'hello',
      ...base,
      helloSec: 10,
      deadSec: 40,
      priority: 1,
      dr: '0.0.0.0',
      bdr: '',
      neighbors: [],
    },
    {
      type: 'hello',
      ...base,
      auth: { type: 'md5', keyId: 1, digest: 'abc' },
      helloSec: 10,
      deadSec: 40,
      priority: 1,
      dr: '10.0.0.1',
      bdr: '10.0.0.2',
      neighbors: ['2.2.2.2', '3.3.3.3'],
      areaType: 'stub',
    },
    {
      type: 'hello',
      ...base,
      auth: { type: 'simple', key: 'k' },
      helloSec: 10,
      deadSec: 40,
      priority: 1,
      dr: '10.0.0.1',
      bdr: '10.0.0.2',
      neighbors: [],
      areaType: 'nssa',
    },
    { type: 'dbd', ...base, init: true, more: true, master: true, ddSeq: 5, headers: [hdr] },
    { type: 'lsr', ...base, requests: [{ type: 1, id: '1.1.1.1', advRouter: '1.1.1.1' }] },
    {
      type: 'lsu',
      ...base,
      lsas: [
        lsa({
          type: 1,
          abr: true,
          asbr: true,
          links: [
            { kind: 'p2p', neighbor: '2.2.2.2', addr: '10.0.0.1', cost: 10 },
            { kind: 'transit', neighbor: '10.0.1.1', addr: '10.0.1.2', cost: 1 },
            { kind: 'stub', prefix: '10.9.0.0', plen: 24, cost: 1 },
          ],
        }),
        lsa({ type: 2, prefix: '10.0.1.0', plen: 24, attached: ['1.1.1.1', '2.2.2.2'] }),
        lsa({ type: 3, prefix: '10.5.0.0', plen: 16, metric: 20 }),
        lsa({ type: 4, asbr: '9.9.9.9', metric: 5 }),
        lsa({
          type: 5,
          prefix: '172.16.0.0',
          plen: 12,
          metric: 20,
          eType: 2,
          fwd: '10.0.0.9',
          tag: 7,
        }),
        lsa({ type: 7, prefix: '172.17.0.0', plen: 16, metric: 20, eType: 1, tag: 0, p: true }),
      ],
    },
    { type: 'lsack', ...base, headers: [hdr] },
  ];
};

const pppMsgs = (): PppMsg[] => [
  { proto: 'lcp', op: 'conf-req', mru: 1492, auth: 'chap', magic: 0x1234 },
  { proto: 'lcp', op: 'conf-ack', mru: 1492, magic: 0x1234 },
  { proto: 'lcp', op: 'term-req', mru: 0, magic: 0 },
  { proto: 'chap', op: 'challenge', id: 1, value: 'abcdef', name: 'bras' },
  { proto: 'chap', op: 'success', id: 1 },
  { proto: 'ipcp', op: 'conf-req', addr: '0.0.0.0' },
  {
    proto: 'ip',
    inner: ipv4({ kind: 'icmp', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 4 }, 1),
  },
];

const icmpTypes = (): IcmpPdu[] => [
  { kind: 'icmp', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 32 },
  { kind: 'icmp', type: 'echo-reply', code: 0, id: 1, seq: 1, dataSize: 32 },
  {
    kind: 'icmp',
    type: 'time-exceeded',
    code: 0,
    id: 0,
    seq: 0,
    dataSize: 0,
    orig: { src: '10.0.0.1', dst: '10.9.9.9', ipId: 3, protocol: 1, icmpId: 1, icmpSeq: 2 },
  },
  {
    kind: 'icmp',
    type: 'dest-unreachable',
    code: 3,
    id: 0,
    seq: 0,
    dataSize: 0,
    orig: {
      src: '10.0.0.1',
      dst: '10.9.9.9',
      ipId: 3,
      protocol: 17,
      icmpId: 0,
      icmpSeq: 0,
      sport: 5,
      dport: 6,
    },
  },
];

const icmp6Types = (): Icmp6Pdu[] => {
  const o = { code: 0, id: 1, seq: 1, dataSize: 0 };
  return [
    { kind: 'icmp6', type: 'echo-request', ...o, dataSize: 16 },
    { kind: 'icmp6', type: 'echo-reply', ...o, dataSize: 16 },
    { kind: 'icmp6', type: 'ns', ...o, target: 'fe80::2', lladdr: MAC_A },
    {
      kind: 'icmp6',
      type: 'na',
      ...o,
      target: 'fe80::2',
      lladdr: MAC_B,
      naFlags: { router: true, solicited: true, override: true },
    },
    { kind: 'icmp6', type: 'rs', ...o, lladdr: MAC_A },
    {
      kind: 'icmp6',
      type: 'ra',
      ...o,
      lladdr: MAC_B,
      raFlags: { managed: true, other: true },
      routerLifetime: 1800,
      prefixes: [{ prefix: '2001:db8:1::', plen: 64, onLink: true, autonomous: true }],
    },
    {
      kind: 'icmp6',
      type: 'time-exceeded',
      ...o,
      orig: { src: '2001:db8::1', dst: '2001:db8::9' },
    },
    {
      kind: 'icmp6',
      type: 'dest-unreachable',
      ...o,
      code: 4,
      orig: { src: '2001:db8::1', dst: '2001:db8::9' },
    },
  ];
};

/** Repräsentative Frames aller unterstützten Protokolle (Smoke-Test, PCAP-Gegenprobe mit Scapy/Wireshark). */
export function allFrames(): EthernetPdu[] {
  const out: EthernetPdu[] = [];
  out.push({
    kind: 'ethernet',
    dst: 'ff:ff:ff:ff:ff:ff',
    src: MAC_A,
    etherType: 0x0806,
    vlan: { vid: 20, pcp: 3 },
    payload: {
      kind: 'arp',
      op: 'reply',
      senderMac: MAC_A,
      senderIp: '10.0.0.1',
      targetMac: MAC_B,
      targetIp: '10.0.0.2',
    },
  });
  for (const i of icmpTypes()) out.push(eth4(ipv4(i, 1)));
  out.push(eth4(ipv4(icmpTypes()[0] as IcmpPdu, 1, { mf: true, fragOffset: 0, dataLen: 24 })));
  for (const i of icmp6Types()) out.push(eth6(ipv6(i, 58)));

  // TCP + HTTP
  out.push(
    eth4(
      ipv4(
        {
          kind: 'tcp',
          srcPort: 50000,
          dstPort: 80,
          flags: flags({ syn: true }),
          seq: 100,
          ack: 0,
          window: 8192,
          dataSize: 0,
        },
        6,
      ),
    ),
    eth4(
      ipv4(
        {
          kind: 'tcp',
          srcPort: 50000,
          dstPort: 80,
          flags: flags({ ack: true, psh: true }),
          seq: 101,
          ack: 1,
          window: 8192,
          dataSize: 0,
          app: { kind: 'http', method: 'GET', path: '/index.html', host: 'www.test' },
        },
        6,
      ),
    ),
    eth4(
      ipv4(
        {
          kind: 'tcp',
          srcPort: 80,
          dstPort: 50000,
          flags: flags({ ack: true, psh: true, fin: true }),
          seq: 1,
          ack: 150,
          window: 8192,
          dataSize: 0,
          app: { kind: 'http', status: 404, body: 'nope' },
        },
        6,
      ),
    ),
    eth4(
      ipv4(
        {
          kind: 'tcp',
          srcPort: 80,
          dstPort: 50000,
          flags: flags({ rst: true }),
          seq: 1,
          ack: 0,
          window: 0,
          dataSize: 10,
        },
        6,
      ),
    ),
  );
  out.push(
    eth6(
      ipv6(
        {
          kind: 'tcp',
          srcPort: 1,
          dstPort: 2,
          flags: flags({ syn: true }),
          seq: 1,
          ack: 0,
          window: 100,
          dataSize: 0,
        },
        6,
      ),
    ),
  );
  out.push(eth6(ipv6({ kind: 'udp', srcPort: 1, dstPort: 2, dataSize: 5 }, 17)));

  // DHCP / DNS
  for (const op of ['discover', 'offer', 'request', 'ack', 'nak', 'decline', 'release'] as const)
    out.push(
      udp4(
        {
          kind: 'dhcp',
          op,
          xid: 0xabcdef01,
          chaddr: MAC_A,
          ciaddr: op === 'release' ? '10.0.0.5' : '0.0.0.0',
          yiaddr: op === 'offer' || op === 'ack' ? '10.0.0.5' : '0.0.0.0',
          siaddr: '10.0.0.1',
          giaddr: '0.0.0.0',
          options: {
            mask: '255.255.255.0',
            router: '10.0.0.1',
            dns: ['10.0.0.53', '10.0.0.54'],
            domain: 'lab.local',
            leaseSec: 86400,
            serverId: '10.0.0.1',
            requestedIp: '10.0.0.5',
            tftp: '10.0.0.7',
          },
        },
        op === 'offer' || op === 'ack' || op === 'nak' ? 67 : 68,
        67,
      ),
    );
  for (const op of ['solicit', 'advertise', 'request', 'reply', 'information-request'] as const)
    out.push(
      eth6(
        ipv6(
          {
            kind: 'udp',
            srcPort: 546,
            dstPort: 547,
            dataSize: 0,
            app: {
              kind: 'dhcp6',
              op,
              xid: 0x123456,
              clientId: MAC_A,
              serverId: MAC_B,
              addr: '2001:db8::100',
              plen: 64,
              leaseSec: 3600,
              dns: ['2001:db8::53'],
              domain: 'lab.local',
            },
          },
          17,
        ),
      ),
    );
  const dnsQ = (type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'PTR', data: string) =>
    udp4(
      {
        kind: 'dns',
        id: 9,
        response: true,
        rcode: 0,
        question: { name: 'host.lab.local', type },
        answers: [
          { name: 'host.lab.local', type, data, ttl: 300 },
          { name: 'other.lab.local', type: 'A', data: '10.0.0.77', ttl: 300 },
        ],
      },
      53,
      50000,
    );
  out.push(
    dnsQ('A', '10.0.0.3'),
    dnsQ('AAAA', '2001:db8::3'),
    dnsQ('CNAME', 'real.lab.local'),
    dnsQ('MX', '10 mail.lab.local'),
    dnsQ('PTR', 'host.lab.local'),
  );
  out.push(
    udp4(
      {
        kind: 'dns',
        id: 9,
        response: true,
        rcode: 3,
        question: { name: 'nx.lab.local', type: 'A' },
        answers: [],
      },
      53,
      50000,
    ),
  );

  // RIP / HSRP / IKE
  out.push(
    udp4(
      {
        kind: 'rip',
        command: 'request',
        entries: [{ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '0.0.0.0', metric: 16, tag: 0 }],
      },
      520,
      520,
    ),
    eth6(
      ipv6(
        {
          kind: 'udp',
          srcPort: 521,
          dstPort: 521,
          dataSize: 0,
          app: {
            kind: 'rip',
            ng: true,
            command: 'response',
            entries: [
              { prefix: '2001:db8:5::', mask: '', plen: 64, nextHop: '', metric: 1, tag: 0 },
            ],
          },
        },
        17,
      ),
    ),
  );
  for (const version of [1, 2] as const)
    out.push(
      udp4(
        {
          kind: 'hsrp',
          group: 7,
          op: 'coup',
          state: 'speak',
          helloSec: 3,
          holdSec: 10,
          priority: 110,
          vip: '10.0.0.254',
          version,
        },
        1985,
        1985,
      ),
    );
  out.push(
    udp4(
      {
        kind: 'ike',
        op: 'request',
        cookie: 77,
        encr: 'aes',
        hash: 'sha',
        group: 2,
        authHash: 'ab',
        transform: 'esp-aes',
        selector: { src: '10.0.0.0/24', dst: '10.0.1.0/24' },
        spi: 5,
      },
      500,
      500,
    ),
    udp4(
      {
        kind: 'ike',
        op: 'accept',
        cookie: 77,
        encr: 'aes',
        hash: 'sha',
        group: 2,
        authHash: 'ab',
        transform: 'esp-aes',
        spi: 5,
      },
      500,
      500,
    ),
  );

  // Dienste (Phase 5)
  out.push(
    svcUdp('tftp', 'rrq', 69, { file: 'cfg.txt' }),
    svcUdp('tftp', 'data', 69, { block: 1 }, 'hello'),
    svcUdp('tftp', 'ack', 69, { block: 1 }),
    svcUdp('tftp', 'error', 69, { text: 'File not found' }),
    svcUdp('ntp', 'request', 123),
    svcUdp('ntp', 'reply', 123, { ts: 1700000000000, reply: true }),
    svcUdp('syslog', 'msg', 514, { sev: 3, host: 'R1' }, '%LINK-3-UPDOWN: down'),
    svcUdp('snmp', 'get', 161, { community: 'public', oid: '1.3.6.1.2.1.1.5.0', rid: 4 }),
    svcUdp('snmp', 'response', 161, {
      community: 'public',
      oid: '1.3.6.1.2.1.1.5.0',
      value: 'R1',
      rid: 4,
    }),
    svcUdp('snmp', 'set', 161, { community: 'private', oid: '1.3.6.1.2.1.1.5.0', value: 42 }),
    svcUdp('snmp', 'trap', 162, { community: 'public', version: '1', value: 300 }),
    svcUdp('radius', 'access-request', 1812, { user: 'alice', pass: 'secret', rid: 3 }),
    svcUdp('radius', 'access-accept', 1812),
    svcUdp('radius', 'access-reject', 1812),
    svcUdp('tacacs', 'authen', 49, { user: 'bob' }),
    svcUdp('capwap', 'join', 5246, { name: 'ap1' }),
    svcUdp('iot', 'report', 5683, { v: 21.5 }),
    svcTcp('ftp', 'banner', 21, { text: '220 NetSim FTP server ready' }),
    svcTcp('ftp', 'login', 21, { user: 'a', pass: 'b' }),
    svcTcp('smtp', 'mail', 25, { from: 'a@x', to: 'b@y', subject: 'hi' }, 'body'),
    svcTcp('pop3', 'list', 110),
    svcTcp('telnet', 'data', 23, {}, 'show ver'),
    svcTcp('ssh', 'banner', 22, { text: 'SSH' }, undefined, true),
    svcTcp('ssh', 'data', 22, {}, 'secret', true),
  );
  out.push(
    eth4(
      ipv4(
        {
          kind: 'tcp',
          srcPort: 50000,
          dstPort: 179,
          flags: flags({ ack: true }),
          seq: 1,
          ack: 1,
          window: 1000,
          dataSize: 0,
          app: { kind: 'svc', proto: 'bgp', op: 'x', args: {}, bgp: { type: 'keepalive' } },
        },
        6,
      ),
    ),
  );

  // Routing
  for (const msg of ospfMsgs()) {
    out.push(
      eth4(
        ipv4({ kind: 'routing', proto: 'ospf', v: 2, msg }, 89, { dst: '224.0.0.5', ttl: 1 }),
        '01:00:5e:00:00:05',
      ),
      eth6(
        ipv6({ kind: 'routing', proto: 'ospf', v: 3, msg }, 89, {
          src: 'fe80::1',
          dst: 'ff02::5',
          hopLimit: 1,
        }),
        '33:33:00:00:00:05',
      ),
    );
  }
  const eroute = { prefix: '10.5.0.0', plen: 16, delay: 25000, bandwidth: 256000, hops: 1 };
  for (const msg of [
    { op: 'hello' as const, asn: 100, routerId: '1.1.1.1', holdSec: 15, seq: 0, ack: 0 },
    { op: 'hello' as const, asn: 100, routerId: '1.1.1.1', holdSec: 15, seq: 0, ack: 4 },
    {
      op: 'update' as const,
      asn: 100,
      routerId: '1.1.1.1',
      holdSec: 15,
      seq: 4,
      ack: 0,
      init: true,
      routes: [
        eroute,
        { ...eroute, unreachable: true, external: { proto: 'ospf', router: '9.9.9.9' } },
      ],
    },
    {
      op: 'query' as const,
      asn: 100,
      routerId: '1.1.1.1',
      holdSec: 15,
      seq: 5,
      ack: 0,
      routes: [eroute],
    },
    {
      op: 'reply' as const,
      asn: 100,
      routerId: '1.1.1.1',
      holdSec: 15,
      seq: 6,
      ack: 0,
      routes: [eroute],
    },
    { op: 'ack' as const, asn: 100, routerId: '1.1.1.1', holdSec: 15, seq: 0, ack: 6 },
  ])
    out.push(
      eth4(
        ipv4({ kind: 'routing', proto: 'eigrp', msg }, 88, { dst: '224.0.0.10', ttl: 1 }),
        '01:00:5e:00:00:0a',
      ),
      eth6(
        ipv6({ kind: 'routing', proto: 'eigrp', v: 6, msg }, 88, {
          src: 'fe80::1',
          dst: 'ff02::a',
          hopLimit: 1,
        }),
      ),
    );
  const bgpAttrs = {
    origin: 'incomplete' as const,
    asPath: [65001, 65002],
    nextHop: '10.0.0.1',
    med: 10,
    localPref: 200,
    communities: ['65001:100', 'no-export'],
    originatorId: '1.1.1.1',
    clusterList: ['2.2.2.2'],
  };
  for (const msg of [
    { type: 'open' as const, asn: 70000, holdSec: 180, routerId: '1.1.1.1' },
    {
      type: 'update' as const,
      withdrawn: [{ prefix: '10.9.0.0', plen: 16 }],
      attrs: bgpAttrs,
      nlri: [
        { prefix: '10.1.0.0', plen: 24 },
        { prefix: '0.0.0.0', plen: 0 },
      ],
    },
    { type: 'update' as const, withdrawn: [{ prefix: '10.9.0.0', plen: 16 }], nlri: [] },
    { type: 'notification' as const, code: 6, text: 'cease' },
  ])
    out.push(eth4(ipv4({ kind: 'routing', proto: 'bgp', sport: 179, dport: 50000, msg }, 6)));

  // GRE / ESP
  const inner = ipv4(
    { kind: 'icmp', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 8 },
    1,
    { src: '192.168.1.1', dst: '192.168.2.1' },
  );
  out.push(
    eth4(ipv4({ kind: 'gre', protocolType: 0x0800, inner }, 47)),
    eth4(
      ipv4(
        {
          kind: 'gre',
          protocolType: 0x86dd,
          inner: ipv6(
            { kind: 'icmp6', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 4 },
            58,
          ),
        },
        47,
      ),
    ),
    eth4(ipv4({ kind: 'esp', spi: 0x1000, seq: 3, cipher: 'esp-aes', inner }, 50)),
  );

  // Layer 2
  for (const op of ['PADI', 'PADO', 'PADR', 'PADS', 'PADT'] as const)
    out.push({
      kind: 'ethernet',
      dst: 'ff:ff:ff:ff:ff:ff',
      src: MAC_A,
      etherType: 0x8863,
      payload: {
        kind: 'pppoe',
        code: op,
        sessionId: op === 'PADI' ? 0 : 5,
        serviceName: 'isp',
        acName: op === 'PADO' ? 'bras' : undefined,
        hostUniq: 'h1',
      },
    });
  for (const ppp of pppMsgs())
    out.push({
      kind: 'ethernet',
      dst: MAC_B,
      src: MAC_A,
      etherType: 0x8864,
      payload: { kind: 'pppoe', code: 'SESSION', sessionId: 5, ppp },
    });
  out.push({
    kind: 'ethernet',
    dst: MAC_B,
    src: MAC_A,
    etherType: 0x8864,
    payload: { kind: 'pppoe', code: 'SESSION', sessionId: 5 },
  });
  const bpdu = (
    rstp: boolean,
    role: 'root' | 'designated' | 'alternate' | 'unknown',
    dst: string,
    vlan = 1,
  ): EthernetPdu => ({
    kind: 'ethernet',
    dst,
    src: MAC_A,
    etherType: rstp ? 0x0027 : 0x0026,
    payload: {
      kind: 'bpdu',
      rstp,
      vlan,
      rootId: '32769.02:00:00:00:00:01',
      rootCost: 19,
      bridgeId: '32769.02:00:00:00:00:02',
      portId: '128.003',
      flags: { proposal: false, agreement: true, topologyChange: true, role },
    },
  });
  out.push(
    bpdu(false, 'designated', '01:80:c2:00:00:00'),
    bpdu(true, 'root', '01:80:c2:00:00:00'),
    bpdu(true, 'alternate', '01:80:c2:00:00:00'),
    bpdu(true, 'unknown', '01:80:c2:00:00:00'),
    bpdu(false, 'designated', '01:00:0c:cc:cc:cd', 10),
  );
  out.push({
    kind: 'ethernet',
    dst: '01:00:0c:cc:cc:cc',
    src: MAC_A,
    etherType: 0x2003,
    payload: {
      kind: 'vtp',
      domain: 'LAB',
      revision: 4,
      vlans: [
        { id: 1, name: 'default' },
        { id: 10, name: 'Sales' },
      ],
    },
  });
  return out;
}
