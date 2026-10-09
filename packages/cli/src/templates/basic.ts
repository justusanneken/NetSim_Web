import type { SwitchConfig } from '@netsim/engine';
import type { Lab } from './lab';
import type { Template } from './types';

const must = (r: { ok: boolean; error?: string }): void => {
  if (!r.ok) throw new Error(`template: ${r.error ?? 'failed'}`);
};

function dhcpPool(
  name: string,
  network: string,
  router: string,
  from: string,
  to: string,
  dns: string[] = [],
) {
  return {
    name,
    network,
    mask: '255.255.255.0',
    router,
    dns,
    leaseSec: 86400,
    rangeStart: from,
    rangeEnd: to,
  };
}

export const SOHO: Template = {
  id: 'soho',
  level: 'basic',
  title: { de: 'SOHO-Netz mit Internetzugang', en: 'SOHO network with Internet access' },
  summary: {
    de: 'Heimrouter mit DHCP-Server und PAT, ein Switch mit zwei PCs und ein Provider-Router mit Webserver im Internet.',
    en: 'Home router with DHCP server and PAT, a switch with two PCs and an ISP router with a web server on the Internet.',
  },
  goals: {
    de: [
      'Zusammenspiel von DHCP, Standardgateway und Default-Route verstehen',
      'Erkennen, dass private Adressen per PAT hinter der WAN-Adresse versteckt werden',
      'Mit show ip dhcp binding und show ip nat translations beobachten',
    ],
    en: [
      'Understand how DHCP, default gateway and default route work together',
      'See private addresses hidden behind the WAN address by PAT',
      'Observe with show ip dhcp binding and show ip nat translations',
    ],
  },
  settleSec: 70,
  build(l: Lab) {
    l.add('router', 'ISP', 420, 60);
    l.add('server', 'WEB', 560, 60);
    l.add('router', 'SOHO-GW', 260, 60);
    l.add('switch-l2', 'SOHO-SW', 100, 60);
    l.add('pc', 'PC1', 20, 180);
    l.add('pc', 'PC2', 180, 180);
    l.link('ISP', 'Gi0/1', 'WEB', 'Fa0');
    l.link('ISP', 'Gi0/0', 'SOHO-GW', 'Gi0/1');
    l.link('SOHO-GW', 'Gi0/0', 'SOHO-SW', 'Fa0/24');
    l.link('SOHO-SW', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SOHO-SW', 'Fa0/2', 'PC2', 'Fa0');
    l.host('WEB', '198.51.100.10', '255.255.255.0', '198.51.100.1');
    must(
      l.e.setService(l.id('WEB'), {
        http: { enabled: true, https: false, pages: { '/': '<h1>example.net</h1>' } },
      }),
    );
    l.cli('ISP', [
      'interface gi0/0',
      'ip address 203.0.113.1 255.255.255.252',
      'no shutdown',
      'exit',
      'interface gi0/1',
      'ip address 198.51.100.1 255.255.255.0',
      'no shutdown',
    ]);
    l.cli('SOHO-GW', [
      'ip dhcp excluded-address 192.168.1.1 192.168.1.20',
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'dns-server 198.51.100.10',
      'exit',
      'interface gi0/0',
      'description LAN',
      'ip address 192.168.1.1 255.255.255.0',
      'ip nat inside',
      'no shutdown',
      'exit',
      'interface gi0/1',
      'description WAN',
      'ip address 203.0.113.2 255.255.255.252',
      'ip nat outside',
      'no shutdown',
      'exit',
      'access-list 1 permit 192.168.1.0 0.0.0.255',
      'ip nat inside source list 1 interface gi0/1 overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
    ]);
    must(l.e.setHostDhcp(l.id('PC1'), true));
    must(l.e.setHostDhcp(l.id('PC2'), true));
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '192.168.1.1',
      expect: 'ok',
      label: { de: 'PC1 erreicht den Router', en: 'PC1 reaches the router' },
    },
    {
      kind: 'ping',
      from: 'PC1',
      to: '198.51.100.10',
      expect: 'ok',
      label: {
        de: 'PC1 erreicht den Webserver im Internet',
        en: 'PC1 reaches the web server on the Internet',
      },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '198.51.100.10',
      expect: 'ok',
      label: {
        de: 'PC2 erreicht den Webserver im Internet',
        en: 'PC2 reaches the web server on the Internet',
      },
    },
    {
      kind: 'http',
      from: 'PC1',
      to: 'http://198.51.100.10/',
      expect: 'ok',
      label: { de: 'PC1 ruft die Webseite ab', en: 'PC1 fetches the web page' },
    },
  ],
};

