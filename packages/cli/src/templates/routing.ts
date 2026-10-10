import type { Lab } from './lab';
import type { Template } from './types';

const must = (r: { ok: boolean; error?: string }): void => {
  if (!r.ok) throw new Error(`template: ${r.error ?? 'failed'}`);
};

const ifc = (name: string, ip: string, mask = '255.255.255.0', extra: string[] = []): string[] => [
  `interface ${name}`,
  `ip address ${ip} ${mask}`,
  ...extra,
  'no shutdown',
  'exit',
];

export const OSPF3: Template = {
  id: 'ospf-3-routers',
  level: 'intermediate',
  title: { de: 'OSPF mit drei Routern', en: 'OSPF with three routers' },
  summary: {
    de: 'Drei Router im Dreieck (Area 0) lernen ihre LANs per OSPF. Fällt eine Verbindung aus, nimmt der Verkehr den Umweg.',
    en: 'Three routers in a triangle (area 0) learn their LANs via OSPF. If a link fails, traffic takes the detour.',
  },
  goals: {
    de: [
      'router ospf, router-id, network-Anweisungen und passive-interface anwenden',
      'Nachbarschaften mit show ip ospf neighbor prüfen',
      'Kabel zwischen R1 und R3 trennen und die neue Route in show ip route beobachten',
    ],
    en: [
      'Apply router ospf, router-id, network statements and passive-interface',
      'Check adjacencies with show ip ospf neighbor',
      'Unplug the cable between R1 and R3 and watch the new route in show ip route',
    ],
  },
  settleSec: 90,
  build(l: Lab) {
    l.add('router', 'R1', 240, 40);
    l.add('router', 'R2', 80, 220);
    l.add('router', 'R3', 400, 220);
    l.add('pc', 'PC1', 240, -60);
    l.add('pc', 'PC2', -20, 320);
    l.add('pc', 'PC3', 500, 320);
    l.link('R1', 'Gi0/0', 'R2', 'Gi0/0');
    l.link('R1', 'Gi0/1', 'R3', 'Gi0/0');
    l.link('R2', 'Gi0/1', 'R3', 'Gi0/1');
    l.link('R1', 'Gi0/2', 'PC1', 'Fa0');
    l.link('R2', 'Gi0/2', 'PC2', 'Fa0');
    l.link('R3', 'Gi0/2', 'PC3', 'Fa0');
    l.host('PC1', '192.168.1.10', '255.255.255.0', '192.168.1.1');
    l.host('PC2', '192.168.2.10', '255.255.255.0', '192.168.2.1');
    l.host('PC3', '192.168.3.10', '255.255.255.0', '192.168.3.1');
    const r = (
      name: string,
      rid: string,
      a: [string, string],
      b: [string, string],
      lan: string,
      nets: [string, string][],
    ) =>
      l.cli(name, [
        ...ifc(a[0], a[1], '255.255.255.252'),
        ...ifc(b[0], b[1], '255.255.255.252'),
        ...ifc('gi0/2', lan),
        'router ospf 1',
        `router-id ${rid}`,
        ...nets.map(([n, w]) => `network ${n} ${w} area 0`),
        'passive-interface gi0/2',
      ]);
    r('R1', '1.1.1.1', ['gi0/0', '10.0.12.1'], ['gi0/1', '10.0.13.1'], '192.168.1.1', [
      ['10.0.12.0', '0.0.0.3'],
      ['10.0.13.0', '0.0.0.3'],
      ['192.168.1.0', '0.0.0.255'],
    ]);
    r('R2', '2.2.2.2', ['gi0/0', '10.0.12.2'], ['gi0/1', '10.0.23.2'], '192.168.2.1', [
      ['10.0.12.0', '0.0.0.3'],
      ['10.0.23.0', '0.0.0.3'],
      ['192.168.2.0', '0.0.0.255'],
    ]);
    r('R3', '3.3.3.3', ['gi0/0', '10.0.13.3'], ['gi0/1', '10.0.23.3'], '192.168.3.1', [
      ['10.0.13.0', '0.0.0.3'],
      ['10.0.23.0', '0.0.0.3'],
      ['192.168.3.0', '0.0.0.255'],
    ]);
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '192.168.3.10',
      expect: 'ok',
      label: { de: 'PC1 erreicht PC3 (über R3)', en: 'PC1 reaches PC3 (via R3)' },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '192.168.3.10',
      expect: 'ok',
      label: { de: 'PC2 erreicht PC3', en: 'PC2 reaches PC3' },
    },
    {
      kind: 'ping',
      from: 'PC3',
      to: '192.168.1.10',
      expect: 'ok',
      label: { de: 'PC3 erreicht PC1', en: 'PC3 reaches PC1' },
    },
  ],
  verify(l: Lab) {
    const out = l.show('R1', 'show ip route');
    return /O\s+192\.168\.3\.0/.test(out) ? undefined : 'R1 has no OSPF route to 192.168.3.0/24';
  },
};

