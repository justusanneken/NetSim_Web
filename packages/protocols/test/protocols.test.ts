import { describe, expect, it } from 'vitest';
import type { Frame, Ipv6Pdu, OspfMsg } from '../src';
import {
  isLinkLocalIpv6,
  isMulticastIpv4,
  isMulticastIpv6,
  isValidIpv6,
  ipv6Network,
  linkLocalFromMac,
  multicastMacV4,
  multicastMacV6,
  normalizeIpv6,
  sameIpv6Prefix,
  slaacAddress,
  solicitedNode,
  BROADCAST_MAC,
  ETHERTYPE,
  IP_PROTO,
  broadcastAddress,
  clonePdu,
  describeFrame,
  describePdu,
  formatIpv4,
  isBroadcastMac,
  isMulticastMac,
  isValidIpv4,
  layersOf,
  macFromCounter,
  maskToPrefix,
  parseIpv4,
  pduSize,
  prefixToMask,
  sameSubnet,
  summarizeFrame,
  type EthernetPdu,
  type Ipv4Pdu,
} from '../src';

const arpReq: EthernetPdu = {
  kind: 'ethernet',
  dst: BROADCAST_MAC,
  src: '02:00:00:00:00:01',
  etherType: ETHERTYPE.arp,
  payload: {
    kind: 'arp',
    op: 'request',
    senderMac: '02:00:00:00:00:01',
    senderIp: '10.0.0.1',
    targetMac: '00:00:00:00:00:00',
    targetIp: '10.0.0.2',
  },
};
const ping: EthernetPdu = {
  kind: 'ethernet',
  dst: '02:00:00:00:00:02',
  src: '02:00:00:00:00:01',
  etherType: ETHERTYPE.ipv4,
  payload: {
    kind: 'ipv4',
    src: '10.0.0.1',
    dst: '10.0.0.2',
    ttl: 128,
    protocol: IP_PROTO.icmp,
    id: 7,
    df: false,
    mf: false,
    fragOffset: 0,
    payload: { kind: 'icmp', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 32 },
  },
};

describe('addr', () => {
  it('parst und formatiert IPv4', () => {
    expect(parseIpv4('192.168.1.10')).toBe(0xc0a8010a);
    expect(formatIpv4(0xc0a8010a)).toBe('192.168.1.10');
    expect(parseIpv4('256.1.1.1')).toBeUndefined();
    expect(parseIpv4('1.2.3')).toBeUndefined();
    expect(isValidIpv4('10.0.0.1')).toBe(true);
    expect(isValidIpv4('abc')).toBe(false);
  });
  it('Masken', () => {
    expect(maskToPrefix('255.255.255.0')).toBe(24);
    expect(maskToPrefix('0.0.0.0')).toBe(0);
    expect(maskToPrefix('255.0.255.0')).toBeUndefined();
    expect(maskToPrefix('x')).toBeUndefined();
    expect(prefixToMask(26)).toBe('255.255.255.192');
    expect(prefixToMask(0)).toBe('0.0.0.0');
  });
  it('Subnetz und Broadcast', () => {
    expect(sameSubnet('10.0.0.1', '10.0.0.200', '255.255.255.0')).toBe(true);
    expect(sameSubnet('10.0.0.1', '10.0.1.1', '255.255.255.0')).toBe(false);
    expect(sameSubnet('x', '10.0.1.1', '255.255.255.0')).toBe(false);
    expect(broadcastAddress('10.0.0.1', '255.255.255.0')).toBe('10.0.0.255');
    expect(broadcastAddress('x', '255.255.255.0')).toBeUndefined();
  });
  it('MAC-Hilfen', () => {
    expect(isBroadcastMac(BROADCAST_MAC)).toBe(true);
    expect(isMulticastMac('01:00:5e:00:00:05')).toBe(true);
    expect(isMulticastMac('02:00:00:00:00:01')).toBe(false);
    expect(macFromCounter(0x010203)).toBe('02:00:00:01:02:03');
  });
});

