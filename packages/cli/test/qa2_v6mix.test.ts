import { describe, expect, it } from 'vitest';
import { diamond, roundTrip, sec } from './gapsLab';

/** R1 – R2 – R4 mit OSPFv3 UND EIGRPv6 auf denselben Schnittstellen. */
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
      'ipv6 router ospf 1',
      `router-id ${rid}`,
      'exit',
      ...rows.flatMap(([i, a]) => [
        `interface ${i}`,
        `ipv6 address ${a}`,
        'ipv6 eigrp 100',
        'ipv6 ospf 1 area 0',
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

describe('QA2: EIGRPv6 und OSPFv3 parallel', () => {
  it('EIGRP (AD 90) gewinnt; ohne EIGRP übernimmt OSPFv3, danach wieder EIGRP', () => {
    const { e, r1, r4 } = lab();
    sec(e, 60);
    const t0 = r1.s.input('show ipv6 route');
    expect(t0).toMatch(/D {3}2001:DB8:4::\/64 \[90\//);
    // Zähler wie IOS: alle Präfixe einschließlich Local-Routen (C×2, D×2, L×2)
    expect(t0).toContain('IPv6 Routing Table - default - 6 entries');
    expect(r1.s.input('show ipv6 ospf neighbor')).toMatch(/FULL/);
    r4.run('configure terminal', 'no ipv6 router eigrp 100', 'end');
    sec(e, 30);
    const rt = r1.s.input('show ipv6 route');
    expect(rt).not.toMatch(/D {3}2001:DB8:4::\/64/);
    expect(rt).toMatch(/O {3}2001:DB8:4::\/64 \[110\//);
    r4.run(
      'configure terminal',
      'ipv6 router eigrp 100',
      'eigrp router-id 4.4.4.4',
      'no shutdown',
      'end',
    );
    sec(e, 30);
    expect(r1.s.input('show ipv6 route')).toMatch(/D {3}2001:DB8:4::\/64 \[90\//);
  });

  it('Redistribution OSPFv3 → EIGRPv6 erscheint als EX', () => {
    const { e, r1, r2, r4 } = lab();
    // R4 spricht nur noch OSPFv3, R2 verteilt nach EIGRP um
    r4.run('configure terminal', 'no ipv6 router eigrp 100', 'end');
    r1.run(
      'configure terminal',
      'ipv6 router ospf 1',
      'exit',
      'interface gi0/0',
      'no ipv6 ospf 1 area 0',
      'end',
    );
    r2.run(
      'configure terminal',
      'ipv6 router eigrp 100',
      'redistribute ospf 1 metric 10000 100 255 1 1500',
      'end',
    );
    sec(e, 60);
    expect(r1.s.input('show ipv6 route')).toMatch(/EX {2}2001:DB8:4::\/64 \[170\//);
    roundTrip(e, r2);
  });

  it('Interface shutdown entfernt die Nachbarn beider Protokolle', () => {
    const { e, r1, r2 } = lab();
    sec(e, 60);
    r2.run('configure terminal', 'interface gi0/0', 'shutdown', 'end');
    sec(e, 5);
    expect(r1.s.input('show ipv6 eigrp neighbors')).not.toContain('FE80::');
    sec(e, 40);
    expect(r1.s.input('show ipv6 ospf neighbor')).not.toMatch(/FULL/);
    expect(r1.s.input('show ipv6 route')).not.toContain('2001:DB8:4::');
  });
});
