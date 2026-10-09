import { describe, expect, it } from 'vitest';
import {
  encodeArp,
  encodeBgp,
  encodeDns,
  encodeFrame,
  encodeHsrp,
  encodeIpv4,
  encodeIpv6,
  encodeLsa,
  encodeOspf,
  encodeRip,
  hexDump,
  inetChecksum,
  lsaChecksum,
  writePcap,
  type EthernetPdu,
  type Ipv4Pdu,
  type Ipv6Pdu,
  type OspfLsa,
  type OspfMsg,
  type TcpFlags,
} from '../src';

const hex = (b: Uint8Array | number[]): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const noFlags: TcpFlags = { syn: false, ack: false, fin: false, rst: false, psh: false };

const ip4 = (payload: Ipv4Pdu['payload'], over: Partial<Ipv4Pdu> = {}): Ipv4Pdu => ({
  kind: 'ipv4',
  src: '192.168.0.1',
  dst: '192.168.0.199',
  ttl: 64,
  protocol: 17,
  id: 0,
  df: true,
  mf: false,
  fragOffset: 0,
  payload,
  ...over,
});

/** Unabhängige Prüfsummenprüfung: Summe über Pseudo-Header + Segment muss 0xffff ergeben. */
function foldsToFFFF(parts: number[][]): boolean {
  let sum = 0;
  for (const p of parts) {
    for (let i = 0; i + 1 < p.length; i += 2) sum += ((p[i] as number) << 8) | (p[i + 1] as number);
    if (p.length % 2) sum += (p[p.length - 1] as number) << 8;
  }
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return sum === 0xffff;
}

