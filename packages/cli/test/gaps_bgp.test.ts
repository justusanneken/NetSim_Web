import { describe, expect, it } from 'vitest';
import { diamond, roundTrip, sec } from './gapsLab';

describe('Lücken: BGP-Policies, Communities, Route Reflector, IPv6 im CLI', () => {
  it('Route-Map/Prefix-List/Community/RR-Befehle, show ip bgp <net>, Replay', () => {
    const { e, r1, r2 } = diamond();
    r1.run(
      'configure terminal',
      'ip prefix-list ONLY41 seq 5 permit 10.4.0.0/24',
      'route-map TAG permit 10',
      'set community 65000:7 additive',
      'set local-preference 250',
      'exit',
      'router bgp 100',
      'bgp router-id 1.1.1.1',
      'bgp cluster-id 7.7.7.7',
      'neighbor 10.0.12.2 remote-as 200',
      'neighbor 10.0.12.2 send-community',
      'neighbor 10.0.12.2 route-map TAG in',
      'neighbor 10.0.12.2 prefix-list ONLY41 out',
      'neighbor 10.0.12.2 route-reflector-client',
      'neighbor 10.0.12.2 soft-reconfiguration inbound',
      'network 10.1.0.0 mask 255.255.255.0',
      'end',
    );
    r2.run(
      'configure terminal',
      'router bgp 200',
      'bgp router-id 2.2.2.2',
      'neighbor 10.0.12.1 remote-as 100',
      'network 10.0.24.0 mask 255.255.255.0',
      'end',
    );
    sec(e, 40);
    const detail = r1.run('show ip bgp 10.0.24.0');
    expect(detail).toContain('BGP routing table entry for 10.0.24.0/24');
    expect(detail).toContain('Community: 65000:7');
    expect(detail).toContain('localpref 250');
    const cfg = roundTrip(e, r1);
    for (const must of [
      ' bgp cluster-id 7.7.7.7',
      ' neighbor 10.0.12.2 send-community',
      ' neighbor 10.0.12.2 route-reflector-client',
      ' neighbor 10.0.12.2 prefix-list ONLY41 out',
      ' neighbor 10.0.12.2 route-map TAG in',
    ])
      expect(cfg).toContain(must);
    r1.run('configure terminal', 'router bgp 100', 'no neighbor 10.0.12.2 route-map TAG in', 'end');
    expect(r1.run('show running-config')).not.toContain('route-map TAG in');
  });

  it('address-family ipv6: activate und network; show bgp ipv6 unicast; Replay', () => {
    const { e, r1, r2 } = diamond();
    const cfg = (
      r: typeof r1,
      asn: number,
      peer: string,
      peerAs: number,
      v6: string,
      net?: string,
    ) =>
      r.run(
        'configure terminal',
        'ipv6 unicast-routing',
        'interface gi0/0',
        `ipv6 address ${v6}/64`,
        'exit',
        `router bgp ${asn}`,
        `neighbor ${peer} remote-as ${peerAs}`,
        'address-family ipv6',
        `neighbor ${peer} activate`,
        ...(net ? [`network ${net}`] : []),
        'exit-address-family',
        'end',
      );
    r1.run(
      'configure terminal',
      'ipv6 unicast-routing',
      'interface gi0/2',
      'ipv6 address 2001:db8:1::1/64',
      'end',
    );
    cfg(r1, 100, '10.0.12.2', 200, '2001:db8:12::1', '2001:db8:1::/64');
    cfg(r2, 200, '10.0.12.1', 100, '2001:db8:12::2');
    sec(e, 40);
    expect(r2.run('show ipv6 route')).toMatch(/B\s+2001:DB8:1::\/64/i);
    const out = r2.run('show bgp ipv6 unicast');
    expect(out.toUpperCase()).toContain('2001:DB8:1::/64');
    const text = roundTrip(e, r1);
    expect(text).toContain(' address-family ipv6');
    expect(text).toContain('  neighbor 10.0.12.2 activate');
    expect(text.toUpperCase()).toContain('  NETWORK 2001:DB8:1::/64');
    expect(text).toContain(' exit-address-family');
  });
});