describe('pdu', () => {
  it('berechnet Größen (Minimalframe 64 Byte)', () => {
    expect(pduSize(arpReq)).toBe(64);
    expect(pduSize(ping)).toBe(14 + 20 + 8 + 32 + 4);
  });
  it('clone ist tief', () => {
    const c = clonePdu(ping);
    expect(c).toEqual(ping);
    (c.payload as { ttl: number }).ttl = 1;
    expect((ping.payload as { ttl: number }).ttl).toBe(128);
  });
  it('Schichten und Beschreibung', () => {
    expect(layersOf(ping).map((l) => l.kind)).toEqual(['ethernet', 'ipv4', 'icmp']);
    expect(layersOf(arpReq).map((l) => l.kind)).toEqual(['ethernet', 'arp']);
    const v = describeFrame(ping);
    expect(v.map((l) => l.osi)).toEqual([2, 3, 3]);
    expect(v[1]?.fields.find((f) => f.name === 'TTL')?.value).toBe('128');
    expect(describePdu(arpReq)).toHaveLength(3);
    expect(describePdu(arpReq.payload)[0]?.value).toContain('request');
    const ip = ping.payload as Ipv4Pdu;
    const reply = { ...ip.payload, type: 'echo-reply' as const };
    expect(describePdu(reply)[0]?.value).toContain('reply');
  });
  it('Fragmente und ICMP-Fehler', () => {
    const ip = ping.payload as Ipv4Pdu;
    const frag: Ipv4Pdu = { ...ip, mf: true, fragOffset: 185, dataLen: 1480 };
    expect(pduSize(frag)).toBe(1500);
    expect(summarizeFrame({ ...ping, payload: frag }).info).toContain('frag@1480+');
    const err: Ipv4Pdu = {
      ...ip,
      payload: {
        kind: 'icmp',
        type: 'dest-unreachable',
        code: 4,
        id: 0,
        seq: 0,
        dataSize: 28,
        nextHopMtu: 1400,
        orig: { src: '10.0.0.1', dst: '10.0.0.2', ipId: 7, protocol: 1, icmpId: 1, icmpSeq: 1 },
      },
    };
    const f = describePdu(err.payload);
    expect(f.map((x) => x.name)).toEqual(['Type', 'Code', 'Original', 'Next-Hop MTU', 'Data']);
    expect(summarizeFrame({ ...ping, payload: err }).info).toContain('code=4');
  });

  it('Neue PDUs: VLAN-Tag, UDP/DHCP, TCP/HTTP, DNS, BPDU, VTP', () => {
    const ip = ping.payload as Ipv4Pdu;
    const tagged: EthernetPdu = { ...ping, vlan: { vid: 10, pcp: 0 } };
    expect(pduSize(tagged)).toBe(pduSize(ping) + 4);
    expect(describeFrame(tagged)[0]?.fields.some((x) => x.name === '802.1Q VLAN')).toBe(true);
    const dhcp = {
      kind: 'dhcp' as const,
      op: 'offer' as const,
      xid: 0xabcd,
      chaddr: '02:00:00:00:00:09',
      ciaddr: '0.0.0.0',
      yiaddr: '10.0.0.9',
      siaddr: '10.0.0.1',
      giaddr: '0.0.0.0',
      options: {
        mask: '255.255.255.0',
        router: '10.0.0.1',
        dns: ['10.0.0.2'],
        domain: 'lan',
        leaseSec: 86400,
        serverId: '10.0.0.1',
        requestedIp: '10.0.0.9',
        tftp: 'tftp.lan',
      },
    };
    const udp: Ipv4Pdu = {
      ...ip,
      payload: { kind: 'udp', srcPort: 67, dstPort: 68, dataSize: 0, app: dhcp },
    };
    const fr: EthernetPdu = { ...ping, payload: udp };
    expect(summarizeFrame(fr).proto).toBe('DHCP');
    expect(layersOf(fr).map((l) => l.kind)).toEqual(['ethernet', 'ipv4', 'udp', 'dhcp']);
    expect(describeFrame(fr).map((l) => l.osi)).toEqual([2, 3, 4, 7]);
    expect(describePdu(dhcp).length).toBeGreaterThan(10);
    expect(pduSize(fr)).toBeGreaterThan(300);
    const dns = {
      kind: 'dns' as const,
      id: 7,
      response: true,
      rcode: 0 as const,
      question: { name: 'a.lan', type: 'A' as const },
      answers: [{ name: 'a.lan', type: 'A' as const, data: '10.0.0.5', ttl: 60 }],
    };
    const dfr: EthernetPdu = {
      ...ping,
      payload: {
        ...ip,
        payload: { kind: 'udp', srcPort: 53, dstPort: 5000, dataSize: 0, app: dns },
      },
    };
    expect(summarizeFrame(dfr).proto).toBe('DNS');
    expect(describePdu(dns).some((x) => x.name === 'Answer')).toBe(true);
    expect(describePdu({ ...dns, response: false })).toHaveLength(4);
    const plain: EthernetPdu = {
      ...ping,
      payload: { ...ip, payload: { kind: 'udp', srcPort: 1, dstPort: 2, dataSize: 10 } },
    };
    expect(summarizeFrame(plain).proto).toBe('UDP');
    expect(pduSize(plain)).toBe(64);
    const http = { kind: 'http' as const, method: 'GET' as const, path: '/', host: 'a.lan' };
    const tcp: EthernetPdu = {
      ...ping,
      payload: {
        ...ip,
        payload: {
          kind: 'tcp',
          srcPort: 4000,
          dstPort: 80,
          flags: { syn: false, ack: true, fin: false, rst: false, psh: true },
          seq: 1,
          ack: 1,
          window: 8192,
          dataSize: 0,
          app: http,
        },
      },
    };
    expect(summarizeFrame(tcp)).toMatchObject({ proto: 'HTTP' });
    expect(describePdu(http)).toHaveLength(2);
    expect(describePdu({ kind: 'http', status: 200, body: 'hi' })).toHaveLength(2);
    const syn: EthernetPdu = {
      ...ping,
      payload: {
        ...ip,
        payload: {
          kind: 'tcp',
          srcPort: 4000,
          dstPort: 80,
          flags: { syn: true, ack: false, fin: false, rst: false, psh: false },
          seq: 1,
          ack: 0,
          window: 8192,
          dataSize: 0,
        },
      },
    };
    expect(summarizeFrame(syn).proto).toBe('TCP');
    expect(describeFrame(syn)[2]?.fields.find((x) => x.name === 'Flags')?.value).toBe('SYN');
    const bpdu = {
      kind: 'bpdu' as const,
      rstp: true,
      vlan: 1,
      rootId: '32769.02:00:00:00:00:01',
      rootCost: 4,
      bridgeId: '32769.02:00:00:00:00:02',
      portId: '128.1',
      flags: {
        proposal: true,
        agreement: false,
        topologyChange: false,
        role: 'designated' as const,
      },
    };
    const bf: EthernetPdu = { ...ping, payload: bpdu };
    expect(summarizeFrame(bf).proto).toBe('STP');
    expect(describePdu(bpdu)).toHaveLength(10);
    const vtp = {
      kind: 'vtp' as const,
      domain: 'lab',
      revision: 3,
      vlans: [{ id: 10, name: 'A' }],
    };
    expect(summarizeFrame({ ...ping, payload: vtp }).proto).toBe('VTP');
    expect(describePdu(vtp)).toHaveLength(3);
    expect(pduSize(vtp)).toBe(52);
  });

  it('Zusammenfassung', () => {
    expect(summarizeFrame(arpReq)).toEqual({
      proto: 'ARP',
      info: 'Who has 10.0.0.2? Tell 10.0.0.1',
    });
    const rep: EthernetPdu = {
      ...arpReq,
      payload: { ...(arpReq.payload as object), op: 'reply' } as EthernetPdu['payload'],
    };
    expect(summarizeFrame(rep).info).toContain('is at');
    expect(summarizeFrame(ping).proto).toBe('ICMP');
  });
});

