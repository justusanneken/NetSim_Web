import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession, HostShell } from '../src';

const sec = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

function router(e: Engine, name: string) {
  const id = e.addDevice('router', { name });
  const d = e.getDevice(id);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  return { id, s, run };
}

function link(e: Engine, a: string, ap: string, b: string, bp: string): void {
  const r = e.connect({ deviceId: a, portId: ap }, { deviceId: b, portId: bp }, 'crossover');
  if (!r.ok) throw new Error(r.error);
}

/** R1 – R2 – R3 (je /24 dazwischen), LAN an R1 und R3. */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = router(e, 'R1');
  const r2 = router(e, 'R2');
  const r3 = router(e, 'R3');
  link(e, r1.id, 'p0', r2.id, 'p0');
  link(e, r2.id, 'p1', r3.id, 'p0');
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc3 = e.addDevice('pc', { name: 'PC3' });
  link(e, pc1, 'p0', r1.id, 'p1');
  link(e, pc3, 'p0', r3.id, 'p1');
  e.setHostIp(pc1, '10.1.0.10', '255.255.255.0', '10.1.0.1');
  e.setHostIp(pc3, '10.3.0.10', '255.255.255.0', '10.3.0.1');
  const ifcfg = (r: ReturnType<typeof router>, rows: [string, string][]) =>
    r.run(
      'enable',
      'configure terminal',
      ...rows.flatMap(([i, ip]) => [
        `interface ${i}`,
        `ip address ${ip} 255.255.255.0`,
        'no shutdown',
        'exit',
      ]),
      'end',
    );
  ifcfg(r1, [
    ['gi0/0', '10.0.12.1'],
    ['gi0/1', '10.1.0.1'],
  ]);
  ifcfg(r2, [
    ['gi0/0', '10.0.12.2'],
    ['gi0/1', '10.0.23.2'],
  ]);
  ifcfg(r3, [
    ['gi0/0', '10.0.23.3'],
    ['gi0/1', '10.3.0.1'],
  ]);
  return { e, r1, r2, r3, pc1, pc3 };
}

