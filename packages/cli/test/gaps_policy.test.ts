import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { diamond, roundTrip, router, sec } from './gapsLab';

describe('Lücken: Prefix-Lists, Route-Maps, distribute-list', () => {
  it('Konfiguration, show-Befehle und Replay', () => {
    const e = new Engine({ seed: 1 });
    const r1 = router(e, 'R1');
    r1.run(
      'enable',
      'configure terminal',
      'ip prefix-list LAN seq 5 permit 10.1.0.0/16 ge 24 le 28',
      'ip prefix-list LAN seq 10 deny 0.0.0.0/0 le 32',
      'ip prefix-list ONE permit 192.168.1.0/24',
      'ipv6 prefix-list V6 permit 2001:db8::/32 le 64',
      'ip community-list standard CL permit 65001:100 65001:200',
      'access-list 5 deny 10.5.0.0 0.0.0.255',
      'access-list 5 permit any',
      'route-map RM permit 10',
      'match ip address prefix-list LAN',
      'match tag 3 4',
      'set metric 50',
      'set metric-type type-1',
      'set tag 9',
      'set local-preference 200',
      'set weight 5',
      'set as-path prepend 65001 65001',
      'set community 65001:100 additive',
      'set ip next-hop 10.9.9.9',
      'set origin igp',
      'exit',
      'route-map RM deny 20',
      'match ip address 5',
      'match community CL',
      'exit',
      'router rip',
      'redistribute static metric 3 route-map RM',
      'distribute-list 5 in',
      'distribute-list prefix ONE out gi0/0',
      'exit',
      'router eigrp 1',
      'redistribute rip metric 1000 100 255 1 1500 route-map RM',
      'distribute-list 5 out',
      'exit',
      'router ospf 1',
      'redistribute static subnets route-map RM',
      'distribute-list prefix ONE in',
      'end',
    );
    const sh = r1.run('show ip prefix-list LAN', 'show route-map RM', 'show ip community-list');
    expect(sh).toContain('ip prefix-list LAN: 2 entries');
    expect(sh).toContain('seq 5 permit 10.1.0.0/16 ge 24 le 28');
    expect(sh).toContain('route-map RM, permit, sequence 10');
    expect(sh).toContain('ip address prefix-list LAN');
    expect(sh).toContain('metric-type type-1');
    expect(sh).toContain('Community standard list CL');
    const cfg = roundTrip(e, r1);
    for (const must of [
      'ip prefix-list LAN seq 5 permit 10.1.0.0/16 ge 24 le 28',
      'ipv6 prefix-list V6 seq 5 permit 2001:db8::/32 le 64',
      'ip community-list standard CL permit 65001:100 65001:200',
      'route-map RM permit 10',
      ' match tag 3 4',
      ' set community 65001:100 additive',
      ' set as-path prepend 65001 65001',
      'route-map RM deny 20',
      ' redistribute static metric 3 route-map RM',
      ' distribute-list 5 in',
      ' distribute-list prefix ONE out GigabitEthernet0/0',
      ' distribute-list prefix ONE in',
    ])
      expect(cfg).toContain(must);
    r1.run('configure terminal', 'no route-map RM deny 20', 'no ip prefix-list ONE', 'end');
    expect(r1.run('show route-map')).not.toContain('sequence 20');
    expect(r1.run('show ip prefix-list')).not.toContain('ONE');
    expect(r1.run('configure terminal', 'ip prefix-list X permit 1.1.1.0/24 ge 20')).toContain(
      '% Invalid prefix range',
    );
  });

  it('verhält sich: distribute-list wirkt auf gelernte RIP-Routen', () => {
    const { e, r1, r2, r3, r4 } = diamond();
    for (const r of [r1, r2, r3, r4])
      r.run('configure terminal', 'router rip', 'network 10.0.0.0', 'no auto-summary', 'end');
    sec(e, 100);
    expect(r1.run('show ip route')).toContain('10.4.0.0/24');
    r1.run(
      'configure terminal',
      'access-list 9 deny 10.4.0.0 0.0.0.255',
      'access-list 9 permit any',
      'router rip',
      'distribute-list 9 in',
      'end',
    );
    sec(e, 10);
    expect(r1.run('show ip route')).not.toContain('10.4.0.0/24');
    expect(r1.run('show ip route')).toContain('10.0.24.0/24');
  });
});
