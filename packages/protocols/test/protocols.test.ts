import { describe, expect, it } from 'vitest';
import {
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