describe('CLI Phase 4: OSPF', () => {
  it('router ospf + network … area; show ip ospf neighbor/route/interface brief; Ping', () => {
    const { e, r1, r2, r3, pc1 } = lab();
    for (const r of [r1, r2, r3])
      r.run(
        'configure terminal',
        'router ospf 1',
        'network 10.0.0.0 0.255.255.255 area 0',
        'exit',
        'end',
      );
    sec(e, 120);
    const nb = r1.run('show ip ospf neighbor');
    expect(nb).toMatch(/FULL\/(DR|BDR)/);
    const rt = r1.run('show ip route');
    expect(rt).toMatch(/O\s+10\.3\.0\.0\/24 \[110\/3\] via 10\.0\.12\.2/);
    expect(r1.run('show ip ospf interface brief')).toContain('Gi0/0');
    expect(r1.run('show ip protocols')).toContain('Routing Protocol is "ospf 1"');
    expect(r1.run('show ip ospf database')).toContain('Router Link States (Area 0)');
    const p = r1.run('ping 10.3.0.10');
    expect(p).toContain('!!!!');
    void pc1;
  });

  it('debug ip ospf adj liefert asynchrone Zeilen (poll)', () => {
    const { e, r1, r2, r3 } = lab();
    r1.run('enable', 'debug ip ospf adj');
    expect(r1.run('show debugging')).toContain('OSPF adjacency events debugging is on');
    for (const r of [r1, r2, r3])
      r.run(
        'configure terminal',
        'router ospf 1',
        'network 10.0.0.0 0.255.255.255 area 0',
        'exit',
        'end',
      );
    sec(e, 80);
    const out = r1.s.poll();
    expect(out).toMatch(/^\*Mar {2}1 00:\d\d:\d\d\.\d{3}: OSPF-1 ADJ/m);
    expect(out).toContain('EXSTART');
    expect(r1.s.poll()).toBe('');
    r1.run('undebug all');
    expect(r1.run('show debugging')).not.toContain('OSPF');
  });

  it('debug-Cursor überlebt das Trimmen des Engine-Logs (absolute Ids)', () => {
    const { e, r1, r2, r3 } = lab();
    r1.run('enable', 'debug ip ospf adj');
    e.state.config.maxLogEntries = 40;
    for (const r of [r1, r2, r3])
      r.run(
        'configure terminal',
        'router ospf 1',
        'network 10.0.0.0 0.255.255.255 area 0',
        'exit',
        'end',
      );
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      sec(e, 2);
      for (const line of r1.s.poll().split('\n').filter(Boolean)) seen.push(line);
    }
    expect(e.logOffset).toBeGreaterThan(0);
    expect(e.log.length).toBeLessThanOrEqual(40);
    expect(seen.some((l) => /OSPF-1 ADJ/.test(l))).toBe(true);
    // keine Wiederholungen trotz Trimmen (Zeitstempel + Text sind je Ereignis eindeutig genug)
    expect(new Set(seen).size).toBe(seen.length);
    expect(r1.s.poll()).toBe('');
  });

  it('running-config enthält Router-Blöcke und wird per Replay identisch wiederhergestellt', () => {
    const { e, r1, r2, r3 } = lab();
    r1.run(
      'enable',
      'configure terminal',
      'ip routing',
      'interface loopback 0',
      'ip address 1.1.1.1 255.255.255.255',
      'exit',
      'router ospf 1',
      'router-id 1.1.1.1',
      'auto-cost reference-bandwidth 1000',
      'passive-interface gi0/1',
      'network 10.0.0.0 0.255.255.255 area 0',
      'default-information originate always',
      'redistribute static subnets',
      'exit',
      'router rip',
      'version 2',
      'network 10.0.0.0',
      'no auto-summary',
      'redistribute ospf 1 metric 3',
      'exit',
      'router eigrp 100',
      'network 10.0.0.0',
      'no auto-summary',
      'passive-interface default',
      'no passive-interface gi0/0',
      'exit',
      'router bgp 65001',
      'bgp router-id 1.1.1.1',
      'neighbor 10.0.12.2 remote-as 65002',
      'neighbor 10.0.12.2 next-hop-self',
      'neighbor 10.0.12.2 update-source loopback 0',
      'network 10.1.0.0 mask 255.255.255.0',
      'exit',
      'interface gi0/0',
      'ip ospf 1 area 0',
      'ip ospf cost 5',
      'ip ospf network point-to-point',
      'standby 1 ip 10.0.12.254',
      'standby 1 priority 110',
      'standby 1 preempt',
      'standby 1 track gi0/1 20',
      'bandwidth 1000000',
      'ipv6 address 2001:db8:12::1/64',
      'exit',
      'ipv6 unicast-routing',
      'ipv6 route 2001:db8:99::/64 2001:db8:12::2',
      'interface tunnel 0',
      'ip address 172.16.0.1 255.255.255.252',
      'tunnel source loopback 0',
      'tunnel destination 3.3.3.3',
      'tunnel mode gre ip',
      'end',
    );
    const before = r1.s.input('show running-config');
    for (const must of [
      'router ospf 1',
      'router rip',
      'router eigrp 100',
      'router bgp 65001',
      'standby 1 preempt',
      'ipv6 unicast-routing',
      'interface Tunnel0',
      'tunnel destination 3.3.3.3',
      'ip ospf network point-to-point',
    ]) {
      expect(before).toContain(must);
    }
    r1.run('copy running-config startup-config', '');
    // Neu laden: Konfiguration aus Startup-Text wiederherstellen
    r1.run('reload', '');
    const again = new CliSession(e, r1.id);
    again.input('enable');
    const after = again.input('show running-config');
    const strip = (s: string): string => s.replace(/Current configuration.*\n/, '');
    expect(strip(after)).toBe(strip(before));
    void r2;
    void r3;
  });
});

