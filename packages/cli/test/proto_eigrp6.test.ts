import { describe, expect, it } from 'vitest';
import { diamond, roundTrip, sec } from './gapsLab';

function lab() {
  const l = diamond();
  const cfg = (r: typeof l.r1, rid: string, rows: [string, string][]): void => {
    r.run(
      'configure terminal',
      'ipv6 unicast-routing',
      'ipv6 router eigrp 100',
      `eigrp router-id ${rid}`,
      'no shutdown',
      'exit',
      ...rows.flatMap(([i, a]) => [
        `interface ${i}`,
        `ipv6 address ${a}`,
        'ipv6 eigrp 100',
        'exit',
      ]),
      'end',
    );
  };
  cfg(l.r1, '1.1.1.1', [
    ['gi0/0', '2001:db8:12::1/64'],
    ['gi0/2', '2001:db8:1::1/64'],
  ]);
  cfg(l.r2, '2.2.2.2', [
    ['gi0/0', '2001:db8:12::2/64'],
    ['gi0/1', '2001:db8:24::2/64'],
  ]);
  cfg(l.r4, '4.4.4.4', [
    ['gi0/0', '2001:db8:24::4/64'],
    ['gi0/2', '2001:db8:4::1/64'],
  ]);
  return l;
}

describe('EIGRP für IPv6 (CLI)', () => {
  it('Nachbarn, Topologie und Routen sind sichtbar', () => {
    const { e, r1 } = lab();
    sec(e, 40);
    const nb = r1.s.input('show ipv6 eigrp neighbors');
    expect(nb).toContain('EIGRP-IPv6 Neighbors for AS(100)');
    expect(nb).toContain('FE80::');
    const topo = r1.s.input('show ipv6 eigrp topology');
    expect(topo).toContain('EIGRP-IPv6 Topology Table for AS(100)/ID(1.1.1.1)');
    expect(topo).toContain('P 2001:DB8:4::/64');
    const route = r1.s.input('show ipv6 route');
    expect(route).toMatch(/D {3}2001:DB8:4::\/64 \[90\//);
    expect(r1.s.input('show ipv6 eigrp interfaces')).toContain('Gi0/0');
    expect(r1.s.input('show ipv6 protocols')).toContain('IPv6 Routing Protocol is "eigrp 100"');
  });

  it('Prozess ist ohne no shutdown inaktiv und wird in der running-config gerendert', () => {
    const { e, r1 } = lab();
    r1.run('configure terminal', 'ipv6 router eigrp 100', 'shutdown', 'end');
    sec(e, 40);
    expect(r1.s.input('show ipv6 eigrp neighbors')).not.toContain('FE80::');
    const rc = r1.s.input('show running-config');
    expect(rc).toContain('ipv6 router eigrp 100\n eigrp router-id 1.1.1.1\n shutdown');
    expect(rc).toContain(' ipv6 eigrp 100');
  });

  it('running-config überlebt Speichern/Reload (Replay)', () => {
    const { e, r1 } = lab();
    r1.run(
      'configure terminal',
      'ipv6 router eigrp 100',
      'passive-interface gi0/2',
      'variance 2',
      'maximum-paths 2',
      'redistribute static metric 10000 100 255 1 1500',
      'end',
    );
    const rc = roundTrip(e, r1);
    expect(rc).toContain(' passive-interface GigabitEthernet0/2');
    expect(rc).toContain(' redistribute static metric 10000 100 255 1 1500');
  });
});