export const NAT_PAT: Template = {
  id: 'nat-pat',
  level: 'intermediate',
  title: { de: 'NAT/PAT mit DMZ-Webserver', en: 'NAT/PAT with DMZ web server' },
  summary: {
    de: 'Drei interne PCs gehen per PAT über eine öffentliche Adresse ins Internet. Der Webserver in der DMZ ist per statischem NAT unter 203.0.113.3 erreichbar.',
    en: 'Three internal PCs reach the Internet through one public address via PAT. The DMZ web server is reachable by static NAT at 203.0.113.3.',
  },
  goals: {
    de: [
      'ip nat inside/outside und Overload (PAT) konfigurieren',
      'Statisches NAT für einen Server veröffentlichen',
      'Übersetzungen mit show ip nat translations verfolgen',
    ],
    en: [
      'Configure ip nat inside/outside and overload (PAT)',
      'Publish a server using static NAT',
      'Follow translations with show ip nat translations',
    ],
  },
  settleSec: 70,
  build(l: Lab) {
    l.add('router', 'EDGE', 260, 100);
    l.add('router', 'ISP', 440, 100);
    l.add('server', 'INET', 600, 100);
    l.add('switch-l2', 'SW1', 100, 100);
    l.add('server', 'DMZ-WEB', 260, 240);
    l.add('pc', 'PC1', 20, 220);
    l.add('pc', 'PC2', 100, 240);
    l.add('pc', 'PC3', 180, 220);
    l.link('SW1', 'Fa0/24', 'EDGE', 'Gi0/0');
    l.link('EDGE', 'Gi0/1', 'ISP', 'Gi0/0');
    l.link('EDGE', 'Gi0/2', 'DMZ-WEB', 'Fa0');
    l.link('ISP', 'Gi0/1', 'INET', 'Fa0');
    l.link('SW1', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SW1', 'Fa0/2', 'PC2', 'Fa0');
    l.link('SW1', 'Fa0/3', 'PC3', 'Fa0');
    for (const [i, pc] of ['PC1', 'PC2', 'PC3'].entries())
      l.host(pc, `192.168.10.${10 + i}`, '255.255.255.0', '192.168.10.1');
    l.host('DMZ-WEB', '172.16.0.10', '255.255.255.0', '172.16.0.1');
    l.host('INET', '198.51.100.10', '255.255.255.0', '198.51.100.1');
    must(
      l.e.setService(l.id('DMZ-WEB'), {
        http: { enabled: true, https: false, pages: { '/': '<h1>DMZ</h1>' } },
      }),
    );
    must(
      l.e.setService(l.id('INET'), {
        http: { enabled: true, https: false, pages: { '/': '<h1>Internet</h1>' } },
      }),
    );
    l.cli('ISP', [
      ...ifc('gi0/0', '203.0.113.1', '255.255.255.248'),
      ...ifc('gi0/1', '198.51.100.1'),
    ]);
    l.cli('EDGE', [
      ...ifc('gi0/0', '192.168.10.1', '255.255.255.0', ['description Inside LAN', 'ip nat inside']),
      ...ifc('gi0/1', '203.0.113.2', '255.255.255.248', ['description Outside', 'ip nat outside']),
      ...ifc('gi0/2', '172.16.0.1', '255.255.255.0', ['description DMZ', 'ip nat inside']),
      'access-list 1 permit 192.168.10.0 0.0.0.255',
      'ip nat inside source list 1 interface gi0/1 overload',
      'ip nat inside source static 172.16.0.10 203.0.113.3',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
    ]);
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '198.51.100.10',
      expect: 'ok',
      label: { de: 'PC1 erreicht das Internet (PAT)', en: 'PC1 reaches the Internet (PAT)' },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '198.51.100.10',
      expect: 'ok',
      label: { de: 'PC2 erreicht das Internet (PAT)', en: 'PC2 reaches the Internet (PAT)' },
    },
    {
      kind: 'ping',
      from: 'PC3',
      to: '198.51.100.10',
      expect: 'ok',
      label: { de: 'PC3 erreicht das Internet (PAT)', en: 'PC3 reaches the Internet (PAT)' },
    },
    {
      kind: 'http',
      from: 'INET',
      to: 'http://203.0.113.3/',
      expect: 'ok',
      label: {
        de: 'Das Internet erreicht den DMZ-Webserver über die öffentliche Adresse',
        en: 'The Internet reaches the DMZ web server at its public address',
      },
    },
    {
      kind: 'ping',
      from: 'INET',
      to: '192.168.10.10',
      expect: 'fail',
      label: {
        de: 'Interne Adressen sind aus dem Internet nicht erreichbar',
        en: 'Internal addresses are not reachable from the Internet',
      },
    },
  ],
};