describe('encode: IPv4 / ICMP / UDP / TCP', () => {
  it('IPv4-Header: bekannte Prüfsumme (Standard-Beispiel 0xb861)', () => {
    // 4500 0073 0000 4000 4011 b861 c0a8 0001 c0a8 00c7 (UDP, 87 Byte Nutzdaten)
    const b = encodeIpv4(ip4({ kind: 'udp', srcPort: 1, dstPort: 2, dataSize: 87 }));
    expect(hex(b.slice(0, 20))).toBe('4500007300004000401' + '1b861c0a80001c0a800c7');
    expect(b.length).toBe(0x73);
    expect(inetChecksum(b.slice(0, 20))).toBe(0);
  });

  it('ICMP-Echo-Request ohne Daten: 08 00 f7 fd 00 01 00 01', () => {
    const b = encodeIpv4(
      ip4(
        { kind: 'icmp', type: 'echo-request', code: 0, id: 1, seq: 1, dataSize: 0 },
        { protocol: 1 },
      ),
    );
    expect(hex(b.slice(20))).toBe('0800f7fd00010001');
  });

  it('ICMP-Echo mit Daten: Prüfsumme über die ganze Nachricht ergibt 0', () => {
    const b = encodeIpv4(
      ip4(
        { kind: 'icmp', type: 'echo-reply', code: 0, id: 7, seq: 3, dataSize: 32 },
        { protocol: 1 },
      ),
    );
    expect(b.length).toBe(20 + 8 + 32);
    expect(inetChecksum(b.slice(20))).toBe(0);
  });

  it('ICMP Dest-Unreachable (Fragmentation needed) trägt MTU und Original-Header', () => {
    const b = encodeIpv4(
      ip4(
        {
          kind: 'icmp',
          type: 'dest-unreachable',
          code: 4,
          id: 0,
          seq: 0,
          dataSize: 0,
          nextHopMtu: 1400,
          orig: {
            src: '10.0.0.1',
            dst: '10.0.0.2',
            ipId: 5,
            protocol: 17,
            icmpId: 0,
            icmpSeq: 0,
            sport: 1000,
            dport: 53,
          },
        },
        { protocol: 1 },
      ),
    );
    const icmp = b.slice(20);
    expect(hex(icmp.slice(0, 2))).toBe('0304');
    expect((icmp[6] as number) * 256 + (icmp[7] as number)).toBe(1400);
    expect(icmp.length).toBe(8 + 20 + 8);
    expect(inetChecksum(icmp)).toBe(0);
    expect(inetChecksum(icmp.slice(8, 28))).toBe(0); // eingebetteter IP-Header
  });

  it('UDP-Prüfsumme mit Pseudo-Header stimmt', () => {
    const b = encodeIpv4(ip4({ kind: 'udp', srcPort: 40000, dstPort: 7, dataSize: 11 }));
    const seg = [...b.slice(20)];
    const pseudo = [...b.slice(12, 20), 0, 17, 0, seg.length];
    expect(foldsToFFFF([pseudo, seg])).toBe(true);
    expect(seg[6]).not.toBe(0);
  });

  it('TCP SYN: MSS-Option, Header 24 Byte, Prüfsumme stimmt', () => {
    const b = encodeIpv4(
      ip4(
        {
          kind: 'tcp',
          srcPort: 49152,
          dstPort: 80,
          flags: { ...noFlags, syn: true },
          seq: 1000,
          ack: 0,
          window: 8192,
          dataSize: 0,
        },
        { protocol: 6 },
      ),
    );
    const seg = [...b.slice(20)];
    expect(seg[12]).toBe(0x60);
    expect(seg[13]).toBe(0x02);
    expect(hex(seg.slice(20, 24))).toBe('020405b4');
    expect(foldsToFFFF([[...b.slice(12, 20), 0, 6, 0, seg.length], seg])).toBe(true);
  });

  it('TCP-Flags werden korrekt kodiert (SYN+ACK = 0x12, FIN+ACK+PSH = 0x19)', () => {
    const mk = (flags: TcpFlags): number =>
      encodeIpv4(
        ip4(
          { kind: 'tcp', srcPort: 1, dstPort: 2, flags, seq: 1, ack: 1, window: 1, dataSize: 0 },
          { protocol: 6 },
        ),
      )[33] as number;
    expect(mk({ ...noFlags, syn: true, ack: true })).toBe(0x12);
    expect(mk({ ...noFlags, fin: true, ack: true, psh: true })).toBe(0x19);
    expect(mk({ ...noFlags, rst: true })).toBe(0x04);
  });

  it('Fragmente: Offset/MF im Header, Nutzlast ist der passende Ausschnitt', () => {
    const payload = {
      kind: 'icmp',
      type: 'echo-request',
      code: 0,
      id: 1,
      seq: 1,
      dataSize: 3000,
    } as const;
    const first = encodeIpv4(
      ip4(payload, { protocol: 1, df: false, mf: true, fragOffset: 0, dataLen: 1480 }),
    );
    const second = encodeIpv4(
      ip4(payload, { protocol: 1, df: false, mf: true, fragOffset: 185, dataLen: 1480 }),
    );
    const last = encodeIpv4(
      ip4(payload, { protocol: 1, df: false, mf: false, fragOffset: 370, dataLen: 48 }),
    );
    expect(first.length).toBe(1500);
    expect(hex(first.slice(6, 8))).toBe('2000');
    expect(hex(second.slice(6, 8))).toBe('20b9');
    expect(hex(last.slice(6, 8))).toBe('0172');
    expect(last.length).toBe(68);
    expect(inetChecksum(last.slice(0, 20))).toBe(0);
  });
});

