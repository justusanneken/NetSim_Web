import {
  CheckSchema,
  Engine,
  parseActivity,
  type Activity,
  type CheckInput,
  type DeviceType,
  type LText,
} from '@netsim/engine';
import { CliSession } from './session';

/**
 * Beispielaufgaben (`.nsact`). Start- und Antwortnetz entstehen deterministisch aus echten IOS-Befehlen
 * (CliSession) – die Antwort ist also genau das, was Teilnehmer ebenfalls eintippen koennen.
 */

class Lab {
  readonly e = new Engine({ seed: 1 });
  private readonly ids = new Map<string, string>();

  add(type: DeviceType, name: string, x: number, y: number): string {
    const id = this.e.addDevice(type, { name, pos: { x, y } });
    this.ids.set(name, id);
    return id;
  }
  id(name: string): string {
    const id = this.ids.get(name);
    if (!id) throw new Error(`unknown device ${name}`);
    return id;
  }
  link(a: string, ap: string, b: string, bp: string): void {
    const A = { deviceId: this.id(a), portId: ap };
    const B = { deviceId: this.id(b), portId: bp };
    const r = this.e.connect(A, B, 'straight');
    if (r.ok) return;
    const r2 = this.e.connect(A, B, 'crossover');
    if (!r2.ok) throw new Error(`${a}-${b}: ${r2.error}`);
  }
  host(name: string, ip: string, gw?: string): void {
    this.e.setHostIp(this.id(name), ip, '255.255.255.0', gw);
  }
  /** Fuehrt IOS-Zeilen im privilegierten Modus aus (`configure terminal` … `end`). */
  ios(name: string, lines: string[]): void {
    const s = new CliSession(this.e, this.id(name));
    const d = this.e.getDevice(this.id(name));
    if (d?.config.kind === 'router' || d?.config.kind === 'switch') d.config.sys.setupDone = true;
    for (const l of ['enable', 'configure terminal', ...lines, 'end']) {
      const out = s.input(l);
      if (/% (Invalid|Incomplete|Ambiguous)/.test(out))
        throw new Error(`${name}: "${l}" -> ${out}`);
    }
  }
  state() {
    return structuredClone(this.e.state);
  }
}

const t = (de: string, en: string): LText => ({ de, en });

function make(
  id: string,
  title: LText,
  description: LText,
  difficulty: 1 | 2 | 3,
  steps: { title?: LText; text: LText }[],
  start: Lab,
  answer: Lab,
  checks: CheckInput[],
  timeLimitSec = 0,
): Activity {
  const r = parseActivity(
    {
      schema: 1,
      kind: 'netsim-activity',
      meta: { id, title, description, author: 'NetSim Web', difficulty },
      steps,
      timeLimitSec,
      passPercent: 100,
      liveProgress: false,
      locks: { hideCli: false, hideGui: false, noAddDevices: true },
      start: start.state(),
      answer: answer.state(),
      checks: checks.map((c) => CheckSchema.parse(c)),
    },
    { trusted: true },
  );
  if (!r.ok) throw new Error(`${id}: ${r.error} ${JSON.stringify(r.params)}`);
  return r.value;
}

// ------------------------------------------------------------------ 1. VLANs und Trunk

