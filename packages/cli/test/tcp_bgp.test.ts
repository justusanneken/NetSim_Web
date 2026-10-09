import { describe, expect, it } from 'vitest';
import { diamond, sec } from './gapsLab';

/** R1 (AS 65001) – R2 (AS 65002) über 10.0.12.0/24; R1 kündigt 10.1.0.0/24 an. */
function lab() {
  const L = diamond();
  const { r1, r2 } = L;
  r1.run(
    'configure terminal',
    'router bgp 65001',
    'bgp router-id 1.1.1.1',
    'neighbor 10.0.12.2 remote-as 65002',
    'network 10.1.0.0 mask 255.255.255.0',
    'end',
  );
  r2.run(
    'configure terminal',
    'router bgp 65002',
    'bgp router-id 2.2.2.2',
    'neighbor 10.0.12.1 remote-as 65001',
    'end',
  );
  return L;
}

describe('BGP und Telnet laufen über TCP', () => {
  it('show tcp brief zeigt die BGP-Verbindung auf Port 179', () => {
    const { e, r1, r2 } = lab();
    sec(e, 30);
    expect(r1.run('show ip bgp summary')).toMatch(/10\.0\.12\.2\s+4\s+65002/);
    const t1 = r1.run('show tcp brief');
    expect(t1).toContain('ESTAB');
    expect(t1).toMatch(
      /10\.0\.12\.1\.\d+\s+10\.0\.12\.2\.179|10\.0\.12\.1\.179\s+10\.0\.12\.2\.\d+/,
    );
    expect(r2.run('show tcp brief')).toContain('ESTAB');
  });

  it('eine ACL, die TCP 179 sperrt, verhindert die Sitzung (Segmente laufen durch den IP-Stack)', () => {
    const { e, r1, r2 } = lab();
    r2.run(
      'configure terminal',
      'ip access-list extended NO-BGP',
      'deny tcp any any eq 179',
      'deny tcp any eq 179 any',
      'permit ip any any',
      'exit',
      'interface gi0/0',
      'ip access-group NO-BGP in',
      'end',
    );
    sec(e, 40);
    expect(r1.run('show ip bgp summary')).toMatch(/10\.0\.12\.2.*(Active|Idle|Connect)/);
    expect(r2.run('show ip route')).not.toContain('10.1.0.0');
    r2.run('configure terminal', 'interface gi0/0', 'no ip access-group NO-BGP in', 'end');
    sec(e, 40);
    expect(r2.run('show ip route')).toMatch(/B\s+10\.1\.0\.0\/24/);
  });

  it('no neighbor: die Gegenstelle verliert Sitzung und Route innerhalb von Sekunden (Cease)', () => {
    const { e, r1, r2 } = lab();
    sec(e, 30);
    expect(r2.run('show ip route')).toMatch(/B\s+10\.1\.0\.0\/24/);
    r1.run('configure terminal', 'router bgp 65001', 'no neighbor 10.0.12.2', 'end');
    sec(e, 2);
    expect(r2.run('show ip route')).not.toContain('10.1.0.0');
    expect(r2.run('show ip bgp summary')).toMatch(/10\.0\.12\.1.*(Idle|Active|Connect)/);
  });

  it('show ip route: iBGP-Route zeigt den BGP-Next-Hop, die Weiterleitung nutzt die IGP-Auflösung', () => {
    const { e, r1, r3, pc1, pc4 } = ibgpLab();
    sec(e, 120);
    // R3 lernt 10.1.0.0/24 per iBGP von R1 (Next Hop 1.1.1.1, Loopback), erreichbar über OSPF
    const t3 = r3.run('show ip route');
    expect(t3).toMatch(/B\s+10\.1\.0\.0\/24 \[200\/0\] via 1\.1\.1\.1/);
    e.ping(pc4, '10.1.0.10', { count: 1 });
    e.runUntil(e.state.now + 6_000_000);
    const cfg = e.getDevice(pc4)?.config;
    expect(cfg?.kind === 'host' && cfg.pings.at(-1)?.status).toBe('reply');
    void r1;
    void pc1;
  });
});

/** R1 – R2 – R3 (alle AS 65000, OSPF + iBGP über Loopbacks), PC1 an R1, PC4 an R3. */
function ibgpLab() {
  const L = diamond();
  const { r1, r2, r4 } = L;
  // Pfad R1 – R2 – R4 (R4 heißt im Test „r3“, der Rand-Router)
  r1.run(
    'configure terminal',
    'interface loopback 0',
    'ip address 1.1.1.1 255.255.255.255',
    'exit',
    'router ospf 1',
    'network 1.1.1.1 0.0.0.0 area 0',
    'network 10.0.12.0 0.0.0.255 area 0',
    'exit',
    'router bgp 65000',
    'bgp router-id 1.1.1.1',
    'neighbor 4.4.4.4 remote-as 65000',
    'neighbor 4.4.4.4 update-source loopback0',
    'network 10.1.0.0 mask 255.255.255.0',
    'end',
  );
  r2.run(
    'configure terminal',
    'router ospf 1',
    'network 10.0.12.0 0.0.0.255 area 0',
    'network 10.0.24.0 0.0.0.255 area 0',
    'exit',
    // Transit-Router ohne BGP: die LANs der Ränder über statische Routen (nur für die Weiterleitung)
    'ip route 10.1.0.0 255.255.255.0 10.0.12.1',
    'ip route 10.4.0.0 255.255.255.0 10.0.24.4',
    'end',
  );
  r4.run(
    'configure terminal',
    'interface loopback 0',
    'ip address 4.4.4.4 255.255.255.255',
    'exit',
    'router ospf 1',
    'network 4.4.4.4 0.0.0.0 area 0',
    'network 10.0.24.0 0.0.0.255 area 0',
    'network 10.4.0.0 0.0.0.255 area 0',
    'exit',
    'router bgp 65000',
    'bgp router-id 4.4.4.4',
    'neighbor 1.1.1.1 remote-as 65000',
    'neighbor 1.1.1.1 update-source loopback0',
    'network 10.4.0.0 mask 255.255.255.0',
    'end',
  );
  return { ...L, r3: r4 };
}