export const DHCP_RELAY: Template = {
  id: 'dhcp-relay',
  level: 'intermediate',
  title: { de: 'DHCP-Relay', en: 'DHCP relay' },
  summary: {
    de: 'Der DHCP-Server steht in einem anderen Subnetz. Der Router leitet DHCP-Broadcasts der Clients per ip helper-address als Unicast weiter.',
    en: 'The DHCP server lives in another subnet. The router forwards client DHCP broadcasts as unicast using ip helper-address.',
  },
  goals: {
    de: [
      'Verstehen, warum DHCP-Broadcasts Router nicht überqueren',
      'ip helper-address auf der Client-Schnittstelle setzen',
      'Im Simulationsmodus DISCOVER, OFFER, REQUEST und ACK verfolgen (giaddr beachten)',
    ],
    en: [
      'Understand why DHCP broadcasts do not cross routers',
      'Set ip helper-address on the client-facing interface',
      'Follow DISCOVER, OFFER, REQUEST and ACK in simulation mode (note giaddr)',
    ],
  },
  settleSec: 70,
  build(l: Lab) {
    l.add('router', 'R1', 260, 100);
    l.add('switch-l2', 'SW1', 100, 100);
    l.add('server', 'DHCP-SRV', 440, 100);
    l.add('pc', 'PC1', 20, 220);
    l.add('pc', 'PC2', 180, 220);
    l.link('SW1', 'Fa0/24', 'R1', 'Gi0/0');
    l.link('R1', 'Gi0/1', 'DHCP-SRV', 'Fa0');
    l.link('SW1', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SW1', 'Fa0/2', 'PC2', 'Fa0');
    l.host('DHCP-SRV', '10.0.20.10', '255.255.255.0', '10.0.20.1');
    must(
      l.e.setService(l.id('DHCP-SRV'), {
        dhcp: {
          enabled: true,
          pools: [
            {
              name: 'CLIENTS',
              network: '10.0.10.0',
              mask: '255.255.255.0',
              router: '10.0.10.1',
              dns: [],
              leaseSec: 86400,
              rangeStart: '10.0.10.100',
              rangeEnd: '10.0.10.150',
            },
          ],
          excluded: [],
          bindings: {},
          conflicts: [],
        },
      }),
    );
    l.cli('R1', [
      ...ifc('gi0/0', '10.0.10.1', '255.255.255.0', [
        'description Client LAN',
        'ip helper-address 10.0.20.10',
      ]),
      ...ifc('gi0/1', '10.0.20.1', '255.255.255.0', ['description Server LAN']),
    ]);
    must(l.e.setHostDhcp(l.id('PC1'), true));
    must(l.e.setHostDhcp(l.id('PC2'), true));
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.0.20.10',
      expect: 'ok',
      label: {
        de: 'PC1 (per DHCP konfiguriert) erreicht den Server',
        en: 'PC1 (configured by DHCP) reaches the server',
      },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '10.0.10.1',
      expect: 'ok',
      label: { de: 'PC2 erreicht sein Gateway', en: 'PC2 reaches its gateway' },
    },
  ],
  verify(l: Lab) {
    for (const pc of ['PC1', 'PC2']) {
      const ip = l.hostCfg(pc).ip ?? '';
      if (!ip.startsWith('10.0.10.1'))
        return `${pc} got no lease from the relayed pool (ip=${ip || 'none'})`;
    }
    return undefined;
  },
};