function vlanTrunk(): Activity {
  const build = (): Lab => {
    const l = new Lab();
    l.add('switch-l2', 'SW1', 200, 200);
    l.add('switch-l2', 'SW2', 500, 200);
    l.add('pc', 'PC1', 100, 100);
    l.add('pc', 'PC2', 100, 300);
    l.add('pc', 'PC3', 600, 100);
    l.add('pc', 'PC4', 600, 300);
    l.link('PC1', 'p0', 'SW1', 'p0');
    l.link('PC2', 'p0', 'SW1', 'p1');
    l.link('PC3', 'p0', 'SW2', 'p0');
    l.link('PC4', 'p0', 'SW2', 'p1');
    l.link('SW1', 'p24', 'SW2', 'p24');
    l.host('PC1', '192.168.10.11');
    l.host('PC2', '192.168.20.12');
    l.host('PC3', '192.168.10.13');
    l.host('PC4', '192.168.20.14');
    return l;
  };
  const start = build();
  const answer = build();
  for (const sw of ['SW1', 'SW2'])
    answer.ios(sw, [
      'vlan 10',
      'name Sales',
      'vlan 20',
      'name Engineering',
      'exit',
      'interface fastethernet0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'interface fastethernet0/2',
      'switchport mode access',
      'switchport access vlan 20',
      'exit',
      'interface gigabitethernet0/1',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10,20',
    ]);
  const checks: CheckInput[] = [];
  for (const sw of ['SW1', 'SW2']) {
    checks.push(
      {
        id: `${sw}-v10`,
        type: 'vlanExists',
        device: sw,
        vlan: 10,
        name: 'Sales',
        hint: t(
          'Mit "vlan 10" und "name Sales" anlegen.',
          'Create it with "vlan 10" and "name Sales".',
        ),
      },
      { id: `${sw}-v20`, type: 'vlanExists', device: sw, vlan: 20, name: 'Engineering' },
      {
        id: `${sw}-a1`,
        type: 'vlanMember',
        device: sw,
        port: 'Fa0/1',
        vlan: 10,
        hint: t(
          'Port in den Access-Modus setzen und VLAN zuweisen: switchport mode access / switchport access vlan 10.',
          'Set the port to access mode and assign the VLAN: switchport mode access / switchport access vlan 10.',
        ),
      },
      { id: `${sw}-a2`, type: 'vlanMember', device: sw, port: 'Fa0/2', vlan: 20 },
      {
        id: `${sw}-tr`,
        type: 'trunk',
        device: sw,
        port: 'Gi0/1',
        allowed: [10, 20],
        weight: 2,
        hint: t(
          'Der Uplink muss ein Trunk sein: switchport mode trunk. Beide VLANs muessen erlaubt sein.',
          'The uplink must be a trunk: switchport mode trunk. Both VLANs must be allowed.',
        ),
      },
    );
  }
  checks.push(
    {
      id: 'ping10',
      type: 'ping',
      from: 'PC1',
      to: 'PC3',
      weight: 3,
      label: t(
        'PC1 erreicht PC3 (VLAN 10 ueber den Trunk)',
        'PC1 reaches PC3 (VLAN 10 across the trunk)',
      ),
      hint: t(
        'Erst wenn VLANs, Access-Ports und Trunk auf beiden Switches stimmen, funktioniert der Ping.',
        'The ping only works once VLANs, access ports and the trunk are right on both switches.',
      ),
    },
    {
      id: 'ping20',
      type: 'ping',
      from: 'PC2',
      to: 'PC4',
      weight: 3,
      label: t(
        'PC2 erreicht PC4 (VLAN 20 ueber den Trunk)',
        'PC2 reaches PC4 (VLAN 20 across the trunk)',
      ),
    },
  );
  return make(
    'vlan-trunk',
    t('VLANs und Trunk einrichten', 'Configure VLANs and trunk'),
    t(
      'Zwei Switches, zwei Abteilungen: trenne den Verkehr in VLAN 10 und VLAN 20 und verbinde die Switches ueber einen 802.1Q-Trunk.',
      'Two switches, two departments: separate the traffic into VLAN 10 and VLAN 20 and join the switches with an 802.1Q trunk.',
    ),
    1,
    [
      {
        title: t('VLANs anlegen', 'Create the VLANs'),
        text: t(
          'Lege auf SW1 und SW2 VLAN 10 (Sales) und VLAN 20 (Engineering) an.',
          'On SW1 and SW2 create VLAN 10 (Sales) and VLAN 20 (Engineering).',
        ),
      },
      {
        title: t('Access-Ports', 'Access ports'),
        text: t(
          'Fa0/1 gehoert zu VLAN 10, Fa0/2 zu VLAN 20 - auf beiden Switches.',
          'Fa0/1 belongs to VLAN 10, Fa0/2 to VLAN 20 - on both switches.',
        ),
      },
      {
        title: t('Trunk', 'Trunk'),
        text: t(
          'Konfiguriere Gi0/1 auf beiden Switches als Trunk und erlaube nur VLAN 10 und 20.',
          'Configure Gi0/1 on both switches as a trunk and allow only VLANs 10 and 20.',
        ),
      },
      {
        title: t('Pruefen', 'Verify'),
        text: t(
          'PC1 muss PC3 anpingen koennen, PC2 muss PC4 anpingen koennen. Nutze "show vlan brief" und "show interfaces trunk".',
          'PC1 must be able to ping PC3 and PC2 must be able to ping PC4. Use "show vlan brief" and "show interfaces trunk".',
        ),
      },
    ],
    start,
    answer,
    checks,
    1800,
  );
}