describe('encode: Ethernet / ARP / VLAN / STP', () => {
  const arp: EthernetPdu = {
    kind: 'ethernet',
    dst: 'ff:ff:ff:ff:ff:ff',
    src: '02:00:00:00:00:01',
    etherType: 0x0806,
    payload: {
      kind: 'arp',
      op: 'request',
      senderMac: '02:00:00:00:00:01',
      senderIp: '10.0.0.1',
      targetMac: '00:00:00:00:00:00',
      targetIp: '10.0.0.2',
    },
  };

  it('ARP-Request: bekannte Bytes, auf 60 Byte aufgefüllt', () => {
    const b = encodeFrame(arp);
    expect(b.length).toBe(60);
    expect(hex(b.slice(0, 42))).toBe(
      'ffffffffffff020000000001' +
        '0806' +
        '0001080006040001' +
        '020000000001' +
        '0a000001' +
        '000000000000' +
        '0a000002',
    );
    expect(hex(b.slice(42))).toBe('00'.repeat(18));
    expect(encodeArp(arp.payload as never).length).toBe(28);
  });

  it('802.1Q-Tag: TPID 8100, PCP/VID, danach der innere EtherType', () => {
    const b = encodeFrame({ ...arp, vlan: { vid: 10, pcp: 5 } });
    expect(hex(b.slice(12, 18))).toBe('8100a00a0806');
  });

  it('STP-Konfigurations-BPDU: 802.3-Länge 38 + LLC 42 42 03 + 35 Byte BPDU', () => {
    const f: EthernetPdu = {
      kind: 'ethernet',
      dst: '01:80:c2:00:00:00',
      src: '02:00:00:00:00:09',
      etherType: 0x0026,
      payload: {
        kind: 'bpdu',
        rstp: false,
        vlan: 1,
        rootId: '32769.02:00:00:00:00:09',
        rootCost: 0,
        bridgeId: '32769.02:00:00:00:00:09',
        portId: '128.001',
        flags: { proposal: false, agreement: false, topologyChange: false, role: 'designated' },
      },
    };
    const b = encodeFrame(f);
    expect(hex(b.slice(12, 17))).toBe('0026424203');
    expect(hex(b.slice(17, 21))).toBe('00000000');
    expect(hex(b.slice(22, 30))).toBe('8001' + '020000000009');
    expect(b.length).toBe(60);
  });

  it('RSTP-BPDU: Version 2, Typ 0x02, Rolle/Forwarding-Bits im Flag-Byte', () => {
    const f: EthernetPdu = {
      kind: 'ethernet',
      dst: '01:80:c2:00:00:00',
      src: '02:00:00:00:00:09',
      etherType: 0x0027,
      payload: {
        kind: 'bpdu',
        rstp: true,
        vlan: 1,
        rootId: '32769.02:00:00:00:00:09',
        rootCost: 4,
        bridgeId: '32769.02:00:00:00:00:09',
        portId: '128.002',
        flags: { proposal: true, agreement: false, topologyChange: false, role: 'designated' },
      },
    };
    const b = encodeFrame(f);
    expect(hex(b.slice(12, 14))).toBe('0027'); // 3 + 36
    expect(b[19]).toBe(2); // Version
    expect(b[20]).toBe(2); // Typ RST
    expect(b[21]).toBe(0x02 | (3 << 2) | 0x30);
  });
});

describe('encode: IPv6 / ICMPv6', () => {
  it('Neighbor Solicitation: Prüfsumme (IPv6-Pseudo-Header) stimmt, Source-LLA-Option', () => {
    const p: Ipv6Pdu = {
      kind: 'ipv6',
      src: 'fe80::1',
      dst: 'ff02::1:ff00:2',
      hopLimit: 255,
      nextHeader: 58,
      payload: {
        kind: 'icmp6',
        type: 'ns',
        code: 0,
        id: 0,
        seq: 0,
        dataSize: 0,
        target: 'fe80::2',
        lladdr: '02:00:00:00:00:01',
      },
    };
    const b = encodeIpv6(p);
    expect(hex(b.slice(0, 8))).toBe('6000000000203aff');
    const seg = [...b.slice(40)];
    expect(seg[0]).toBe(135);
    expect(hex(seg.slice(24, 32))).toBe('0101020000000001');
    const pseudo = [...b.slice(8, 40), 0, 0, 0, seg.length, 0, 0, 0, 58];
    expect(foldsToFFFF([pseudo, seg])).toBe(true);
  });

  it('Echo-Request über IPv6', () => {
    const b = encodeIpv6({
      kind: 'ipv6',
      src: '2001:db8::1',
      dst: '2001:db8::2',
      hopLimit: 64,
      nextHeader: 58,
      payload: { kind: 'icmp6', type: 'echo-request', code: 0, id: 1, seq: 2, dataSize: 8 },
    });
    expect(b[40]).toBe(128);
    expect(b.length).toBe(40 + 8 + 8);
  });
});