export const ACL_LAB: Template = {
  id: 'acl-lab',
  level: 'intermediate',
  title: { de: 'ACL-Labor: Web gezielt sperren', en: 'ACL lab: blocking web selectively' },
  summary: {
    de: 'Eine erweiterte ACL verbietet PC2 den HTTP-Zugriff auf den Server. Ping und alle anderen Dienste sowie PC1 sind nicht betroffen.',
    en: 'An extended ACL denies PC2 HTTP access to the server. Ping, all other services and PC1 are unaffected.',
  },
  goals: {
    de: [
      'Eine benannte erweiterte ACL schreiben (deny tcp host … eq 80, permit ip any any)',
      'Richtung und Ort der ACL begründen (ip access-group … in)',
      'Treffer mit show access-lists beobachten, das implizite deny am Ende kennen',
    ],
    en: [
      'Write a named extended ACL (deny tcp host … eq 80, permit ip any any)',
      'Justify direction and placement of the ACL (ip access-group … in)',
      'Watch the match counters with show access-lists, know the implicit deny at the end',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('router', 'R1', 260, 100);
    l.add('switch-l2', 'SW1', 100, 100);
    l.add('server', 'WEB', 440, 100);
    l.add('pc', 'PC1', 20, 220);
    l.add('pc', 'PC2', 180, 220);
    l.link('SW1', 'Fa0/24', 'R1', 'Gi0/0');
    l.link('R1', 'Gi0/1', 'WEB', 'Fa0');
    l.link('SW1', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SW1', 'Fa0/2', 'PC2', 'Fa0');
    l.host('PC1', '10.0.1.11', '255.255.255.0', '10.0.1.1');
    l.host('PC2', '10.0.1.12', '255.255.255.0', '10.0.1.1');
    l.host('WEB', '10.0.2.10', '255.255.255.0', '10.0.2.1');
    must(
      l.e.setService(l.id('WEB'), {
        http: { enabled: true, https: false, pages: { '/': '<h1>Intranet</h1>' } },
      }),
    );
    l.cli('R1', [
      'ip access-list extended NO-WEB-PC2',
      'deny tcp host 10.0.1.12 host 10.0.2.10 eq 80',
      'permit ip any any',
      'exit',
      ...ifc('gi0/0', '10.0.1.1', '255.255.255.0', ['ip access-group NO-WEB-PC2 in']),
      ...ifc('gi0/1', '10.0.2.1'),
    ]);
  },
  checks: [
    {
      kind: 'http',
      from: 'PC1',
      to: 'http://10.0.2.10/',
      expect: 'ok',
      label: { de: 'PC1 darf die Webseite abrufen', en: 'PC1 may fetch the web page' },
    },
    {
      kind: 'http',
      from: 'PC2',
      to: 'http://10.0.2.10/',
      expect: 'fail',
      label: { de: 'PC2 wird beim HTTP-Zugriff blockiert', en: 'PC2 is blocked from HTTP' },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '10.0.2.10',
      expect: 'ok',
      label: { de: 'PC2 darf den Server weiterhin anpingen', en: 'PC2 can still ping the server' },
    },
  ],
};

export const HSRP: Template = {
  id: 'hsrp',
  level: 'advanced',
  title: { de: 'HSRP-Gateway-Redundanz', en: 'HSRP gateway redundancy' },
  summary: {
    de: 'R1 (Priorität 110, Preempt) und R2 teilen sich die virtuelle Gateway-Adresse 10.0.0.254. OSPF verbindet beide mit dem Kern-Router R3.',
    en: 'R1 (priority 110, preempt) and R2 share the virtual gateway address 10.0.0.254. OSPF connects both to the core router R3.',
  },
  goals: {
    de: [
      'standby ip, priority und preempt konfigurieren',
      'Active/Standby mit show standby brief prüfen',
      'Gi0/0 an R1 abschalten und den Wechsel des aktiven Routers beobachten',
    ],
    en: [
      'Configure standby ip, priority and preempt',
      'Verify Active/Standby with show standby brief',
      'Shut down Gi0/0 on R1 and watch the active router change',
    ],
  },
  settleSec: 120,
  build(l: Lab) {
    l.add('router', 'R1', 120, 100);
    l.add('router', 'R2', 280, 100);
    l.add('router', 'R3', 200, -40);
    l.add('switch-l2', 'SW1', 200, 200);
    l.add('pc', 'PC1', 200, 310);
    l.link('SW1', 'Fa0/1', 'R1', 'Gi0/0');
    l.link('SW1', 'Fa0/2', 'R2', 'Gi0/0');
    l.link('SW1', 'Fa0/3', 'PC1', 'Fa0');
    l.link('R1', 'Gi0/1', 'R3', 'Gi0/0');
    l.link('R2', 'Gi0/1', 'R3', 'Gi0/1');
    l.host('PC1', '10.0.0.10', '255.255.255.0', '10.0.0.254');
    const edge = (name: string, lan: string, up: string, prio: number, rid: string) =>
      l.cli(name, [
        ...ifc('gi0/0', lan, '255.255.255.0', [
          'standby version 2',
          'standby 10 ip 10.0.0.254',
          `standby 10 priority ${prio}`,
          'standby 10 preempt',
        ]),
        ...ifc('gi0/1', up, '255.255.255.252'),
        'router ospf 1',
        `router-id ${rid}`,
        'network 10.0.0.0 0.0.0.255 area 0',
        `network ${up.replace(/\d+$/, '0')} 0.0.0.3 area 0`,
        'passive-interface gi0/0',
      ]);
    edge('R1', '10.0.0.1', '10.0.13.1', 110, '1.1.1.1');
    edge('R2', '10.0.0.2', '10.0.23.2', 100, '2.2.2.2');
    l.cli('R3', [
      ...ifc('gi0/0', '10.0.13.3', '255.255.255.252'),
      ...ifc('gi0/1', '10.0.23.3', '255.255.255.252'),
      ...ifc('loopback0', '8.8.8.8', '255.255.255.255'),
      'router ospf 1',
      'router-id 3.3.3.3',
      'network 10.0.13.0 0.0.0.3 area 0',
      'network 10.0.23.0 0.0.0.3 area 0',
      'network 8.8.8.8 0.0.0.0 area 0',
    ]);
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.0.0.254',
      expect: 'ok',
      label: {
        de: 'PC1 erreicht die virtuelle Gateway-Adresse',
        en: 'PC1 reaches the virtual gateway address',
      },
    },
    {
      kind: 'ping',
      from: 'PC1',
      to: '8.8.8.8',
      expect: 'ok',
      label: {
        de: 'PC1 erreicht das Ziel hinter dem Kern-Router',
        en: 'PC1 reaches the target behind the core router',
      },
    },
  ],
  verify(l: Lab) {
    return /Active/.test(l.show('R1', 'show standby brief')) ? undefined : 'R1 is not HSRP Active';
  },
};

export const BGP: Template = {
  id: 'bgp-ebgp',
  level: 'advanced',
  title: {
    de: 'eBGP zwischen drei autonomen Systemen',
    en: 'eBGP between three autonomous systems',
  },
  summary: {
    de: 'AS 65001 – AS 65002 – AS 65003: Jeder AS kündigt sein LAN per network-Anweisung an, AS 65002 ist Transit.',
    en: 'AS 65001 – AS 65002 – AS 65003: each AS announces its LAN with a network statement; AS 65002 is the transit.',
  },
  goals: {
    de: [
      'eBGP-Nachbarn mit neighbor … remote-as aufbauen',
      'Präfixe per network ankündigen und mit show ip bgp prüfen',
      'Den AS-Pfad in der BGP-Tabelle lesen (65002 65003)',
    ],
    en: [
      'Bring up eBGP neighbors with neighbor … remote-as',
      'Announce prefixes with network and verify with show ip bgp',
      'Read the AS path in the BGP table (65002 65003)',
    ],
  },
  settleSec: 120,
  build(l: Lab) {
    l.add('router', 'R1', 80, 100);
    l.add('router', 'R2', 260, 100);
    l.add('router', 'R3', 440, 100);
    l.add('pc', 'PC1', 80, 220);
    l.add('pc', 'PC3', 440, 220);
    l.link('R1', 'Gi0/0', 'R2', 'Gi0/0');
    l.link('R2', 'Gi0/1', 'R3', 'Gi0/0');
    l.link('R1', 'Gi0/1', 'PC1', 'Fa0');
    l.link('R3', 'Gi0/1', 'PC3', 'Fa0');
    l.host('PC1', '192.168.1.10', '255.255.255.0', '192.168.1.1');
    l.host('PC3', '192.168.3.10', '255.255.255.0', '192.168.3.1');
    l.cli('R1', [
      ...ifc('gi0/0', '10.0.12.1', '255.255.255.252'),
      ...ifc('gi0/1', '192.168.1.1'),
      'router bgp 65001',
      'bgp router-id 1.1.1.1',
      'neighbor 10.0.12.2 remote-as 65002',
      'network 192.168.1.0 mask 255.255.255.0',
    ]);
    l.cli('R2', [
      ...ifc('gi0/0', '10.0.12.2', '255.255.255.252'),
      ...ifc('gi0/1', '10.0.23.2', '255.255.255.252'),
      'router bgp 65002',
      'bgp router-id 2.2.2.2',
      'neighbor 10.0.12.1 remote-as 65001',
      'neighbor 10.0.23.3 remote-as 65003',
    ]);
    l.cli('R3', [
      ...ifc('gi0/0', '10.0.23.3', '255.255.255.252'),
      ...ifc('gi0/1', '192.168.3.1'),
      'router bgp 65003',
      'bgp router-id 3.3.3.3',
      'neighbor 10.0.23.2 remote-as 65002',
      'network 192.168.3.0 mask 255.255.255.0',
    ]);
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '192.168.3.10',
      expect: 'ok',
      label: {
        de: 'PC1 erreicht PC3 über den Transit-AS',
        en: 'PC1 reaches PC3 through the transit AS',
      },
    },
    {
      kind: 'ping',
      from: 'PC3',
      to: '192.168.1.10',
      expect: 'ok',
      label: { de: 'PC3 erreicht PC1', en: 'PC3 reaches PC1' },
    },
  ],
};