// ------------------------------------------------------------------ 2. Router-on-a-Stick

function routerOnAStick(): Activity {
  const build = (): Lab => {
    const l = new Lab();
    l.add('router', 'R1', 400, 100);
    l.add('switch-l2', 'SW1', 400, 250);
    l.add('pc', 'PC1', 250, 400);
    l.add('pc', 'PC2', 550, 400);
    l.link('R1', 'p0', 'SW1', 'p24');
    l.link('PC1', 'p0', 'SW1', 'p0');
    l.link('PC2', 'p0', 'SW1', 'p1');
    l.host('PC1', '192.168.10.11', '192.168.10.1');
    l.host('PC2', '192.168.20.12', '192.168.20.1');
    l.ios('SW1', [
      'vlan 10',
      'name Sales',
      'vlan 20',
      'name Engineering',
      'exit',
      'interface fastethernet0/1',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'interface fastethernet0/2',
      'switchport mode access',
      'switchport access vlan 20',
    ]);
    return l;
  };
  const start = build();
  const answer = build();
  answer.ios('SW1', ['interface gigabitethernet0/1', 'switchport mode trunk']);
  answer.ios('R1', [
    'interface gigabitethernet0/0',
    'no shutdown',
    'exit',
    'interface gigabitethernet0/0.10',
    'encapsulation dot1Q 10',
    'ip address 192.168.10.1 255.255.255.0',
    'exit',
    'interface gigabitethernet0/0.20',
    'encapsulation dot1Q 20',
    'ip address 192.168.20.1 255.255.255.0',
  ]);
  return make(
    'router-on-a-stick',
    t('Router-on-a-Stick', 'Router-on-a-stick'),
    t(
      'Zwei VLANs, ein Router-Port: konfiguriere Trunk und Subinterfaces fuer Inter-VLAN-Routing.',
      'Two VLANs, one router port: configure the trunk and subinterfaces for inter-VLAN routing.',
    ),
    2,
    [
      {
        title: t('Trunk zum Router', 'Trunk to the router'),
        text: t(
          'Der Switch-Port Gi0/1 fuehrt zum Router und muss Frames beider VLANs getaggt transportieren.',
          'Switch port Gi0/1 leads to the router and must carry tagged frames of both VLANs.',
        ),
      },
      {
        title: t('Physische Schnittstelle', 'Physical interface'),
        text: t(
          'Aktiviere Gi0/0 am Router (no shutdown). Sie bekommt selbst keine IP-Adresse.',
          'Enable Gi0/0 on the router (no shutdown). It gets no IP address itself.',
        ),
      },
      {
        title: t('Subinterfaces', 'Subinterfaces'),
        text: t(
          'Gi0/0.10 (dot1Q 10, 192.168.10.1/24) und Gi0/0.20 (dot1Q 20, 192.168.20.1/24) sind die Gateways der VLANs.',
          'Gi0/0.10 (dot1Q 10, 192.168.10.1/24) and Gi0/0.20 (dot1Q 20, 192.168.20.1/24) are the gateways of the VLANs.',
        ),
      },
    ],
    start,
    answer,
    [
      {
        id: 'trunk',
        type: 'trunk',
        device: 'SW1',
        port: 'Gi0/1',
        weight: 2,
        hint: t('switchport mode trunk auf Gi0/1.', 'switchport mode trunk on Gi0/1.'),
      },
      {
        id: 'up',
        type: 'ifaceState',
        device: 'R1',
        iface: 'Gi0/0',
        up: true,
        hint: t(
          'Router-Schnittstellen sind standardmaessig abgeschaltet.',
          'Router interfaces are shut down by default.',
        ),
      },
      {
        id: 'sub10',
        type: 'ifaceIp',
        device: 'R1',
        iface: 'Gi0/0.10',
        ip: '192.168.10.1',
        mask: '/24',
        weight: 2,
        hint: t(
          'encapsulation dot1Q 10, dann ip address.',
          'encapsulation dot1Q 10, then ip address.',
        ),
      },
      {
        id: 'sub20',
        type: 'ifaceIp',
        device: 'R1',
        iface: 'Gi0/0.20',
        ip: '192.168.20.1',
        mask: '/24',
        weight: 2,
      },
      {
        id: 'ping',
        type: 'ping',
        from: 'PC1',
        to: 'PC2',
        weight: 3,
        label: t('PC1 erreicht PC2 ueber den Router', 'PC1 reaches PC2 through the router'),
      },
    ],
  );
}

