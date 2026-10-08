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