describe('encode: Anwendungsprotokolle', () => {
  it('DNS-Query für example.com (A): bekannte Bytes', () => {
    const b = encodeDns({
      kind: 'dns',
      id: 0x1234,
      response: false,
      rcode: 0,
      question: { name: 'example.com', type: 'A' },
      answers: [],
    });
    expect(hex(b)).toBe('123401000001000000000000' + '076578616d706c6503636f6d00' + '00010001');
  });

  it('DNS-Antwort: Namenskompression (c00c), A-Record 93.184.216.34', () => {
    const b = encodeDns({
      kind: 'dns',
      id: 1,
      response: true,
      rcode: 0,
      question: { name: 'a.de', type: 'A' },
      answers: [{ name: 'a.de', type: 'A', data: '93.184.216.34', ttl: 60 }],
    });
    expect(hex(b.slice(2, 4))).toBe('8580');
    expect(hex(b.slice(-16))).toBe('c00c00010001' + '0000003c' + '0004' + '5db8d822');
  });

  it('RIPv2-Response: 4 Byte Kopf + 20 Byte je Eintrag', () => {
    const b = encodeRip({
      kind: 'rip',
      command: 'response',
      entries: [
        { prefix: '10.1.0.0', mask: '255.255.255.0', nextHop: '0.0.0.0', metric: 2, tag: 0 },
      ],
    });
    expect(hex(b)).toBe(
      '02020000' + '00020000' + '0a010000' + 'ffffff00' + '00000000' + '00000002',
    );
  });

  it('HSRPv1-Hello: 20 Byte, Auth "cisco"', () => {
    const b = encodeHsrp({
      kind: 'hsrp',
      group: 1,
      op: 'hello',
      state: 'active',
      helloSec: 3,
      holdSec: 10,
      priority: 100,
      vip: '10.0.0.254',
    });
    expect(hex(b)).toBe('00001003' + '0a640100' + '636973636f000000' + '0a0000fe');
  });

  it('BGP-Keepalive: 16 × ff, Länge 19, Typ 4', () => {
    expect(hex(encodeBgp({ type: 'keepalive' }))).toBe('ff'.repeat(16) + '0013' + '04');
  });

  it('BGP-Open: Version 4, AS, Hold, Router-ID', () => {
    const b = encodeBgp({ type: 'open', asn: 65001, holdSec: 180, routerId: '1.1.1.1' });
    expect(hex(b.slice(16))).toBe('001d' + '01' + '04' + 'fde9' + '00b4' + '01010101' + '00');
  });

  it('BGP-Update: NLRI und Pfadattribute', () => {
    const b = encodeBgp({
      type: 'update',
      withdrawn: [],
      attrs: { origin: 'igp', asPath: [65001], nextHop: '10.0.0.1' },
      nlri: [{ prefix: '192.168.1.0', plen: 24 }],
    });
    expect(hex(b.slice(19))).toBe(
      '0000' +
        '0012' +
        '40010100' +
        '4002' +
        '04' +
        '0201fde9' +
        '4003' +
        '04' +
        '0a000001' +
        '18c0a801',
    );
  });
});