export const VLAN_TRUNK: Template = {
  id: 'vlan-trunk',
  level: 'basic',
  title: { de: 'VLANs und Trunk', en: 'VLANs and trunk' },
  summary: {
    de: 'Zwei Switches, VLAN 10 (Vertrieb) und VLAN 20 (Technik) über einen 802.1Q-Trunk. Gleiche VLANs reden miteinander, verschiedene nicht.',
    en: 'Two switches, VLAN 10 (Sales) and VLAN 20 (Engineering) over an 802.1Q trunk. Hosts in the same VLAN communicate, different VLANs do not.',
  },
  goals: {
    de: [
      'VLANs anlegen und Access-Ports zuweisen',
      'Trunk mit Native-VLAN und erlaubten VLANs konfigurieren',
      'Verstehen, dass VLANs getrennte Broadcast-Domänen sind (kein Routing = keine Verbindung)',
    ],
    en: [
      'Create VLANs and assign access ports',
      'Configure a trunk with native VLAN and allowed VLANs',
      'Understand VLANs as separate broadcast domains (no routing = no connectivity)',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('switch-l2', 'SW1', 120, 100);
    l.add('switch-l2', 'SW2', 360, 100);
    l.add('pc', 'PC1', 40, 220);
    l.add('pc', 'PC2', 200, 220);
    l.add('pc', 'PC3', 280, 220);
    l.add('pc', 'PC4', 440, 220);
    l.link('SW1', 'Gi0/1', 'SW2', 'Gi0/1');
    l.link('SW1', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SW1', 'Fa0/2', 'PC2', 'Fa0');
    l.link('SW2', 'Fa0/1', 'PC3', 'Fa0');
    l.link('SW2', 'Fa0/2', 'PC4', 'Fa0');
    l.host('PC1', '10.0.10.11', '255.255.255.0');
    l.host('PC2', '10.0.20.12', '255.255.255.0');
    l.host('PC3', '10.0.10.13', '255.255.255.0');
    l.host('PC4', '10.0.20.14', '255.255.255.0');
    for (const sw of ['SW1', 'SW2']) {
      l.cli(sw, [
        'vlan 10',
        'name Sales',
        'exit',
        'vlan 20',
        'name Engineering',
        'exit',
        'vlan 99',
        'name Native',
        'exit',
        'interface fa0/1',
        'switchport mode access',
        'switchport access vlan 10',
        'spanning-tree portfast',
        'exit',
        'interface fa0/2',
        'switchport mode access',
        'switchport access vlan 20',
        'spanning-tree portfast',
        'exit',
        'interface gi0/1',
        'switchport mode trunk',
        'switchport trunk native vlan 99',
        'switchport trunk allowed vlan 10,20,99',
      ]);
    }
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.0.10.13',
      expect: 'ok',
      label: {
        de: 'VLAN 10: PC1 erreicht PC3 über den Trunk',
        en: 'VLAN 10: PC1 reaches PC3 across the trunk',
      },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '10.0.20.14',
      expect: 'ok',
      label: {
        de: 'VLAN 20: PC2 erreicht PC4 über den Trunk',
        en: 'VLAN 20: PC2 reaches PC4 across the trunk',
      },
    },
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.0.20.12',
      expect: 'fail',
      label: {
        de: 'PC1 erreicht PC2 nicht (anderes VLAN, kein Router)',
        en: 'PC1 cannot reach PC2 (other VLAN, no router)',
      },
    },
  ],
};

