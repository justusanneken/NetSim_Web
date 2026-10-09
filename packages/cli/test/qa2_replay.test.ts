import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { router, roundTrip } from './gapsLab';

const strip = (x: string): string =>
  x.replace(/Current configuration.*\n/, '').replace(/^.*#show running-config\n/, '');

/** Alle neuen Befehle dieser Runde auf einem Router. */
const FULL = [
  'configure terminal',
  'ipv6 unicast-routing',
  'interface gi0/0',
  'ip address 10.0.0.1 255.255.255.0',
  'ipv6 address 2001:db8::1/64',
  'ipv6 eigrp 10',
  'pppoe enable group global',
  'no shutdown',
  'exit',
  'interface gi0/1',
  'no ip address',
  'pppoe-client dial-pool-number 1',
  'no shutdown',
  'exit',
  'interface Dialer1',
  'encapsulation ppp',
  'ip address negotiated',
  'dialer pool 1',
  'ppp chap hostname kunde',
  'ppp chap password geheim',
  'ppp ipcp route default',
  'exit',
  'ip local pool KUNDEN 100.64.0.10 100.64.0.20',
  'bba-group pppoe global',
  'virtual-template 1',
  'exit',
  'interface Virtual-Template1',
  'ip unnumbered gi0/0',
  'peer default ip address pool KUNDEN',
  'ppp authentication chap',
  'exit',
  'ipv6 router eigrp 10',
  'eigrp router-id 1.1.1.1',
  'no shutdown',
  'passive-interface gi0/1',
  'exit',
  'aaa new-model',
  'tacacs-server host 10.0.0.10 key tackey',
  'tacacs server TAC2',
  'address ipv4 10.0.0.11',
  'key key2',
  'exit',
  'aaa authentication login default group tacacs+ local',
  'snmp-server community public RO',
  'snmp-server host 10.0.0.20 version 2c public',
  'snmp-server enable traps snmp linkdown linkup',
  'crypto isakmp policy 10',
  'encryption aes',
  'authentication pre-share',
  'group 2',
  'lifetime 3600',
  'exit',
  'crypto isakmp key geheim address 198.51.100.1',
  'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
  'mode tunnel',
  'exit',
  'access-list 101 permit ip 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255',
  'crypto map VPN 10 ipsec-isakmp',
  'set peer 198.51.100.1',
  'set transform-set TS',
  'match address 101',
  'set pfs group2',
  'set security-association lifetime seconds 1800',
  'exit',
  'interface gi0/2',
  'ip address 203.0.113.1 255.255.255.252',
  'crypto map VPN',
  'exit',
  'router ospf 1',
  'area 1 stub',
  'area 2 nssa',
  'exit',
  'router bgp 65001',
  'neighbor 10.0.0.2 remote-as 65002',
  'end',
];

describe('QA2: running-config-Replay und no-Formen der neuen Befehle', () => {
  it('Speichern/Reload reproduziert die running-config mit allen neuen Befehlen', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    const out = r.run('enable', ...FULL);
    expect(out).not.toMatch(/% (Invalid|Incomplete|Ambiguous|Unknown)/);
    const rc = roundTrip(e, r);
    for (const l of [
      'interface Dialer1',
      'ip local pool KUNDEN',
      'bba-group pppoe global',
      'interface Virtual-Template1',
      'ipv6 router eigrp 10',
      'tacacs server TAC2',
      'snmp-server host 10.0.0.20 version 2c public',
      'crypto map VPN 10 ipsec-isakmp',
      'area 1 stub',
      'neighbor 10.0.0.2 remote-as 65002',
    ])
      expect(rc).toContain(l);
  });

  it('no-Formen entfernen alles wieder (running-config wie vorher)', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run('enable', 'configure terminal', 'ipv6 unicast-routing', 'end');
    const base = strip(r.s.input('show running-config'));
    r.run('enable', ...FULL);
    const out = r.run(
      'configure terminal',
      'interface gi0/0',
      'no ip address',
      'no ipv6 address 2001:db8::1/64',
      'no ipv6 eigrp 10',
      'no pppoe enable group global',
      'shutdown',
      'exit',
      'interface gi0/1',
      'no pppoe-client dial-pool-number 1',
      'shutdown',
      'exit',
      'no interface Dialer1',
      'no interface Virtual-Template1',
      'no bba-group pppoe global',
      'no ip local pool KUNDEN',
      'no ipv6 router eigrp 10',
      'no aaa authentication login default',
      'no tacacs-server host 10.0.0.10',
      'no tacacs server TAC2',
      'no aaa new-model',
      'no snmp-server host 10.0.0.20 version 2c public',
      'no snmp-server enable traps',
      'no snmp-server community public',
      'interface gi0/2',
      'no crypto map VPN',
      'no ip address',
      'exit',
      'no crypto map VPN 10',
      'no access-list 101',
      'no crypto ipsec transform-set TS',
      'no crypto isakmp key geheim address 198.51.100.1',
      'no crypto isakmp policy 10',
      'router ospf 1',
      'no area 1',
      'no area 2',
      'exit',
      'no router ospf 1',
      'no router bgp 65001',
      'end',
    );
    expect(out).not.toMatch(/% (Invalid|Incomplete|Ambiguous|Unknown)/);
    expect(strip(r.s.input('show running-config'))).toBe(base);
  });
});
