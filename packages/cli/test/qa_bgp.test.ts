import { describe, expect, it } from 'vitest';
import type { Engine } from '@netsim/engine';
import { diamond, sec } from './gapsLab';

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

/**
 * AS 65000: R1 (RR), R2, R3 (Clients), OSPF intern. AS 65100: R4 (eBGP zu R2 über 10.0.24.0/24).
 * R3-R4-Link (10.0.34.0/24) bleibt außen vor (shutdown an R3).
 */
function lab() {
  const L = diamond();
  const { r1, r2, r3, r4 } = L;
  r3.run('configure terminal', 'interface gi0/1', 'shutdown', 'end');
  r4.run('configure terminal', 'interface gi0/1', 'shutdown', 'end');
  for (const r of [r1, r2, r3])
    r.run(
      'configure terminal',
      'router ospf 1',
      'network 10.0.12.0 0.0.0.255 area 0',
      'network 10.0.13.0 0.0.0.255 area 0',
      'network 10.1.0.0 0.0.0.255 area 0',
      'end',
    );
  r1.run(
    'configure terminal',
    'router bgp 65000',
    'bgp router-id 1.1.1.1',
    'neighbor 10.0.12.2 remote-as 65000',
    'neighbor 10.0.12.2 route-reflector-client',
    'neighbor 10.0.12.2 send-community',
    'neighbor 10.0.13.3 remote-as 65000',
    'neighbor 10.0.13.3 route-reflector-client',
    'neighbor 10.0.13.3 send-community',
    'network 10.1.0.0 mask 255.255.255.0',
    'end',
  );
  r2.run(
    'configure terminal',
    'ip community-list standard TAG permit 65000:444',
    'route-map FROM-ISP permit 10',
    'set community 65000:444',
    'set local-preference 250',
    'exit',
    'router bgp 65000',
    'bgp router-id 2.2.2.2',
    'neighbor 10.0.12.1 remote-as 65000',
    'neighbor 10.0.12.1 next-hop-self',
    'neighbor 10.0.12.1 send-community',
    'neighbor 10.0.24.4 remote-as 65100',
    'neighbor 10.0.24.4 route-map FROM-ISP in',
    'end',
  );
  r3.run(
    'configure terminal',
    'router bgp 65000',
    'bgp router-id 3.3.3.3',
    'neighbor 10.0.13.1 remote-as 65000',
    'end',
  );
  r4.run(
    'configure terminal',
    'router bgp 65100',
    'bgp router-id 4.4.4.4',
    'neighbor 10.0.24.2 remote-as 65000',
    'network 10.4.0.0 mask 255.255.255.0',
    'end',
  );
  return L;
}

describe('QA BGP route reflector + communities', () => {
  it('R3 learns the eBGP prefix via the RR with community, local-pref and cluster list', () => {
    const { e, r1, r3, r4, pc1, pc4 } = lab();
    sec(e, 120);
    const t3 = r3.run('show ip route');
    // Anzeige wie IOS: der BGP-Next-Hop (10.0.12.2), nicht der rekursiv aufgelöste IGP-Hop; die Weiterleitung
    // nutzt weiter die rekursive Auflösung (Ping unten)
    expect(t3).toMatch(/B\s+10\.4\.0\.0\/24 \[200\/0\] via 10\.0\.12\.2/);
    const d = r3.run('show ip bgp 10.4.0.0');
    expect(d).toContain('65100');
    expect(d).toMatch(/[Ll]ocal(pref|_pref|-pref)\S* 250|localpref 250/);
    expect(d).toContain('Community: 65000:444');
    expect(d).toContain('Originator: 2.2.2.2');
    expect(d).toContain('Cluster list: 1.1.1.1');
    expect(r4.run('show ip route')).toMatch(/B\s+10\.1\.0\.0\/24/);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
    void r1;
    void pc4;
  });

  it('removing route-reflector-client stops reflection; no neighbor clears routes', () => {
    const { e, r1, r3 } = lab();
    sec(e, 120);
    // Routen eines Clients gehen auch an Nicht-Clients: erst ohne beide Client-Markierungen endet die Reflexion
    r1.run(
      'configure terminal',
      'router bgp 65000',
      'no neighbor 10.0.13.3 route-reflector-client',
      'no neighbor 10.0.12.2 route-reflector-client',
      'end',
    );
    r1.run('clear ip bgp *');
    sec(e, 60);
    expect(r3.run('show ip route')).not.toContain('10.4.0.0');
    r1.run('configure terminal', 'router bgp 65000', 'no neighbor 10.0.13.3', 'end');
    // R1 sendet beim Entfernen eine Cease-NOTIFICATION: R3 verwirft die Sitzung sofort (nicht erst nach 180 s)
    sec(e, 2);
    expect(r3.run('show ip bgp summary')).not.toMatch(/10\.0\.13\.1\s+4\s+65000.*\s\d+$/m);
  });
});