describe('CLI Phase 4: EIGRP, HSRP, BGP, IPv6', () => {
  it('EIGRP: show ip eigrp neighbors/topology', () => {
    const { e, r1, r2, r3 } = lab();
    for (const r of [r1, r2, r3])
      r.run(
        'configure terminal',
        'router eigrp 100',
        'network 10.0.0.0',
        'no auto-summary',
        'exit',
        'end',
      );
    sec(e, 40);
    expect(r1.run('show ip eigrp neighbors')).toContain('10.0.12.2');
    expect(r1.run('show ip eigrp topology')).toContain('P 10.3.0.0/24, 1 successors');
    expect(r1.run('show ip route eigrp')).toMatch(/D\s+10\.3\.0\.0\/24 \[90\//);
  });

  it('BGP: eBGP zwischen zwei Routern, show ip bgp / summary', () => {
    const { e, r1, r2 } = lab();
    r1.run(
      'configure terminal',
      'router bgp 100',
      'neighbor 10.0.12.2 remote-as 200',
      'network 10.1.0.0 mask 255.255.255.0',
      'exit',
      'end',
    );
    r2.run(
      'configure terminal',
      'router bgp 200',
      'neighbor 10.0.12.1 remote-as 100',
      'exit',
      'end',
    );
    sec(e, 30);
    expect(r2.run('show ip bgp')).toContain('*> 10.1.0.0/24');
    expect(r2.run('show ip bgp summary')).toMatch(/10\.0\.12\.1\s+4\s+100/);
    expect(r1.run('show ip bgp summary')).toContain('local AS number 100');
  });

  it('HSRP: show standby brief', () => {
    const { e, r1, r2 } = lab();
    for (const [r, ip, prio] of [
      [r1, '10.0.12.1', 110],
      [r2, '10.0.12.2', 100],
    ] as const) {
      r.run(
        'configure terminal',
        'interface gi0/0',
        'standby 1 ip 10.0.12.254',
        `standby 1 priority ${prio}`,
        'standby 1 preempt',
        'end',
      );
      void ip;
    }
    sec(e, 60);
    expect(r1.run('show standby brief')).toMatch(/Gi0\/0\s+1\s+110 P Active\s+local/);
    expect(r2.run('show standby brief')).toMatch(/Gi0\/0\s+1\s+100 P Standby/);
  });

  it('IPv6: Adressen, statische Route, ping, show ipv6 interface brief/route', () => {
    const e = new Engine({ seed: 1 });
    const a = router(e, 'A');
    const b = router(e, 'B');
    link(e, a.id, 'p0', b.id, 'p0');
    a.run(
      'enable',
      'configure terminal',
      'ipv6 unicast-routing',
      'interface gi0/0',
      'ipv6 address 2001:db8:12::1/64',
      'no shutdown',
      'exit',
      'interface loopback 0',
      'ipv6 address 2001:db8:a::1/128',
      'end',
    );
    b.run(
      'enable',
      'configure terminal',
      'ipv6 unicast-routing',
      'interface gi0/0',
      'ipv6 address 2001:db8:12::2/64',
      'no shutdown',
      'exit',
      'ipv6 route 2001:db8:a::/64 2001:db8:12::1',
      'end',
    );
    sec(e, 2);
    expect(b.run('show ipv6 interface brief')).toContain('2001:DB8:12::2');
    expect(b.run('show ipv6 route')).toContain('S   2001:DB8:A::/64 [1/0]');
    expect(b.run('ping ipv6 2001:db8:12::1')).toContain('!!!!!');
    expect(b.run('show ipv6 neighbors')).toContain('2001:DB8:12::1');
  });

  it('Host-Shell: ping/ipconfig mit IPv6', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R');
    const pc = e.addDevice('pc', { name: 'PC' });
    link(e, pc, 'p0', r.id, 'p0');
    r.run(
      'enable',
      'configure terminal',
      'ipv6 unicast-routing',
      'interface gi0/0',
      'ipv6 address 2001:db8:1::1/64',
      'no shutdown',
      'end',
    );
    e.setHostIpv6(pc, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' });
    sec(e, 1);
    const sh = new HostShell(e, pc);
    expect(sh.input('ping 2001:db8:1::1')).toContain('Reply from 2001:db8:1::1');
    expect(sh.input('ipconfig')).toContain('IPv6 Address');
  });
});

describe('CLI Phase 4: breite Befehlsabdeckung', () => {
  const ctx = (out: string): string =>
    out
      .split('\n')
      .map((l, i, a) => (l.startsWith('%') ? a.slice(Math.max(0, i - 6), i + 1).join(' | ') : ''))
      .filter(Boolean)
      .join('\n');

  it('Router-Konfigurationsbefehle ohne Fehlermeldungen; negierte Formen; Anzeige', () => {
    const { e, r1, r2 } = lab();
    const out = r1.run(
      'enable',
      'configure terminal',
      'router rip',
      'version 2',
      'network 10.0.0.0',
      'passive-interface gi0/1',
      'no passive-interface gi0/1',
      'passive-interface default',
      'no passive-interface default',
      'auto-summary',
      'no auto-summary',
      'default-information originate',
      'no default-information originate',
      'default-metric 2',
      'timers basic 10 60 60 80',
      'no timers basic',
      'redistribute connected metric 1',
      'redistribute static',
      'no redistribute static',
      'maximum-paths 4',
      'exit',
      'router ospf 7',
      'router-id 7.7.7.7',
      'network 10.0.0.0 0.255.255.255 area 0',
      'network 192.168.0.0 0.0.255.255 area 1',
      'no network 192.168.0.0 0.0.255.255 area 1',
      'passive-interface gi0/1',
      'auto-cost reference-bandwidth 1000',
      'area 1 range 10.9.0.0 255.255.0.0',
      'area 1 range 10.8.0.0 255.255.0.0 not-advertise',
      'no area 1 range 10.8.0.0 255.255.0.0',
      'default-information originate metric 5 metric-type 1',
      'redistribute connected subnets',
      'redistribute rip metric 10 metric-type 2 subnets',
      'redistribute eigrp 10 subnets',
      'redistribute bgp 100 subnets',
      'log-adjacency-changes',
      'exit',
      'ipv6 router ospf 3',
      'router-id 3.3.3.3',
      'default-information originate always',
      'auto-cost reference-bandwidth 500',
      'passive-interface gi0/1',
      'exit',
      'router eigrp 10',
      'network 10.0.0.0',
      'network 172.16.0.0 0.0.255.255',
      'eigrp router-id 9.9.9.9',
      'variance 2',
      'passive-interface gi0/1',
      'redistribute static metric 10000 100 255 1 1500',
      'redistribute ospf 7 metric 10000 100 255 1 1500',
      'no auto-summary',
      'exit',
      'router bgp 65000',
      'bgp router-id 9.9.9.9',
      'bgp default local-preference 150',
      'neighbor 10.0.12.2 remote-as 65001',
      'neighbor 10.0.12.2 description peer',
      'neighbor 10.0.12.2 weight 10',
      'neighbor 10.0.12.2 ebgp-multihop 3',
      'neighbor 10.0.12.2 shutdown',
      'no neighbor 10.0.12.2 shutdown',
      'neighbor 10.0.12.2 next-hop-self',
      'network 10.1.0.0 mask 255.255.255.0',
      'network 172.16.0.0',
      'redistribute connected',
      'redistribute ospf 7 metric 5',
      'no synchronization',
      'exit',
      'interface gi0/0',
      'ip ospf 7 area 0',
      'ip ospf cost 10',
      'ip ospf priority 0',
      'ip ospf hello-interval 5',
      'ip ospf dead-interval 20',
      'ip ospf network broadcast',
      'no ip ospf cost',
      'ipv6 ospf 3 area 0',
      'ipv6 ospf cost 4',
      'ipv6 ospf priority 2',
      'ipv6 ospf hello-interval 5',
      'ipv6 ospf dead-interval 20',
      'ipv6 ospf network point-to-point',
      'ipv6 enable',
      'ipv6 nd ra suppress',
      'ipv6 address autoconfig',
      'no ipv6 address autoconfig',
      'ipv6 address 2001:db8:5::/64 eui-64',
      'delay 100',
      'bandwidth 100000',
      'no ip split-horizon',
      'standby 2 ip 10.0.12.99',
      'standby 2 timers 1 3',
      'standby 2 name WEB',
      'standby 2 track gi0/1',
      'no standby 2 track gi0/1',
      'no standby 2 ip',
      'exit',
      'interface loopback 5',
      'ip address 5.5.5.5 255.255.255.255',
      'exit',
      'no interface loopback 5',
      'interface tunnel 3',
      'tunnel source gi0/0',
      'tunnel destination 2.2.2.2',
      'no tunnel destination',
      'exit',
      'no interface tunnel 3',
      'ipv6 unicast-routing',
      'ipv6 route 2001:db8:77::/64 gi0/0',
      'ipv6 route 2001:db8:78::/64 fe80::1 gi0/0 5',
      'no ipv6 route 2001:db8:78::/64 fe80::1 gi0/0 5',
      'no router rip',
      'no router ospf 7',
      'no ipv6 router ospf 3',
      'no router eigrp 10',
      'no router bgp 65000',
      'end',
    );
    expect(
      out.split('\n').filter((l) => l.startsWith('%')),
      ctx(out),
    ).toEqual([]);
    sec(e, 1);
    // Anzeige- und Clear-Befehle sind auch ohne laufende Prozesse sicher
    const shows = r2.run(
      'enable',
      'show ip protocols',
      'show ip rip database',
      'show ip ospf',
      'show ip ospf neighbor',
      'show ip ospf interface',
      'show ip ospf interface brief',
      'show ip ospf database router',
      'show ipv6 ospf neighbor',
      'show ipv6 ospf interface brief',
      'show ipv6 ospf database',
      'show ip eigrp neighbors',
      'show ip eigrp topology',
      'show ip eigrp interfaces',
      'show standby',
      'show standby brief',
      'show ip bgp',
      'show ip bgp summary',
      'show ip bgp neighbors',
      'show ipv6 route',
      'show ipv6 interface',
      'show ipv6 neighbors',
      'show ipv6 protocols',
      'show debugging',
      'show ip route connected',
      'show ip route static',
      'clear ip ospf process',
      'clear ip bgp *',
      'clear ip route *',
      'debug ip rip',
      'debug ip ospf events',
      'debug ip ospf hello',
      'debug ip ospf packet',
      'debug ip ospf spf',
      'debug ip ospf lsa-generation',
      'debug eigrp packets',
      'debug eigrp fsm',
      'debug eigrp neighbors',
      'debug standby',
      'debug ip bgp',
      'debug ip routing',
      'debug tunnel',
      'show debugging',
      'no debug ip rip',
      'debug all',
      'no debug all',
    );
    expect(
      shows.split('\n').filter((l) => l.startsWith('%') && l !== '% BGP not active'),
      ctx(shows),
    ).toEqual([]);
    expect(shows).toContain('IP routing debugging is on');
  });

  it('Aktive Protokolle: ausführliche Anzeigen mit echten Daten', () => {
    const { e, r1, r2, r3 } = lab();
    for (const r of [r1, r2, r3])
      r.run(
        'configure terminal',
        'router ospf 1',
        'network 10.0.0.0 0.255.255.255 area 0',
        'redistribute connected subnets',
        'exit',
        'router eigrp 5',
        'network 10.0.0.0',
        'no auto-summary',
        'exit',
        'router rip',
        'network 10.0.0.0',
        'no auto-summary',
        'exit',
        'end',
      );
    r1.run('debug ip routing');
    sec(e, 120);
    const proto = r2.run('show ip protocols');
    expect(proto).toContain('Routing Protocol is "rip"');
    expect(proto).toContain('Routing Protocol is "eigrp 5"');
    expect(r2.run('show ip rip database')).toContain('directly connected');
    expect(r2.run('show ip ospf')).toContain('Routing Process "ospf 1"');
    expect(r2.run('show ip ospf interface gi0/0')).toBeDefined();
    expect(r2.run('show ip ospf database external')).toContain('Type-5 AS External Link States');
    expect(r2.run('show ip eigrp interfaces')).toContain('EIGRP-IPv4 Interfaces for AS(5)');
    expect(r2.run('show ip route rip')).toBeDefined();
    expect(r1.s.poll()).toContain('RT: add');
    expect(r1.run('show ip route 10.3.0.0')).toContain('Routing entry for 10.3.0.0/24');
  });
});