export const ROAS: Template = {
  id: 'router-on-a-stick',
  level: 'intermediate',
  title: {
    de: 'Router-on-a-Stick (Inter-VLAN-Routing)',
    en: 'Router-on-a-stick (inter-VLAN routing)',
  },
  summary: {
    de: 'Ein Router mit zwei 802.1Q-Subinterfaces verbindet VLAN 10 und VLAN 20 über einen einzigen Trunk zum Switch.',
    en: 'A router with two 802.1Q subinterfaces connects VLAN 10 and VLAN 20 over a single trunk to the switch.',
  },
  goals: {
    de: [
      'Subinterfaces mit encapsulation dot1Q konfigurieren',
      'Das Subinterface als Standardgateway des VLANs verstehen',
      'Den Weg eines Pakets zwischen VLANs im Simulationsmodus verfolgen',
    ],
    en: [
      'Configure subinterfaces with encapsulation dot1Q',
      'Understand the subinterface as the default gateway of its VLAN',
      'Follow a packet between VLANs in simulation mode',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('router', 'R1', 200, 40);
    l.add('switch-l2', 'SW1', 200, 140);
    l.add('pc', 'PC1', 100, 260);
    l.add('pc', 'PC2', 300, 260);
    l.link('R1', 'Gi0/0', 'SW1', 'Fa0/24');
    l.link('SW1', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SW1', 'Fa0/2', 'PC2', 'Fa0');
    l.host('PC1', '192.168.10.10', '255.255.255.0', '192.168.10.1');
    l.host('PC2', '192.168.20.10', '255.255.255.0', '192.168.20.1');
    l.cli('SW1', [
      'vlan 10',
      'name Sales',
      'exit',
      'vlan 20',
      'name Engineering',
      'exit',
      'interface fa0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'exit',
      'interface fa0/2',
      'switchport mode access',
      'switchport access vlan 20',
      'spanning-tree portfast',
      'exit',
      'interface fa0/24',
      'description Trunk to R1',
      'switchport mode trunk',
    ]);
    l.cli('R1', [
      'interface gi0/0',
      'no shutdown',
      'exit',
      'interface gi0/0.10',
      'encapsulation dot1Q 10',
      'ip address 192.168.10.1 255.255.255.0',
      'exit',
      'interface gi0/0.20',
      'encapsulation dot1Q 20',
      'ip address 192.168.20.1 255.255.255.0',
    ]);
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '192.168.10.1',
      expect: 'ok',
      label: {
        de: 'PC1 erreicht sein Gateway (Gi0/0.10)',
        en: 'PC1 reaches its gateway (Gi0/0.10)',
      },
    },
    {
      kind: 'ping',
      from: 'PC1',
      to: '192.168.20.10',
      expect: 'ok',
      label: { de: 'PC1 erreicht PC2 über den Router', en: 'PC1 reaches PC2 through the router' },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '192.168.10.10',
      expect: 'ok',
      label: { de: 'PC2 erreicht PC1 über den Router', en: 'PC2 reaches PC1 through the router' },
    },
  ],
};

export const STP_RING: Template = {
  id: 'stp-ring',
  level: 'intermediate',
  title: { de: 'STP-Ring (Rapid-PVST+)', en: 'STP ring (Rapid-PVST+)' },
  summary: {
    de: 'Drei Switches im Ring. SW1 ist per Priorität Root Bridge, genau ein Port blockiert die Schleife.',
    en: 'Three switches in a ring. SW1 is root bridge by priority and exactly one port blocks the loop.',
  },
  goals: {
    de: [
      'Root Bridge per Priorität bestimmen (spanning-tree vlan 1 priority 4096)',
      'Root-, Designated- und Alternate-Ports mit show spanning-tree lesen',
      'Ein Kabel ziehen und die Umschaltung beobachten',
    ],
    en: [
      'Choose the root bridge by priority (spanning-tree vlan 1 priority 4096)',
      'Read root, designated and alternate ports with show spanning-tree',
      'Unplug a cable and watch the failover',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('switch-l2', 'SW1', 240, 40);
    l.add('switch-l2', 'SW2', 100, 200);
    l.add('switch-l2', 'SW3', 380, 200);
    l.add('pc', 'PC1', 240, -60);
    l.add('pc', 'PC2', 0, 300);
    l.add('pc', 'PC3', 480, 300);
    l.link('SW1', 'Fa0/23', 'SW2', 'Fa0/24');
    l.link('SW2', 'Fa0/23', 'SW3', 'Fa0/24');
    l.link('SW3', 'Fa0/23', 'SW1', 'Fa0/24');
    l.link('SW1', 'Fa0/1', 'PC1', 'Fa0');
    l.link('SW2', 'Fa0/1', 'PC2', 'Fa0');
    l.link('SW3', 'Fa0/1', 'PC3', 'Fa0');
    l.host('PC1', '10.0.0.1', '255.255.255.0');
    l.host('PC2', '10.0.0.2', '255.255.255.0');
    l.host('PC3', '10.0.0.3', '255.255.255.0');
    for (const sw of ['SW1', 'SW2', 'SW3']) {
      l.cli(sw, [
        'spanning-tree mode rapid-pvst',
        ...(sw === 'SW1' ? ['spanning-tree vlan 1 priority 4096'] : []),
        'interface fa0/1',
        'switchport mode access',
        'spanning-tree portfast',
        'spanning-tree bpduguard enable',
      ]);
    }
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.0.0.3',
      expect: 'ok',
      label: { de: 'PC1 erreicht PC3 trotz Ring', en: 'PC1 reaches PC3 despite the ring' },
    },
    {
      kind: 'ping',
      from: 'PC2',
      to: '10.0.0.3',
      expect: 'ok',
      label: { de: 'PC2 erreicht PC3', en: 'PC2 reaches PC3' },
    },
  ],
  verify(l: Lab) {
    const blocked: string[] = [];
    for (const name of ['SW1', 'SW2', 'SW3']) {
      const cfg = l.e.getDevice(l.id(name))?.config as SwitchConfig;
      for (const [pid, p] of Object.entries(cfg.stp.instances[1]?.ports ?? {}))
        if (p.state === 'discarding') blocked.push(`${name}:${pid}`);
    }
    return blocked.length === 1
      ? undefined
      : `expected exactly one blocked port, got ${blocked.join(',') || 'none'}`;
  },
};

export const ETHERCHANNEL: Template = {
  id: 'etherchannel',
  level: 'intermediate',
  title: { de: 'EtherChannel (LACP)', en: 'EtherChannel (LACP)' },
  summary: {
    de: 'Zwei Switches sind über zwei Kabel zu einem LACP-Port-Channel gebündelt; STP sieht nur einen logischen Link.',
    en: 'Two switches are bundled over two cables into an LACP port channel; STP sees one logical link.',
  },
  goals: {
    de: [
      'Port-Channel mit channel-group 1 mode active (LACP) aufbauen',
      'Mit show etherchannel summary den Zustand SU prüfen',
      'Verstehen, warum STP keinen Port blockiert, obwohl zwei Kabel parallel liegen',
    ],
    en: [
      'Build a port channel with channel-group 1 mode active (LACP)',
      'Verify state SU with show etherchannel summary',
      'Understand why STP blocks nothing although two cables run in parallel',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('switch-l2', 'SW1', 100, 100);
    l.add('switch-l2', 'SW2', 360, 100);
    l.add('pc', 'PC1', 100, 220);
    l.add('pc', 'PC2', 360, 220);
    l.link('SW1', 'Fa0/1', 'SW2', 'Fa0/1');
    l.link('SW1', 'Fa0/2', 'SW2', 'Fa0/2');
    l.link('SW1', 'Fa0/10', 'PC1', 'Fa0');
    l.link('SW2', 'Fa0/10', 'PC2', 'Fa0');
    l.host('PC1', '10.0.0.1', '255.255.255.0');
    l.host('PC2', '10.0.0.2', '255.255.255.0');
    for (const sw of ['SW1', 'SW2']) {
      l.cli(sw, [
        'interface range fa0/1 - 2',
        'channel-group 1 mode active',
        'exit',
        'interface port-channel 1',
        'switchport mode trunk',
        'exit',
        'interface fa0/10',
        'switchport mode access',
        'spanning-tree portfast',
      ]);
    }
  },
  checks: [
    {
      kind: 'ping',
      from: 'PC1',
      to: '10.0.0.2',
      expect: 'ok',
      label: {
        de: 'PC1 erreicht PC2 über den Port-Channel',
        en: 'PC1 reaches PC2 over the port channel',
      },
    },
  ],
  verify(l: Lab) {
    for (const name of ['SW1', 'SW2']) {
      const cfg = l.e.getDevice(l.id(name))?.config as SwitchConfig;
      if ((cfg.bundles[1] ?? []).length !== 2) return `${name}: port-channel 1 has no 2 members`;
    }
    return undefined;
  },
};

export const WLAN: Template = {
  id: 'wlan',
  level: 'basic',
  title: { de: 'WLAN mit WPA2 und DHCP', en: 'WLAN with WPA2 and DHCP' },
  summary: {
    de: 'Ein Access Point (SSID HomeNet, WPA2-PSK) hängt am Switch. Laptop und Smartphone bekommen ihre Adresse per DHCP vom Server.',
    en: 'An access point (SSID HomeNet, WPA2-PSK) is attached to the switch. Laptop and smartphone get their address from the DHCP server.',
  },
  goals: {
    de: [
      'SSID, Sicherheitsmodus und Schlüssel am AP konfigurieren',
      'Reichweite und Assoziation im Canvas nachvollziehen',
      'Ein falsches Passwort ausprobieren und die Fehlermeldung lesen',
    ],
    en: [
      'Configure SSID, security mode and key on the AP',
      'Follow range and association on the canvas',
      'Try a wrong password and read the error message',
    ],
  },
  settleSec: 60,
  build(l: Lab) {
    l.add('switch-l2', 'SW1', 160, 100);
    l.add('ap', 'AP1', 300, 100);
    l.add('server', 'SRV', 160, 220);
    l.add('pc', 'PC1', 20, 220);
    l.add('laptop', 'Laptop1', 380, 180);
    l.add('smartphone', 'Phone1', 360, 40);
    l.link('SW1', 'Fa0/1', 'AP1', 'Gi0');
    l.link('SW1', 'Fa0/2', 'SRV', 'Fa0');
    l.link('SW1', 'Fa0/3', 'PC1', 'Fa0');
    l.host('SRV', '192.168.0.10', '255.255.255.0', '192.168.0.1');
    must(
      l.e.setService(l.id('SRV'), {
        dhcp: {
          enabled: true,
          pools: [dhcpPool('WLAN', '192.168.0.0', '192.168.0.1', '192.168.0.100', '192.168.0.150')],
          excluded: [],
          bindings: {},
          conflicts: [],
        },
      }),
    );
    must(
      l.e.p5.setApRadio(l.id('AP1'), '2.4', {
        ssid: 'HomeNet',
        security: 'wpa2-psk',
        key: 'secret123',
      }),
    );
    must(l.e.setHostDhcp(l.id('PC1'), true));
    must(l.e.setHostDhcp(l.id('Laptop1'), true));
    must(l.e.setHostDhcp(l.id('Phone1'), true));
    must(l.e.p5.wifiAddProfile(l.id('Laptop1'), 'HomeNet', 'secret123'));
    must(l.e.p5.wifiAddProfile(l.id('Phone1'), 'HomeNet', 'secret123'));
  },
  checks: [
    {
      kind: 'ping',
      from: 'Laptop1',
      to: '192.168.0.10',
      expect: 'ok',
      label: {
        de: 'Laptop erreicht den Server über WLAN',
        en: 'Laptop reaches the server over WLAN',
      },
    },
    {
      kind: 'ping',
      from: 'Phone1',
      to: '192.168.0.10',
      expect: 'ok',
      label: { de: 'Smartphone erreicht den Server', en: 'Smartphone reaches the server' },
    },
    {
      kind: 'ping',
      from: 'Laptop1',
      to: '192.168.0.1',
      expect: 'fail',
      label: {
        de: 'Das Gateway 192.168.0.1 existiert noch nicht (Übung: Router ergänzen)',
        en: 'Gateway 192.168.0.1 does not exist yet (exercise: add a router)',
      },
    },
  ],
};
