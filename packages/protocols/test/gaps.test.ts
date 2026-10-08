import { describe, expect, it } from 'vitest';
import {
  describeFrame,
  pduSize,
  summarizeFrame,
  type BgpMsg,
  type Frame,
  type HsrpPdu,
  type Ipv4Pdu,
  type Ipv6Pdu,
  type OspfMsg,
} from '../src';

const eth = (payload: Frame['payload'], etherType = 0x0800): Frame => ({
  kind: 'ethernet',
  dst: '01:00:5e:00:00:05',
  src: '02:00:00:00:00:01',
  etherType,
  payload,
});
const ip4 = (payload: Ipv4Pdu['payload']): Ipv4Pdu => ({
  kind: 'ipv4',
  src: '10.0.0.1',
  dst: '224.0.0.5',
  ttl: 1,
  protocol: 89,
  id: 1,
  df: false,
  mf: false,
  fragOffset: 0,
  payload,
});
const ip6 = (payload: Ipv6Pdu['payload']): Ipv6Pdu => ({
  kind: 'ipv6',
  src: 'fe80::1',
  dst: 'ff02::1:2',
  hopLimit: 255,
  nextHeader: 17,
  payload,
});
const fields = (f: Frame): string[] => describeFrame(f).flatMap((l) => l.fields.map((x) => x.name));

describe('Lücken-PDUs', () => {
  it('OSPF: Authentifizierung und Bereichstyp erscheinen in den Feldern', () => {
    const hello: OspfMsg = {
      type: 'hello',
      routerId: '1.1.1.1',
      areaId: '1',
      helloSec: 10,
      deadSec: 40,
      priority: 1,
      dr: '0.0.0.0',
      bdr: '0.0.0.0',
      neighbors: [],
      areaType: 'stub',
      auth: { type: 'md5', keyId: 3, digest: 'abcd' },
    };
    const f = eth(ip4({ kind: 'routing', proto: 'ospf', v: 2, msg: hello }));
    expect(fields(f)).toContain('Auth');
    expect(fields(f)).toContain('Area type');
    const simple = eth(
      ip4({
        kind: 'routing',
        proto: 'ospf',
        v: 2,
        msg: { ...hello, areaType: undefined, auth: { type: 'simple', key: 'k' } },
      }),
    );
    expect(
      describeFrame(simple)
        .flatMap((l) => l.fields)
        .find((x) => x.name === 'Auth')?.value,
    ).toBe('simple password');
  });

  it('BGP: Communities, Reflector-Attribute und MP-IPv6 werden beschrieben und mitgezählt', () => {
    const msg: BgpMsg = {
      type: 'update',
      withdrawn: [],
      withdrawn6: [{ prefix: '2001:db8:9::', plen: 64 }],
      nlri: [{ prefix: '10.0.0.0', plen: 24 }],
      nlri6: [{ prefix: '2001:db8::', plen: 32 }],
      attrs: {
        origin: 'igp',
        asPath: [100],
        nextHop: '10.0.0.1',
        communities: ['65000:1'],
        originatorId: '1.1.1.1',
        clusterList: ['2.2.2.2'],
        nextHop6: '2001:db8::1',
      },
    };
    const f = eth(ip4({ kind: 'routing', proto: 'bgp', sport: 40000, dport: 179, msg }));
    const names = fields(f);
    for (const n of [
      'COMMUNITY',
      'ORIGINATOR_ID',
      'CLUSTER_LIST',
      'MP_NEXT_HOP',
      'MP_REACH_NLRI',
      'MP_UNREACH_NLRI',
    ])
      expect(names).toContain(n);
    expect(pduSize(f)).toBeGreaterThan(
      pduSize(
        eth(
          ip4({ kind: 'routing', proto: 'bgp', sport: 1, dport: 179, msg: { type: 'keepalive' } }),
        ),
      ),
    );
  });

  it('DHCPv6: Größe, Felder und Zusammenfassung', () => {
    const f = eth(
      ip6({
        kind: 'udp',
        srcPort: 547,
        dstPort: 546,
        dataSize: 0,
        app: {
          kind: 'dhcp6',
          op: 'reply',
          xid: 0x1234,
          clientId: '02:00:00:00:00:09',
          serverId: '02:00:00:00:00:01',
          addr: '2001:db8::100',
          plen: 64,
          leaseSec: 3600,
          dns: ['2001:db8::53'],
          domain: 'x.test',
        },
      }),
      0x86dd,
    );
    expect(fields(f)).toEqual(
      expect.arrayContaining(['Message Type', 'IA_NA Address', 'DNS Servers']),
    );
    expect(summarizeFrame(f)).toMatchObject({ proto: 'DHCP' });
    expect(pduSize(f)).toBeGreaterThan(60);
    const bare = eth(
      ip6({
        kind: 'udp',
        srcPort: 546,
        dstPort: 547,
        dataSize: 0,
        app: { kind: 'dhcp6', op: 'solicit', xid: 1, clientId: '02:00:00:00:00:09' },
      }),
      0x86dd,
    );
    expect(summarizeFrame(bare).info).toContain('SOLICIT');
  });

  it('RIPng und HSRP über IPv6 werden als solche erkannt', () => {
    const rip = eth(
      ip6({
        kind: 'udp',
        srcPort: 521,
        dstPort: 521,
        dataSize: 0,
        app: {
          kind: 'rip',
          ng: true,
          command: 'response',
          entries: [{ prefix: '2001:db8::', mask: '', plen: 64, nextHop: '::', metric: 1, tag: 0 }],
        },
      }),
      0x86dd,
    );
    expect(summarizeFrame(rip)).toMatchObject({ proto: 'RIP' });
    const hsrp: HsrpPdu = {
      kind: 'hsrp',
      group: 4,
      op: 'hello',
      state: 'active',
      helloSec: 3,
      holdSec: 10,
      priority: 100,
      vip: 'fe80::5:73ff:fea0:4',
      version: 2,
      auth: 'cisco',
    };
    const h6 = eth(
      ip6({ kind: 'udp', srcPort: 2029, dstPort: 2029, dataSize: 0, app: hsrp }),
      0x86dd,
    );
    expect(summarizeFrame(h6)).toMatchObject({ proto: 'HSRP' });
  });

  it('OSPF Typ-7-LSA wird in LSU-Feldern aufgeführt', () => {
    const msg: OspfMsg = {
      type: 'lsu',
      routerId: '1.1.1.1',
      areaId: '1',
      lsas: [
        {
          type: 7,
          id: '9.9.9.0',
          advRouter: '1.1.1.1',
          seq: 0x80000001,
          age: 0,
          body: { type: 7, prefix: '9.9.9.0', plen: 24, metric: 20, eType: 2, tag: 0, p: true },
        },
      ],
    };
    const f = eth(ip4({ kind: 'routing', proto: 'ospf', v: 2, msg }));
    expect(
      describeFrame(f)
        .flatMap((l) => l.fields)
        .some((x) => x.value.toString().includes('type 7')),
    ).toBe(true);
    expect(pduSize(f)).toBeGreaterThan(40);
  });
});