// ------------------------------------------------------------------ 3. OSPF Single Area

function ospf(): Activity {
  const build = (): Lab => {
    const l = new Lab();
    l.add('router', 'R1', 150, 200);
    l.add('router', 'R2', 400, 200);
    l.add('router', 'R3', 650, 200);
    l.add('pc', 'PC1', 50, 350);
    l.add('pc', 'PC2', 750, 350);
    l.link('PC1', 'p0', 'R1', 'p0');
    l.link('R1', 'p1', 'R2', 'p0');
    l.link('R2', 'p1', 'R3', 'p0');
    l.link('R3', 'p1', 'PC2', 'p0');
    l.host('PC1', '10.1.1.10', '10.1.1.1');
    l.host('PC2', '10.3.3.10', '10.3.3.1');
    const ifc = (_r: string, p: string, ip: string, mask: string): string[] => [
      `interface ${p}`,
      `ip address ${ip} ${mask}`,
      'no shutdown',
      'exit',
    ];
    l.ios('R1', [
      ...ifc('R1', 'gigabitethernet0/0', '10.1.1.1', '255.255.255.0'),
      ...ifc('R1', 'gigabitethernet0/1', '10.0.12.1', '255.255.255.252'),
    ]);
    l.ios('R2', [
      ...ifc('R2', 'gigabitethernet0/0', '10.0.12.2', '255.255.255.252'),
      ...ifc('R2', 'gigabitethernet0/1', '10.0.23.1', '255.255.255.252'),
    ]);
    l.ios('R3', [
      ...ifc('R3', 'gigabitethernet0/0', '10.0.23.2', '255.255.255.252'),
      ...ifc('R3', 'gigabitethernet0/1', '10.3.3.1', '255.255.255.0'),
    ]);
    return l;
  };
  const start = build();
  const answer = build();
  answer.ios('R1', [
    'router ospf 1',
    'network 10.1.1.0 0.0.0.255 area 0',
    'network 10.0.12.0 0.0.0.3 area 0',
    'passive-interface gigabitethernet0/0',
  ]);
  answer.ios('R2', [
    'router ospf 1',
    'network 10.0.12.0 0.0.0.3 area 0',
    'network 10.0.23.0 0.0.0.3 area 0',
  ]);
  answer.ios('R3', [
    'router ospf 1',
    'network 10.0.23.0 0.0.0.3 area 0',
    'network 10.3.3.0 0.0.0.255 area 0',
    'passive-interface gigabitethernet0/1',
  ]);
  const net = (id: string, device: string, network: string): CheckInput => ({
    id,
    type: 'config',
    device,
    spec: { item: 'ospfNetwork', pid: 1, network, area: '0' },
  });
  return make(
    'ospf-single-area',
    t('OSPF in einer Area', 'OSPF single area'),
    t(
      'Drei Router in einer Kette: lass sie per OSPF Area 0 die LANs austauschen, statt statische Routen zu pflegen.',
      'Three routers in a chain: let them exchange the LANs with OSPF area 0 instead of maintaining static routes.',
    ),
    2,
    [
      {
        title: t('Prozess starten', 'Start the process'),
        text: t('Auf allen Routern: router ospf 1.', 'On all routers: router ospf 1.'),
      },
      {
        title: t('Netze ankuendigen', 'Advertise networks'),
        text: t(
          'Kuendige mit network-Anweisungen (Wildcard-Maske!) die direkt angeschlossenen Netze in Area 0 an.',
          'Advertise the directly connected networks in area 0 with network statements (wildcard mask!).',
        ),
      },
      {
        title: t('LAN-Ports passiv', 'Passive LAN ports'),
        text: t(
          'An den LAN-Seiten von R1 und R3 braucht es keine Hello-Pakete: passive-interface.',
          'The LAN sides of R1 and R3 need no hellos: passive-interface.',
        ),
      },
      {
        title: t('Pruefen', 'Verify'),
        text: t(
          'show ip ospf neighbor muss FULL zeigen; PC1 muss PC2 erreichen.',
          'show ip ospf neighbor must show FULL; PC1 must reach PC2.',
        ),
      },
    ],
    start,
    answer,
    [
      net('r1a', 'R1', '10.1.1.0'),
      net('r1b', 'R1', '10.0.12.0'),
      net('r2a', 'R2', '10.0.12.0'),
      net('r2b', 'R2', '10.0.23.0'),
      net('r3a', 'R3', '10.0.23.0'),
      net('r3b', 'R3', '10.3.3.0'),
      {
        id: 'nbr2',
        type: 'ospfNeighbors',
        device: 'R2',
        min: 2,
        weight: 2,
        label: t('R2 hat zwei Nachbarn im Zustand Full', 'R2 has two neighbours in state Full'),
        hint: t(
          'Prozess-ID, Area und Wildcard-Masken muessen auf beiden Seiten passen.',
          'Process ID, area and wildcard masks must fit on both sides.',
        ),
      },
      {
        id: 'rt1',
        type: 'route',
        device: 'R1',
        prefix: '10.3.3.0',
        plen: 24,
        source: 'ospf',
        weight: 2,
      },
      {
        id: 'rt3',
        type: 'route',
        device: 'R3',
        prefix: '10.1.1.0',
        plen: 24,
        source: 'ospf',
        weight: 2,
      },
      { id: 'ping', type: 'ping', from: 'PC1', to: 'PC2', weight: 3 },
    ],
  );
}