describe('IPv6-Adressen (Phase 4)', () => {
  it('parst und formatiert kanonisch', () => {
    expect(normalizeIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeIpv6('FE80::1')).toBe('fe80::1');
    expect(normalizeIpv6('::')).toBe('::');
    expect(normalizeIpv6('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8');
    expect(isValidIpv6('2001:db8:::1')).toBe(false);
    expect(isValidIpv6('12345::1')).toBe(false);
    expect(isValidIpv6('1:2:3')).toBe(false);
  });

  it('Präfix, EUI-64, Link-Local, Multicast-MAC', () => {
    expect(ipv6Network('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 64)).toBe('2001:db8:1:2::');
    expect(sameIpv6Prefix('2001:db8::1', '2001:db8::ffff', 64)).toBe(true);
    expect(linkLocalFromMac('00:11:22:33:44:55')).toBe('fe80::211:22ff:fe33:4455');
    expect(slaacAddress('2001:db8:1:1::', '00:11:22:33:44:55')).toBe(
      '2001:db8:1:1:211:22ff:fe33:4455',
    );
    expect(multicastMacV6('ff02::5')).toBe('33:33:00:00:00:05');
    expect(solicitedNode('2001:db8::211:22ff:fe33:4455')).toBe('ff02::1:ff33:4455');
    expect(multicastMacV4('224.0.0.5')).toBe('01:00:5e:00:00:05');
    expect(isMulticastIpv4('224.0.0.9')).toBe(true);
    expect(isMulticastIpv6('ff02::1')).toBe(true);
    expect(isLinkLocalIpv6('fe80::1')).toBe(true);
  });
});

describe('Routing-PDUs (Phase 4): Größe, Beschreibung, Zusammenfassung', () => {
  const eth = (payload: Frame['payload'], etherType = 0x0800): Frame => ({
    kind: 'ethernet',
    src: '02:00:00:00:00:01',
    dst: '01:00:5e:00:00:05',
    etherType,
    payload,
  });
  const ip4 = (payload: Ipv4Pdu['payload'], protocol: number): Ipv4Pdu => ({
    kind: 'ipv4',
    src: '10.0.0.1',
    dst: '224.0.0.5',
    ttl: 1,
    protocol,
    id: 1,
    df: false,
    mf: false,
    fragOffset: 0,
    payload,
  });
  const hdr = { type: 1 as const, id: '1.1.1.1', advRouter: '1.1.1.1', seq: 0x80000001, age: 1 };
  const base = { routerId: '1.1.1.1', areaId: '0' };
  const ospf = (msg: OspfMsg): Ipv4Pdu => ip4({ kind: 'routing', proto: 'ospf', v: 2, msg }, 89);

  it('OSPF: alle fünf Pakettypen', () => {
    const msgs: OspfMsg[] = [
      {
        type: 'hello',
        ...base,
        helloSec: 10,
        deadSec: 40,
        priority: 1,
        dr: '0.0.0.0',
        bdr: '0.0.0.0',
        neighbors: ['2.2.2.2'],
      },
      { type: 'dbd', ...base, init: true, more: false, master: true, ddSeq: 1, headers: [hdr] },
      { type: 'lsr', ...base, requests: [{ type: 1, id: '1.1.1.1', advRouter: '1.1.1.1' }] },
      {
        type: 'lsu',
        ...base,
        lsas: [
          {
            ...hdr,
            body: {
              type: 1,
              abr: false,
              asbr: false,
              links: [{ kind: 'stub', prefix: '10.0.0.0', plen: 24, cost: 1 }],
            },
          },
          {
            ...hdr,
            type: 2,
            body: { type: 2, prefix: '10.0.0.0', plen: 24, attached: ['1.1.1.1'] },
          },
          {
            ...hdr,
            type: 5,
            body: { type: 5, prefix: '1.0.0.0', plen: 8, metric: 20, eType: 2, tag: 0 },
          },
        ],
      },
      { type: 'lsack', ...base, headers: [hdr] },
    ];
    for (const m of msgs) {
      const f = eth(ospf(m));
      expect(pduSize(f)).toBeGreaterThan(64);
      expect(summarizeFrame(f).proto).toBe('OSPF');
      const layers = describeFrame(f);
      expect(layers.map((l) => l.name)).toContain('Routing');
      expect(layers.flatMap((l) => l.fields).some((x) => x.name === 'Router ID')).toBe(true);
    }
  });

  it('EIGRP, BGP, RIP, HSRP', () => {
    const eigrp = ip4(
      {
        kind: 'routing',
        proto: 'eigrp',
        msg: {
          op: 'update',
          asn: 100,
          routerId: '1.1.1.1',
          holdSec: 15,
          seq: 1,
          ack: 0,
          routes: [
            {
              prefix: '10.0.0.0',
              plen: 24,
              delay: 10,
              bandwidth: 100000,
              hops: 1,
              unreachable: true,
            },
          ],
        },
      },
      88,
    );
    expect(summarizeFrame(eth(eigrp)).proto).toBe('EIGRP');
    expect(
      describeFrame(eth(eigrp))
        .flatMap((l) => l.fields)
        .some((x) => x.name === 'Route'),
    ).toBe(true);
    const bgpMsgs = [
      { type: 'open' as const, asn: 65001, holdSec: 180, routerId: '1.1.1.1' },
      { type: 'keepalive' as const },
      {
        type: 'update' as const,
        withdrawn: [{ prefix: '1.0.0.0', plen: 8 }],
        attrs: {
          origin: 'igp' as const,
          asPath: [100, 200],
          nextHop: '10.0.0.1',
          med: 5,
          localPref: 100,
        },
        nlri: [{ prefix: '10.0.0.0', plen: 24 }],
      },
      { type: 'notification' as const, code: 6, text: 'cease' },
    ];
    for (const msg of bgpMsgs) {
      const f = eth(ip4({ kind: 'routing', proto: 'bgp', sport: 40000, dport: 179, msg }, 6));
      expect(summarizeFrame(f).proto).toBe('BGP');
      expect(pduSize(f)).toBeGreaterThan(0);
      expect(describeFrame(f).length).toBeGreaterThan(1);
    }
    const rip = ip4(
      {
        kind: 'udp',
        srcPort: 520,
        dstPort: 520,
        dataSize: 0,
        app: {
          kind: 'rip',
          command: 'response',
          entries: [
            { prefix: '10.0.0.0', mask: '255.255.255.0', nextHop: '0.0.0.0', metric: 1, tag: 0 },
          ],
        },
      },
      17,
    );
    expect(summarizeFrame(eth(rip)).proto).toBe('RIP');
    expect(
      describeFrame(eth(rip))
        .flatMap((l) => l.fields)
        .some((x) => x.name === 'Route'),
    ).toBe(true);
    const hsrp = ip4(
      {
        kind: 'udp',
        srcPort: 1985,
        dstPort: 1985,
        dataSize: 0,
        app: {
          kind: 'hsrp',
          group: 1,
          op: 'hello',
          state: 'active',
          helloSec: 3,
          holdSec: 10,
          priority: 100,
          vip: '10.0.0.254',
        },
      },
      17,
    );
    expect(summarizeFrame(eth(hsrp)).proto).toBe('HSRP');
    expect(
      describeFrame(eth(hsrp))
        .flatMap((l) => l.fields)
        .some((x) => x.name === 'Virtual IP'),
    ).toBe(true);
  });

  it('GRE kapselt IPv4; IPv6 mit ICMPv6 und Neighbor Discovery', () => {
    const inner = ip4(
      { kind: 'icmp', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 32 },
      1,
    );
    const gre = ip4({ kind: 'gre', protocolType: 0x0800, inner }, 47);
    const fg = eth(gre);
    expect(summarizeFrame(fg).proto).toBe('GRE');
    expect(pduSize(fg)).toBeGreaterThan(pduSize(eth(inner)) - 14);
    expect(describeFrame(fg).map((l) => l.name)).toEqual(
      expect.arrayContaining(['IPv4', 'GRE', 'ICMP']),
    );

    const ip6 = (payload: Ipv6Pdu['payload']): Ipv6Pdu => ({
      kind: 'ipv6',
      src: 'fe80::1',
      dst: 'ff02::1',
      hopLimit: 255,
      nextHeader: 58,
      payload,
    });
    const echo = eth(
      ip6({ kind: 'icmp6', type: 'echo-request', code: 0, id: 1, seq: 2, dataSize: 32 }),
      0x86dd,
    );
    expect(summarizeFrame(echo)).toMatchObject({ proto: 'ICMP6' });
    const ns = eth(
      ip6({
        kind: 'icmp6',
        type: 'ns',
        code: 0,
        id: 0,
        seq: 0,
        dataSize: 0,
        target: 'fe80::2',
        lladdr: '02:00:00:00:00:02',
      }),
      0x86dd,
    );
    expect(summarizeFrame(ns).proto).toBe('ND');
    const na = eth(
      ip6({
        kind: 'icmp6',
        type: 'na',
        code: 0,
        id: 0,
        seq: 0,
        dataSize: 0,
        target: 'fe80::2',
        naFlags: { router: true, solicited: true, override: true },
      }),
      0x86dd,
    );
    expect(
      describeFrame(na)
        .flatMap((l) => l.fields)
        .some((x) => x.name === 'Flags'),
    ).toBe(true);
    const ra = eth(
      ip6({
        kind: 'icmp6',
        type: 'ra',
        code: 0,
        id: 0,
        seq: 0,
        dataSize: 0,
        prefixes: [{ prefix: '2001:db8::', plen: 64, onLink: true, autonomous: true }],
        routerLifetime: 1800,
      }),
      0x86dd,
    );
    expect(pduSize(ra)).toBeGreaterThan(64);
    expect(
      describeFrame(ra)
        .flatMap((l) => l.fields)
        .some((x) => x.name === 'Prefix'),
    ).toBe(true);
    const err = eth(
      ip6({
        kind: 'icmp6',
        type: 'dest-unreachable',
        code: 0,
        id: 1,
        seq: 1,
        dataSize: 40,
        orig: { src: 'a::1', dst: 'b::1' },
      }),
      0x86dd,
    );
    expect(summarizeFrame(err).info).toContain('dest-unreachable');
    const udp6 = eth(ip6({ kind: 'udp', srcPort: 1, dstPort: 2, dataSize: 10 }), 0x86dd);
    expect(summarizeFrame(udp6).proto).toBe('UDP');
    const ospf3 = eth(
      ip6({ kind: 'routing', proto: 'ospf', v: 3, msg: { type: 'lsack', ...base, headers: [] } }),
      0x86dd,
    );
    expect(summarizeFrame(ospf3).proto).toBe('OSPF');
    const gre6 = eth(
      ip6({
        kind: 'gre',
        protocolType: 0x86dd,
        inner: ip6({ kind: 'icmp6', type: 'echo-reply', code: 0, id: 1, seq: 1, dataSize: 8 }),
      }),
      0x86dd,
    );
    expect(summarizeFrame(gre6).proto).toBe('GRE');
  });
});

describe('Phase 5: svc-Anwendungsnachricht', () => {
  const svc = {
    kind: 'svc' as const,
    proto: 'tftp' as const,
    op: 'wrq',
    args: { file: 'r1-confg', pass: 'geheim' },
    body: 'hostname R1',
  };
  const mkIp = (payload: Ipv4Pdu['payload']): Frame => ({
    kind: 'ethernet',
    src: 'aa:aa:aa:aa:aa:01',
    dst: 'aa:aa:aa:aa:aa:02',
    etherType: 0x0800,
    payload: {
      kind: 'ipv4',
      src: '10.0.0.1',
      dst: '10.0.0.2',
      ttl: 64,
      protocol: 17,
      id: 1,
      df: false,
      mf: false,
      fragOffset: 0,
      payload,
    },
  });

  it('Größe, Felder (Geheimnisse maskiert), Schichten und Tags für UDP und TCP', () => {
    const udp = mkIp({ kind: 'udp', srcPort: 50000, dstPort: 69, dataSize: 0, app: svc });
    expect(pduSize(svc)).toBeGreaterThan(24 + 'hostname R1'.length);
    const fields = describePdu(svc);
    expect(fields.find((f) => f.name === 'pass')?.value).toBe('********');
    expect(fields.find((f) => f.name === 'file')?.value).toBe('r1-confg');
    expect(describeFrame(udp).map((l) => l.name)).toContain('Application');
    expect(summarizeFrame(udp)).toMatchObject({ proto: 'TFTP' });
    const tcp = mkIp({
      kind: 'tcp',
      srcPort: 50000,
      dstPort: 23,
      flags: { syn: false, ack: true, fin: false, rst: false, psh: true },
      seq: 1,
      ack: 1,
      window: 8192,
      dataSize: 0,
      app: { ...svc, proto: 'telnet', op: 'login' },
    });
    expect(summarizeFrame(tcp)).toMatchObject({ proto: 'TELNET' });
    expect(describePdu({ ...svc, body: undefined }).some((f) => f.name === 'Data')).toBe(false);
  });
});
