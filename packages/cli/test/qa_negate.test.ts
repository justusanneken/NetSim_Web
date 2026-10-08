import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { router } from './gapsLab';

describe('QA show ip route', () => {
  it('a /32 loopback shows C and L as separate entries, not as an ECMP continuation', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    const out = r.run(
      'enable',
      'configure terminal',
      'interface loopback0',
      'ip address 1.1.1.1 255.255.255.255',
      'end',
      'show ip route',
    );
    expect(out).toMatch(/^C\s+1\.1\.1\.1\/32 is directly connected, Loopback0$/m);
    expect(out).toMatch(/^L\s+1\.1\.1\.1\/32 is directly connected, Loopback0$/m);
    expect(out).not.toMatch(/^\s+is directly connected/m);
  });
});

/** Jede Zeile: [Kontext-Befehle, Befehl, Zeile in der running-config]. */
const CASES: [string[], string, string][] = [
  [[], 'ntp server 10.0.1.10', 'ntp server 10.0.1.10'],
  [[], 'ntp master 5', 'ntp master 5'],
  [[], 'logging host 10.0.1.10', 'logging host 10.0.1.10'],
  [[], 'logging trap warnings', 'logging trap 4'],
  [[], 'snmp-server community public RO', 'snmp-server community public RO'],
  [[], 'snmp-server location Lab', 'snmp-server location Lab'],
  [[], 'snmp-server contact Ops', 'snmp-server contact Ops'],
  [[], 'aaa new-model', 'aaa new-model'],
  [[], 'radius-server host 10.0.1.10 key k', 'radius-server host 10.0.1.10 key k'],
  [[], 'username bob privilege 7 secret pw', 'username bob privilege 7 secret'],
  [[], 'ip domain-name lab.local', 'ip domain-name lab.local'],
  [[], 'ip prefix-list PL seq 5 permit 10.0.0.0/8', 'ip prefix-list PL seq 5 permit 10.0.0.0/8'],
  [
    [],
    'ip community-list standard CL permit 65000:1',
    'ip community-list standard CL permit 65000:1',
  ],
  [[], 'ipv6 unicast-routing', 'ipv6 unicast-routing'],
  [
    ['interface gi0/0', 'ip address 10.0.1.1 255.255.255.0'],
    'standby version 2',
    'standby version 2',
  ],
  [
    ['interface gi0/0', 'ip address 10.0.1.1 255.255.255.0'],
    'standby 1 ip 10.0.1.254',
    'standby 1 ip 10.0.1.254',
  ],
  [
    ['interface gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'standby 1 ip 10.0.1.254'],
    'standby 1 priority 120',
    'standby 1 priority 120',
  ],
  [
    ['interface gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'standby 1 ip 10.0.1.254'],
    'standby 1 preempt',
    'standby 1 preempt',
  ],
  [
    ['interface gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'standby 1 ip 10.0.1.254'],
    'standby 1 authentication k',
    'standby 1 authentication k',
  ],
  [
    ['interface gi0/0'],
    'ip ospf authentication message-digest',
    'ip ospf authentication message-digest',
  ],
  [['interface gi0/0'], 'ip ospf message-digest-key 1 md5 k', 'ip ospf message-digest-key 1 md5'],
  [['interface gi0/0'], 'ipv6 address 2001:db8::1/64', 'ipv6 address 2001:DB8::1/64'],
  [['router ospf 1'], 'area 1 stub', 'area 1 stub'],
  [['router ospf 1'], 'area 1 nssa', 'area 1 nssa'],
  [['router ospf 1'], 'area 1 virtual-link 2.2.2.2', 'area 1 virtual-link 2.2.2.2'],
  [['router ospf 1'], 'maximum-paths 2', 'maximum-paths 2'],
  [['router ospf 1'], 'area 0 authentication', 'area 0 authentication'],
  [['router eigrp 1'], 'variance 3', 'variance 3'],
  [['router eigrp 1'], 'maximum-paths 2', 'maximum-paths 2'],
  [
    ['router bgp 65000', 'neighbor 10.0.0.2 remote-as 65000'],
    'neighbor 10.0.0.2 route-reflector-client',
    'neighbor 10.0.0.2 route-reflector-client',
  ],
  [
    ['router bgp 65000', 'neighbor 10.0.0.2 remote-as 65000'],
    'neighbor 10.0.0.2 send-community',
    'neighbor 10.0.0.2 send-community',
  ],
  [
    ['router bgp 65000', 'neighbor 10.0.0.2 remote-as 65000'],
    'neighbor 10.0.0.2 next-hop-self',
    'neighbor 10.0.0.2 next-hop-self',
  ],
  [
    ['router bgp 65000', 'neighbor 10.0.0.2 remote-as 65000'],
    'neighbor 10.0.0.2 prefix-list PL in',
    'neighbor 10.0.0.2 prefix-list PL in',
  ],
  [
    ['router bgp 65000', 'neighbor 10.0.0.2 remote-as 65000'],
    'neighbor 10.0.0.2 route-map RM out',
    'neighbor 10.0.0.2 route-map RM out',
  ],
  [['route-map RM permit 10'], 'set community 65000:1', 'set community 65000:1'],
  [['route-map RM permit 10'], 'set local-preference 200', 'set local-preference 200'],
  [
    ['route-map RM permit 10'],
    'match ip address prefix-list PL',
    'match ip address prefix-list PL',
  ],
  [['line vty 0 4'], 'login local', 'login local'],
  [['line vty 0 4'], 'transport input ssh', 'transport input ssh'],
];

describe('QA negation of new commands', () => {
  for (const [ctx, cmd, line] of CASES) {
    it(`no ${cmd}`, () => {
      const e = new Engine({ seed: 1 });
      const r = router(e, 'R1');
      const o1 = r.run('enable', 'configure terminal', ...ctx, cmd);
      expect(o1).not.toMatch(/% (Invalid|Incomplete|Ambiguous)/);
      expect(r.run('do show running-config')).toContain(line);
      const o2 = r.run(`no ${cmd}`);
      expect(o2).not.toMatch(/% (Invalid|Incomplete|Ambiguous)/);
      const rc = r.run('do show running-config');
      const lines = rc.split('\n').map((l) => l.trim());
      const hit = lines.filter((l) => l.startsWith(line));
      // `transport input` fällt auf den Standard zurück (nicht mehr "ssh")
      expect(hit).toEqual([]);
    });
  }
});