// ------------------------------------------------------------------ 4. PAT fuer ein Buero

function pat(): Activity {
  const build = (): Lab => {
    const l = new Lab();
    l.add('router', 'R1', 300, 200);
    l.add('router', 'ISP', 550, 200);
    l.add('switch-l2', 'SW1', 150, 200);
    l.add('pc', 'PC1', 50, 100);
    l.add('pc', 'PC2', 50, 300);
    l.add('server', 'Web', 750, 200);
    l.link('SW1', 'p24', 'R1', 'p0');
    l.link('PC1', 'p0', 'SW1', 'p0');
    l.link('PC2', 'p0', 'SW1', 'p1');
    l.link('R1', 'p1', 'ISP', 'p0');
    l.link('ISP', 'p1', 'Web', 'p0');
    l.host('PC1', '192.168.1.11', '192.168.1.1');
    l.host('PC2', '192.168.1.12', '192.168.1.1');
    l.host('Web', '198.51.100.10', '198.51.100.1');
    l.e.setService(l.id('Web'), { http: { enabled: true } });
    l.ios('R1', [
      'interface gigabitethernet0/0',
      'ip address 192.168.1.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface gigabitethernet0/1',
      'ip address 203.0.113.2 255.255.255.252',
      'no shutdown',
      'exit',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
    ]);
    l.ios('ISP', [
      'interface gigabitethernet0/0',
      'ip address 203.0.113.1 255.255.255.252',
      'no shutdown',
      'exit',
      'interface gigabitethernet0/1',
      'ip address 198.51.100.1 255.255.255.0',
      'no shutdown',
    ]);
    return l;
  };
  const start = build();
  const answer = build();
  answer.ios('R1', [
    'access-list 1 permit 192.168.1.0 0.0.0.255',
    'interface gigabitethernet0/0',
    'ip nat inside',
    'exit',
    'interface gigabitethernet0/1',
    'ip nat outside',
    'exit',
    'ip nat inside source list 1 interface gigabitethernet0/1 overload',
  ]);
  return make(
    'pat-office',
    t('PAT fuer ein Buero', 'PAT for an office'),
    t(
      'Das Bueronetz nutzt private Adressen. Der Provider kennt keine Rueckroute dorthin - uebersetze mit PAT auf die oeffentliche Adresse des Routers.',
      "The office uses private addresses. The ISP has no return route to them - translate with PAT to the router's public address.",
    ),
    3,
    [
      {
        title: t('Wer darf uebersetzt werden?', 'Who may be translated?'),
        text: t(
          'Lege eine ACL an, die das Bueronetz 192.168.1.0/24 erlaubt.',
          'Create an ACL that permits the office network 192.168.1.0/24.',
        ),
      },
      {
        title: t('Innen und aussen', 'Inside and outside'),
        text: t(
          'Markiere Gi0/0 als "ip nat inside" und Gi0/1 als "ip nat outside".',
          'Mark Gi0/0 as "ip nat inside" and Gi0/1 as "ip nat outside".',
        ),
      },
      {
        title: t('Uebersetzungsregel', 'Translation rule'),
        text: t(
          'ip nat inside source list 1 interface Gi0/1 overload - alle Clients teilen sich eine Adresse, Ports unterscheiden sie.',
          'ip nat inside source list 1 interface Gi0/1 overload - all clients share one address, ports tell them apart.',
        ),
      },
      {
        title: t('Pruefen', 'Verify'),
        text: t(
          'Beide PCs muessen den Webserver erreichen; show ip nat translations zeigt die Eintraege.',
          'Both PCs must reach the web server; show ip nat translations lists the entries.',
        ),
      },
    ],
    start,
    answer,
    [
      {
        id: 'in',
        type: 'config',
        device: 'R1',
        spec: { item: 'natRole', iface: 'Gi0/0', side: 'inside' },
      },
      {
        id: 'out',
        type: 'config',
        device: 'R1',
        spec: { item: 'natRole', iface: 'Gi0/1', side: 'outside' },
        hint: t('Die Seite zum Provider ist "outside".', 'The side facing the ISP is "outside".'),
      },
      {
        id: 'ovl',
        type: 'config',
        device: 'R1',
        spec: { item: 'natOverload' },
        weight: 2,
        hint: t(
          'Ohne das Schluesselwort overload gibt es kein PAT.',
          'Without the keyword overload there is no PAT.',
        ),
      },
      {
        id: 'acl',
        type: 'config',
        device: 'R1',
        spec: { item: 'aclEntry', acl: '1', action: 'permit', src: '192.168.1.0/24' },
        hint: t(
          'Die ACL steuert, welche Quelladressen uebersetzt werden.',
          'The ACL controls which source addresses are translated.',
        ),
      },
      {
        id: 'ping',
        type: 'ping',
        from: 'PC1',
        to: 'Web',
        weight: 3,
        label: t('PC1 erreicht den Webserver', 'PC1 reaches the web server'),
      },
      {
        id: 'http',
        type: 'service',
        from: 'PC2',
        to: 'Web',
        protocol: 'http',
        weight: 3,
        label: t('PC2 ruft die Webseite ab', 'PC2 fetches the web page'),
      },
      {
        id: 'inbound',
        type: 'ping',
        from: 'Web',
        to: 'PC1',
        expect: 'fail',
        weight: 1,
        label: t(
          'Der Server kann von aussen kein Buero-Geraet erreichen',
          'The server cannot reach an office device from outside',
        ),
      },
    ],
  );
}