describe('encode: OSPF', () => {
  const hello = (extra: object = {}): { v: 2; msg: OspfMsg } => ({
    v: 2 as const,
    msg: {
      type: 'hello' as const,
      routerId: '1.1.1.1',
      areaId: '0.0.0.0',
      helloSec: 10,
      deadSec: 40,
      priority: 1,
      dr: '10.0.0.1',
      bdr: '0.0.0.0',
      neighbors: ['2.2.2.2'],
      plen: 24,
      ...extra,
    } as OspfMsg,
  });

  it('Hello: Kopf, Maske, Intervalle, Nachbarn; Prüfsumme gültig', () => {
    const b = encodeOspf(hello());
    expect(hex(b.slice(0, 2))).toBe('0201');
    expect(b.length).toBe(24 + 20 + 4);
    expect(hex(b.slice(4, 12))).toBe(
      '0101010100000000'.replace('0101010100000000', '0101010100000000'),
    );
    expect(hex(b.slice(24, 28))).toBe('ffffff00');
    expect(hex(b.slice(28, 32))).toBe('000a0201');
    // Prüfsumme über das Paket ohne Authentifizierungsfeld
    const copy = [...b];
    for (let i = 16; i < 24; i++) copy[i] = 0;
    expect(inetChecksum(copy)).toBe(0);
  });

  it('Klartext-Authentifizierung: Typ 1 und Schlüssel im Feld', () => {
    const b = encodeOspf(hello({ auth: { type: 'simple', key: 'secret' } }));
    expect(hex(b.slice(14, 16))).toBe('0001');
    expect(hex(b.slice(16, 24))).toBe('7365637265740000');
  });

  it('LSA-Fletcher-Prüfsumme: Prüfsummenprobe über die LSA ergibt 0/0', () => {
    const lsa: OspfLsa = {
      type: 1,
      id: '1.1.1.1',
      advRouter: '1.1.1.1',
      seq: 3,
      age: 5,
      body: {
        type: 1,
        abr: false,
        asbr: false,
        links: [
          { kind: 'stub', prefix: '10.0.0.0', plen: 24, cost: 1 },
          { kind: 'p2p', neighbor: '2.2.2.2', addr: '10.0.12.1', cost: 10 },
        ],
      },
    };
    const b = encodeLsa(lsa, 2);
    expect(b.length).toBe(20 + 4 + 2 * 12);
    let c0 = 0;
    let c1 = 0;
    for (let i = 2; i < b.length; i++) {
      c0 = (c0 + (b[i] as number)) % 255;
      c1 = (c1 + c0) % 255;
    }
    expect([c0, c1]).toEqual([0, 0]);
    expect(hex(b.slice(12, 16))).toBe('80000003');
    const again = [...b];
    lsaChecksum(again);
    expect(again).toEqual([...b]);
  });

  it('LSU enthält Anzahl und LSAs; OSPFv3 nutzt den IPv6-Pseudo-Header', () => {
    const lsu = {
      v: 3 as const,
      msg: {
        type: 'lsu' as const,
        routerId: '1.1.1.1',
        areaId: '0.0.0.0',
        lsas: [
          {
            type: 3 as const,
            id: '0.0.0.1',
            advRouter: '1.1.1.1',
            seq: 1,
            age: 0,
            body: { type: 3 as const, prefix: '2001:db8:1::', plen: 64, metric: 10 },
          },
        ],
      },
    };
    const ctx = {
      v6: true,
      src: new Array<number>(16).fill(1),
      dst: new Array<number>(16).fill(2),
    };
    const b = encodeOspf(lsu, ctx);
    expect(b[0]).toBe(3);
    expect(hex(b.slice(16, 20))).toBe('00000001');
    const seg = [...b];
    expect(foldsToFFFF([[...ctx.src, ...ctx.dst, 0, 0, 0, seg.length, 0, 0, 0, 89], seg])).toBe(
      true,
    );
  });
});

describe('encode: pcap', () => {
  const frame: EthernetPdu = {
    kind: 'ethernet',
    dst: 'ff:ff:ff:ff:ff:ff',
    src: '02:00:00:00:00:01',
    etherType: 0x0806,
    payload: {
      kind: 'arp',
      op: 'request',
      senderMac: '02:00:00:00:00:01',
      senderIp: '10.0.0.1',
      targetMac: '00:00:00:00:00:00',
      targetIp: '10.0.0.2',
    },
  };

  it('Dateikopf: Magic d4c3b2a1 (little endian), Version 2.4, LINKTYPE_ETHERNET', () => {
    const b = writePcap([]);
    expect(hex(b)).toBe(
      'd4c3b2a1' + '0200' + '0400' + '00000000' + '00000000' + 'ffff0000' + '01000000',
    );
  });

  it('Paket-Record: Zeitstempel, Längen, Frame-Bytes', () => {
    const b = writePcap([{ t: 1_500_250, frame }]);
    expect(b.length).toBe(24 + 16 + 60);
    const rec = b.slice(24);
    const dv = new DataView(rec.buffer, rec.byteOffset);
    expect(dv.getUint32(0, true)).toBe(1735689600 + 1);
    expect(dv.getUint32(4, true)).toBe(500_250);
    expect(dv.getUint32(8, true)).toBe(60);
    expect(dv.getUint32(12, true)).toBe(60);
    expect(hex(rec.slice(16, 22))).toBe('ffffffffffff');
  });

  it('Hexdump im Wireshark-Stil', () => {
    const d = hexDump(
      Uint8Array.from([0x41, 0x42, 0x00, 0x7f, ...new Array<number>(14).fill(0x30)]),
    );
    const lines = d.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '0000  41 42 00 7f 30 30 30 30  30 30 30 30 30 30 30 30  AB..000000000000',
    );
    expect(lines[1]?.startsWith('0010  30 30')).toBe(true);
  });
});
