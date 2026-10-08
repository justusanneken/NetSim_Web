import { describe, expect, it } from 'vitest';
import { HostShell } from '../src';
import { diamond, roundTrip, sec } from './gapsLab';

function v6diamond() {
  const lab = diamond();
  const { r1, r2, r4 } = lab;
  const base = (r: typeof r1, rows: [string, string][]): void => {
    r.run(
      'configure terminal',
      'ipv6 unicast-routing',
      ...rows.flatMap(([i, a]) => [`interface ${i}`, `ipv6 address ${a}`, 'exit']),
      'end',
    );
  };
  base(r1, [
    ['gi0/0', '2001:db8:12::1/64'],
    ['gi0/2', '2001:db8:1::1/64'],
  ]);
  base(r2, [
    ['gi0/0', '2001:db8:12::2/64'],
    ['gi0/1', '2001:db8:24::2/64'],
  ]);
  base(r4, [
    ['gi0/0', '2001:db8:24::4/64'],
    ['gi0/2', '2001:db8:4::1/64'],
  ]);
  return lab;
}

describe('Lücken: IPv6 im CLI (RIPng, Traceroute, DHCPv6, DAD)', () => {
  it('RIPng: ipv6 router rip / ipv6 rip NAME enable, show ipv6 rip/route, traceroute ipv6, Replay', () => {
    const { e, r1, r2, r4 } = v6diamond();
    r1.run(
      'configure terminal',
      'ipv6 router rip LAB',
      'default-metric 2',
      'poison-reverse',
      'timers 30 180 180 240',
      'redistribute connected metric 2',
      'exit',
      'interface gi0/0',
      'ipv6 rip LAB enable',
      'exit',
      'interface gi0/2',
      'ipv6 rip LAB enable',
      'end',
    );
    for (const [r, ifs] of [
      [r2, ['gi0/0', 'gi0/1']],
      [r4, ['gi0/0', 'gi0/2']],
    ] as const)
      r.run(
        'configure terminal',
        'ipv6 router rip LAB',
        'exit',
        ...ifs.flatMap((i) => [`interface ${i}`, 'ipv6 rip LAB enable', 'exit']),
        'end',
      );
    sec(e, 120);
    const route = r1.run('show ipv6 route');
    expect(route).toMatch(/R\s+2001:DB8:4::\/64 \[120\/\d+\]/);
    expect(r1.run('show ipv6 rip')).toContain('RIP process "LAB"');
    expect(r1.run('show ipv6 protocols')).toContain('"rip LAB"');
    const tr = r1.run('traceroute ipv6 2001:db8:4::1');
    expect(tr).toContain('Tracing the route to 2001:DB8:4::1');
    expect(tr).toMatch(/1 2001:DB8:12::2/);
    const cfg = roundTrip(e, r1);
    for (const must of [
      'ipv6 router rip LAB',
      ' default-metric 2',
      ' poison-reverse',
      ' redistribute connected metric 2',
      ' ipv6 rip LAB enable',
    ])
      expect(cfg).toContain(must);
  });

  it('OSPFv3: redistribute connected/static (Replay)', () => {
    const { e, r1 } = v6diamond();
    r1.run(
      'configure terminal',
      'ipv6 router ospf 1',
      'router-id 1.1.1.1',
      'redistribute connected metric 5 metric-type 1',
      'redistribute static route-map RM',
      'end',
    );
    const cfg = roundTrip(e, r1);
    expect(cfg).toContain(' redistribute connected metric 5 metric-type 1');
    expect(cfg).toContain(' redistribute static route-map RM');
  });

  it('DHCPv6: Pool, Interface-Befehle, Client-Shell (ipconfig /all), show ipv6 dhcp, Replay', () => {
    const { e, r1, pc1 } = v6diamond();
    r1.run(
      'configure terminal',
      'ipv6 dhcp pool LAN',
      'address prefix 2001:db8:1::/64 lifetime 3600 3600',
      'dns-server 2001:db8:ffff::53',
      'domain-name lab.test',
      'exit',
      'interface gi0/2',
      'ipv6 dhcp server LAN',
      'ipv6 nd managed-config-flag',
      'ipv6 nd other-config-flag',
      'end',
    );
    e.setHostIpv6(pc1, { autoconfig: true, dhcp6: true });
    sec(e, 20);
    const sh = new HostShell(e, pc1);
    const all = sh.input('ipconfig /all');
    expect(all).toContain('DHCPv6 Enabled..................: Yes');
    expect(all).toContain('2001:db8:ffff::53');
    expect(all).toContain('lab.test');
    expect(all).toMatch(/IPv6 Address\.+: 2001:db8:1::[0-9a-f]+\(Preferred\)/);
    expect(r1.run('show ipv6 dhcp pool')).toContain('DHCPv6 pool: LAN');
    expect(r1.run('show ipv6 dhcp binding')).toContain('IA NA: Address: 2001:DB8:1::');
    const cfg = roundTrip(e, r1);
    for (const must of [
      'ipv6 dhcp pool LAN',
      ' address prefix 2001:DB8:1::/64 lifetime 3600 3600',
      ' dns-server 2001:DB8:FFFF::53',
      ' domain-name lab.test',
      ' ipv6 dhcp server LAN',
      ' ipv6 nd managed-config-flag',
      ' ipv6 nd other-config-flag',
    ])
      expect(cfg).toContain(must);
  });

  it('Host tracert mit IPv6-Ziel', () => {
    const { e, r1, r2, r4, pc1, pc4 } = v6diamond();
    // statische Routen statt Protokoll
    r1.run('configure terminal', 'ipv6 route 2001:db8:4::/64 2001:db8:12::2', 'end');
    r2.run(
      'configure terminal',
      'ipv6 route 2001:db8:4::/64 2001:db8:24::4',
      'ipv6 route 2001:db8:1::/64 2001:db8:12::1',
      'end',
    );
    r4.run('configure terminal', 'ipv6 route 2001:db8:1::/64 2001:db8:24::2', 'end');
    e.setHostIpv6(pc1, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' });
    e.setHostIpv6(pc4, { addr: '2001:db8:4::10', plen: 64, gateway: '2001:db8:4::1' });
    sec(e, 5);
    const out = new HostShell(e, pc1).input('tracert 2001:db8:4::10');
    expect(out).toContain('Tracing route to 2001:db8:4::10');
    expect(out).toContain('2001:db8:1::1');
    expect(out).toContain('2001:db8:24::4');
    expect(out).toContain('Trace complete.');
  });

  it('DAD: doppelte Router-Adresse wird als [DUP] angezeigt', () => {
    const { e, r1, r2 } = v6diamond();
    sec(e, 5);
    // R2 bekommt nachträglich dieselbe Adresse wie R1 auf dem gemeinsamen Segment
    r2.run('configure terminal', 'interface gi0/0', 'ipv6 address 2001:db8:12::1/64', 'end');
    sec(e, 5);
    expect(r2.run('show ipv6 interface gi0/0'.replace(' gi0/0', ''))).toMatch(/\[DUP\]/);
    expect(r1.run('show ipv6 interface')).not.toMatch(/\[DUP\]/);
    expect(e.log.some((l) => l.msg.key === 'nd.dad.dup')).toBe(true);
  });
});

describe('Lücken: clock set', () => {
  it('clock set + show clock; debug-Zeitstempel folgen der gesetzten Uhr', () => {
    const { e, r1, r2 } = diamond();
    const before = r1.run('show clock');
    expect(before).toMatch(/\*\d\d:\d\d:\d\d\.\d{3} UTC Mon Mar 1 1993/);
    const out = r1.run('clock set 10:30:00 15 March 2025');
    expect(out).toContain('%SYS-6-CLOCKUPDATE');
    expect(r1.run('show clock')).toMatch(/\n10:30:0\d\.\d{3} UTC Sat Mar 15 2025/);
    expect(r1.run('clock set 25:00:00 1 Jan 2025')).toContain('% Invalid');
    expect(r1.run('clock set 10:00:00 31 February 2025')).toContain('% Invalid day');
    expect(r1.run('clock set 10:30:00 March 16 2025')).toContain('CLOCKUPDATE');
    expect(r1.run('show clock')).toContain('Sun Mar 16 2025');
    // debug folgt der Uhr
    r1.run('debug ip ospf adj');
    for (const r of [r1, r2])
      r.run('configure terminal', 'router ospf 1', 'network 10.0.12.0 0.0.0.255 area 0', 'end');
    sec(e, 80);
    const dbg = r1.s.poll();
    expect(dbg).toMatch(/^Mar 16 10:3\d:\d\d\.\d{3}: OSPF-1 ADJ/m);
    expect(dbg).not.toContain('*Mar');
  });
});