export const IPV6: Template = {
  id: 'ipv6-ospfv3',
  level: 'advanced',
  title: { de: 'IPv6 mit OSPFv3', en: 'IPv6 with OSPFv3' },
  summary: {
    de: 'Drei Router in einer Kette tauschen IPv6-Präfixe per OSPFv3 aus; die PCs haben statische Adressen und die Router-Link-Local-Adresse als Gateway.',
    en: 'Three routers in a chain exchange IPv6 prefixes using OSPFv3; the PCs have static addresses and use the router as gateway.',
  },
  goals: {
    de: [
      'ipv6 unicast-routing und ipv6 address pro Schnittstelle konfigurieren',
      'OSPFv3 mit ipv6 router ospf und ipv6 ospf 1 area 0 aktivieren',
      'Mit show ipv6 route und ping ipv6 prüfen',
    ],
    en: [
      'Configure ipv6 unicast-routing and ipv6 address per interface',
      'Enable OSPFv3 with ipv6 router ospf and ipv6 ospf 1 area 0',
      'Verify with show ipv6 route and ping ipv6',
    ],
  },
  settleSec: 90,
  build(l: Lab) {
    l.add('router', 'R1', 80, 100);
    l.add('router', 'R2', 260, 100);
    l.add('router', 'R3', 440, 100);
    l.add('pc', 'PC1', 80, 220);
    l.add('pc', 'PC3', 440, 220);
    l.link('R1', 'Gi0/0', 'R2', 'Gi0/0');
    l.link('R2', 'Gi0/1', 'R3', 'Gi0/0');
    l.link('R1', 'Gi0/1', 'PC1', 'Fa0');
    l.link('R3', 'Gi0/1', 'PC3', 'Fa0');
    const r = (name: string, rid: string, rows: [string, string][]) =>
      l.cli(name, [
        'ipv6 unicast-routing',
        'ipv6 router ospf 1',
        `router-id ${rid}`,
        'exit',
        ...rows.flatMap(([i, a]) => [
          `interface ${i}`,
          `ipv6 address ${a}`,
          'ipv6 ospf 1 area 0',
          'no shutdown',
          'exit',
        ]),
      ]);
    r('R1', '1.1.1.1', [
      ['gi0/0', '2001:db8:12::1/64'],
      ['gi0/1', '2001:db8:1::1/64'],
    ]);
    r('R2', '2.2.2.2', [
      ['gi0/0', '2001:db8:12::2/64'],
      ['gi0/1', '2001:db8:23::2/64'],
    ]);
    r('R3', '3.3.3.3', [
      ['gi0/0', '2001:db8:23::3/64'],
      ['gi0/1', '2001:db8:3::1/64'],
    ]);
    must(
      l.e.setHostIpv6(l.id('PC1'), { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' }),
    );
    must(
      l.e.setHostIpv6(l.id('PC3'), { addr: '2001:db8:3::10', plen: 64, gateway: '2001:db8:3::1' }),
    );
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '2001:db8:3::10',
      expect: 'ok',
      label: { de: 'PC1 erreicht PC3 über IPv6', en: 'PC1 reaches PC3 over IPv6' },
    },
    {
      kind: 'ping',
      from: 'PC3',
      to: '2001:db8:1::10',
      expect: 'ok',
      label: { de: 'PC3 erreicht PC1 über IPv6', en: 'PC3 reaches PC1 over IPv6' },
    },
  ],
};

export const IPSEC: Template = {
  id: 'ipsec-vpn',
  level: 'advanced',
  title: { de: 'Site-to-Site-IPsec-VPN', en: 'Site-to-site IPsec VPN' },
  summary: {
    de: 'Zwei Standorte verbinden ihre LANs über das Internet (ISP-Router) durch einen IPsec-Tunnel mit IKE (AES, Pre-Shared-Key) und ESP.',
    en: 'Two sites join their LANs across the Internet (ISP router) through an IPsec tunnel with IKE (AES, pre-shared key) and ESP.',
  },
  goals: {
    de: [
      'ISAKMP-Policy, Pre-Shared-Key, Transform-Set, Crypto-Map und interessanten Verkehr (ACL) konfigurieren',
      'Mit show crypto isakmp sa und show crypto ipsec sa prüfen',
      'Verstehen, warum der ISP nur verschlüsselte ESP-Pakete sieht',
    ],
    en: [
      'Configure ISAKMP policy, pre-shared key, transform set, crypto map and interesting traffic (ACL)',
      'Verify with show crypto isakmp sa and show crypto ipsec sa',
      'Understand why the ISP only sees encrypted ESP packets',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('router', 'R1', 80, 100);
    l.add('router', 'ISP', 260, 100);
    l.add('router', 'R3', 440, 100);
    l.add('pc', 'PC1', 80, 220);
    l.add('pc', 'PC3', 440, 220);
    l.link('R1', 'Gi0/0', 'ISP', 'Gi0/0');
    l.link('ISP', 'Gi0/1', 'R3', 'Gi0/0');
    l.link('R1', 'Gi0/1', 'PC1', 'Fa0');
    l.link('R3', 'Gi0/1', 'PC3', 'Fa0');
    l.host('PC1', '10.1.0.10', '255.255.255.0', '10.1.0.1');
    l.host('PC3', '10.2.0.10', '255.255.255.0', '10.2.0.1');
    l.cli('ISP', [
      ...ifc('gi0/0', '203.0.113.2', '255.255.255.252'),
      ...ifc('gi0/1', '198.51.100.2', '255.255.255.252'),
    ]);
    const site = (
      name: string,
      wan: string,
      lan: string,
      gw: string,
      peer: string,
      loc: string,
      rem: string,
    ) =>
      l.cli(name, [
        ...ifc('gi0/0', wan, '255.255.255.252'),
        ...ifc('gi0/1', lan),
        `ip route 0.0.0.0 0.0.0.0 ${gw}`,
        'crypto isakmp policy 10',
        'encryption aes',
        'authentication pre-share',
        'group 2',
        'exit',
        `crypto isakmp key geheim address ${peer}`,
        'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
        'exit',
        `access-list 101 permit ip ${loc} 0.0.0.255 ${rem} 0.0.0.255`,
        'crypto map VPN 10 ipsec-isakmp',
        `set peer ${peer}`,
        'set transform-set TS',
        'match address 101',
        'exit',
        'interface gi0/0',
        'crypto map VPN',
      ]);
    site('R1', '203.0.113.1', '10.1.0.1', '203.0.113.2', '198.51.100.1', '10.1.0.0', '10.2.0.0');
    site('R3', '198.51.100.1', '10.2.0.1', '198.51.100.2', '203.0.113.1', '10.2.0.0', '10.1.0.0');
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.2.0.10',
      expect: 'ok',
      label: { de: 'PC1 erreicht PC3 durch den Tunnel', en: 'PC1 reaches PC3 through the tunnel' },
    },
    {
      kind: 'ping',
      from: 'PC3',
      to: '10.1.0.10',
      expect: 'ok',
      label: { de: 'PC3 erreicht PC1 durch den Tunnel', en: 'PC3 reaches PC1 through the tunnel' },
    },
  ],
};