// ------------------------------------------------------------------ 5. ACL: HTTP aus dem Gast-VLAN sperren

function acl(): Activity {
  const build = (): Lab => {
    const l = new Lab();
    l.add('router', 'R1', 350, 200);
    l.add('pc', 'Guest', 100, 100);
    l.add('pc', 'Staff', 100, 300);
    l.add('server', 'Web', 600, 200);
    l.link('Guest', 'p0', 'R1', 'p0');
    l.link('Staff', 'p0', 'R1', 'p1');
    l.link('R1', 'p2', 'Web', 'p0');
    l.host('Guest', '192.168.20.10', '192.168.20.1');
    l.host('Staff', '192.168.10.10', '192.168.10.1');
    l.host('Web', '192.168.30.10', '192.168.30.1');
    l.e.setService(l.id('Web'), { http: { enabled: true } });
    l.ios('R1', [
      'interface gigabitethernet0/0',
      'ip address 192.168.20.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface gigabitethernet0/1',
      'ip address 192.168.10.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface gigabitethernet0/2',
      'ip address 192.168.30.1 255.255.255.0',
      'no shutdown',
    ]);
    return l;
  };
  const start = build();
  const answer = build();
  answer.ios('R1', [
    'ip access-list extended GUEST-IN',
    'deny tcp 192.168.20.0 0.0.0.255 host 192.168.30.10 eq 80',
    'permit ip any any',
    'exit',
    'interface gigabitethernet0/0',
    'ip access-group GUEST-IN in',
  ]);
  return make(
    'acl-block-http',
    t('ACL sperrt HTTP aus dem Gastnetz', 'ACL blocks HTTP from the guest network'),
    t(
      'Gaeste duerfen den Webserver anpingen, aber keine Webseiten abrufen. Alles andere bleibt erlaubt.',
      'Guests may ping the web server but must not fetch web pages. Everything else stays permitted.',
    ),
    3,
    [
      {
        title: t('Erweiterte ACL', 'Extended ACL'),
        text: t(
          'Lege eine benannte erweiterte ACL GUEST-IN an: deny tcp vom Gastnetz zum Server 192.168.30.10, Port 80.',
          'Create a named extended ACL GUEST-IN: deny tcp from the guest network to server 192.168.30.10, port 80.',
        ),
      },
      {
        title: t('Rest erlauben', 'Permit the rest'),
        text: t(
          'Am Ende jeder ACL steht ein implizites deny - ergaenze permit ip any any.',
          'Every ACL ends with an implicit deny - add permit ip any any.',
        ),
      },
      {
        title: t('Anwenden', 'Apply'),
        text: t(
          'Binde die ACL eingehend (in) an Gi0/0, die Schnittstelle zum Gastnetz.',
          'Bind the ACL inbound (in) on Gi0/0, the interface facing the guest network.',
        ),
      },
      {
        title: t('Pruefen', 'Verify'),
        text: t(
          'Guest darf pingen, aber keine Webseite laden; Staff darf beides.',
          'Guest can ping but not load the web page; Staff can do both.',
        ),
      },
    ],
    start,
    answer,
    [
      {
        id: 'deny',
        type: 'config',
        device: 'R1',
        spec: {
          item: 'aclEntry',
          acl: 'GUEST-IN',
          action: 'deny',
          protocol: 'tcp',
          dstPort: 80,
          src: '192.168.20.0/24',
        },
        weight: 2,
        hint: t(
          'Wildcard-Maske 0.0.0.255 fuer ein /24-Netz.',
          'Wildcard mask 0.0.0.255 for a /24 network.',
        ),
      },
      {
        id: 'permit',
        type: 'config',
        device: 'R1',
        spec: { item: 'aclEntry', acl: 'GUEST-IN', action: 'permit' },
        hint: t(
          'Sonst blockiert das implizite deny alles.',
          'Otherwise the implicit deny blocks everything.',
        ),
      },
      {
        id: 'apply',
        type: 'config',
        device: 'R1',
        spec: { item: 'ifaceAcl', iface: 'Gi0/0', direction: 'in', acl: 'GUEST-IN' },
        weight: 2,
        hint: t(
          'ip access-group GUEST-IN in - an der Schnittstelle, nicht global.',
          'ip access-group GUEST-IN in - on the interface, not globally.',
        ),
      },
      {
        id: 'noHttp',
        type: 'service',
        from: 'Guest',
        to: 'Web',
        protocol: 'http',
        expect: 'fail',
        weight: 3,
        label: t('Guest kann die Webseite nicht abrufen', 'Guest cannot fetch the web page'),
      },
      {
        id: 'ping',
        type: 'ping',
        from: 'Guest',
        to: 'Web',
        weight: 2,
        label: t('Guest kann den Server weiterhin anpingen', 'Guest can still ping the server'),
      },
      {
        id: 'staff',
        type: 'service',
        from: 'Staff',
        to: 'Web',
        protocol: 'http',
        weight: 2,
        label: t('Staff ruft die Webseite weiterhin ab', 'Staff can still fetch the web page'),
      },
    ],
  );
}

let cache: Activity[] | undefined;

/** Die mitgelieferten Beispielaufgaben (deterministisch erzeugt, zweisprachig). */
export function exampleActivities(): Activity[] {
  cache ??= [vlanTrunk(), routerOnAStick(), ospf(), pat(), acl()];
  return structuredClone(cache);
}
