import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, replayEqual, secs, wire } from './ccnaLab';

function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = cli(e, 'R1', 'router');
  const s1 = cli(e, 'SW1');
  const pc = e.addDevice('pc', { name: 'PC0' });
  e.connect({ deviceId: r1.id, portId: 'p0' }, { deviceId: s1.id, portId: 'p25' }, 'straight');
  e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: s1.id, portId: 'p0' }, 'straight');
  r1.cfg(
    'interface gi0/0',
    'ip address 10.0.1.1 255.255.255.0',
    'no shutdown',
    'exit',
    'ip dhcp excluded-address 10.0.1.1 10.0.1.9',
    'ip dhcp pool LAN',
    'network 10.0.1.0 255.255.255.0',
    'default-router 10.0.1.1',
  );
  return { e, r1, s1, pc };
}

describe('DHCP snooping CLI', () => {
  it('configuration, show output and binding table', () => {
    const { e, r1, s1, pc } = lab();
    s1.cfg(
      'ip dhcp snooping',
      'ip dhcp snooping vlan 1',
      'no ip dhcp snooping information option',
      'interface gi0/2',
      'ip dhcp snooping trust',
      'exit',
      'interface fa0/1',
      'ip dhcp snooping limit rate 15',
    );
    secs(e, 35);
    e.setHostDhcp(pc, true);
    secs(e, 10);
    const sh = s1.out('enable', 'show ip dhcp snooping');
    expect(sh).toContain('Switch DHCP snooping is enabled');
    expect(sh).toContain('DHCP snooping is configured on following VLANs:\n1\n');
    expect(sh).toContain('Insertion of option 82 is disabled');
    expect(sh).toContain('Verification of hwaddr field is enabled');
    expect(sh).toMatch(/GigabitEthernet0\/2\s+yes\s+no\s+unlimited/);
    expect(sh).toMatch(/FastEthernet0\/1\s+no\s+no\s+15/);
    const b = s1.out('show ip dhcp snooping binding');
    expect(b).toContain(
      'MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface',
    );
    expect(b).toMatch(
      /^[0-9A-F:]{17}\s+10\.0\.1\.\d+\s+\d+\s+dhcp-snooping\s+1\s+FastEthernet0\/1$/m,
    );
    expect(b).toContain('Total number of bindings: 1');
    s1.run('clear ip dhcp snooping binding');
    expect(s1.out('show ip dhcp snooping binding')).toContain('Total number of bindings: 0');
    void r1;
  });

  it('option 82 default: server router drops until trust-all is configured', () => {
    const { e, r1, s1, pc } = lab();
    s1.cfg(
      'ip dhcp snooping',
      'ip dhcp snooping vlan 1',
      'interface gi0/2',
      'ip dhcp snooping trust',
    );
    secs(e, 35);
    e.setHostDhcp(pc, true);
    secs(e, 8);
    expect(r1.out('show ip dhcp binding')).not.toContain('10.0.1.');
    r1.cfg('ip dhcp relay information trust-all');
    secs(e, 30);
    expect(r1.out('show ip dhcp binding')).toContain('10.0.1.');
  });

  it('running-config renders and replays all snooping and DAI settings', () => {
    const { e, s1 } = lab();
    s1.cfg(
      'ip dhcp snooping',
      'ip dhcp snooping vlan 1,10-12',
      'no ip dhcp snooping information option',
      'no ip dhcp snooping verify mac-address',
      'ip arp inspection vlan 10',
      'ip arp inspection validate src-mac dst-mac ip',
      'arp access-list STATIC',
      'permit ip host 10.0.10.5 mac host 0001.0002.0003',
      'exit',
      'ip arp inspection filter STATIC vlan 10 static',
      'interface gi0/2',
      'ip dhcp snooping trust',
      'ip arp inspection trust',
      'exit',
      'interface fa0/1',
      'ip dhcp snooping limit rate 20',
      'ip arp inspection limit rate 30 burst interval 3',
    );
    const rc = replayEqual(e, s1);
    for (const l of [
      'ip dhcp snooping\n',
      'ip dhcp snooping vlan 1,10-12',
      'no ip dhcp snooping information option',
      'no ip dhcp snooping verify mac-address',
      'ip arp inspection vlan 10',
      'ip arp inspection validate src-mac dst-mac ip',
      'arp access-list STATIC\n permit ip host 10.0.10.5 mac host 0001.0002.0003',
      'ip arp inspection filter STATIC vlan 10 static',
      ' ip dhcp snooping trust',
      ' ip arp inspection trust',
      ' ip dhcp snooping limit rate 20',
      ' ip arp inspection limit rate 30 burst interval 3',
    ])
      expect(rc, l).toContain(l);
    expect(s1.out('enable', 'show arp access-list')).toContain(
      'ARP access list STATIC\n    permit ip host 10.0.10.5 mac host 0001.0002.0003',
    );
    // no-Formen
    s1.cfg('no ip dhcp snooping', 'no ip arp inspection vlan 10', 'no arp access-list STATIC');
    const after = s1.out('show running-config');
    expect(after).not.toContain('\nip dhcp snooping\n');
    expect(after).not.toContain('ip arp inspection vlan');
  });

  it('show ip arp inspection and interfaces', () => {
    const { s1 } = lab();
    s1.cfg('ip arp inspection vlan 1', 'interface gi0/2', 'ip arp inspection trust');
    const out = s1.out('enable', 'show ip arp inspection');
    expect(out).toContain('Source Mac Validation      : Disabled');
    expect(out).toMatch(/^\s+1\s+Enabled\s+Active/m);
    const ifs = s1.out('show ip arp inspection interfaces');
    expect(ifs).toMatch(/Fa0\/1\s+Untrusted\s+15\s+1/);
    expect(ifs).toMatch(/Gi0\/2\s+Trusted\s+None\s+N\/A/);
  });
});

describe('Port security / errdisable CLI', () => {
  it('errdisable recovery causes, show errdisable recovery, no forms, replay', () => {
    const { s1, e } = lab();
    s1.cfg(
      'errdisable recovery cause bpduguard',
      'errdisable recovery cause psecure-violation',
      'errdisable recovery interval 60',
    );
    const out = s1.out('enable', 'show errdisable recovery');
    expect(out).toContain('ErrDisable Reason            Timer Status');
    expect(out).toMatch(/^bpduguard\s+Enabled$/m);
    expect(out).toMatch(/^psecure-violation\s+Enabled$/m);
    expect(out).toMatch(/^storm-control\s+Disabled$/m);
    expect(out).toContain('Timer interval: 60 seconds');
    const rc = replayEqual(e, s1);
    expect(rc).toContain(
      'errdisable recovery cause bpduguard\nerrdisable recovery cause psecure-violation\nerrdisable recovery interval 60',
    );
    s1.cfg('no errdisable recovery cause bpduguard');
    expect(s1.out('show running-config')).not.toContain('cause bpduguard');
  });

  it('bpduguard violation is logged, port err-disabled and recovered by timer', () => {
    const e = new Engine({ seed: 1 });
    const a = cli(e, 'A');
    const b = cli(e, 'B');
    wire(e, a, 'p0', b, 'p0');
    a.cfg(
      'errdisable recovery cause bpduguard',
      'errdisable recovery interval 30',
      'interface fa0/1',
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
    );
    secs(e, 20);
    const log = a.out('enable', 'show logging');
    expect(log).toContain(
      '%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port FastEthernet0/1 with BPDU Guard enabled. Disabling port.',
    );
    expect(log).toContain(
      '%PM-4-ERR_DISABLE: bpduguard error detected on FastEthernet0/1, putting FastEthernet0/1 in err-disable state',
    );
    expect(a.out('show interfaces status err-disabled')).toMatch(/Fa0\/1\s+err-disabled/);
    expect(a.out('show errdisable recovery')).toMatch(/Fa0\/1\s+bpduguard\s+\d+/);
    secs(e, 40);
    expect(a.out('show logging')).toContain(
      '%PM-4-ERR_RECOVER: Attempting to recover from bpduguard err-disable state on FastEthernet0/1',
    );
  });

  it('port-security: violation syslog, aging config, show port-security address, replay', () => {
    const { s1, e } = lab();
    s1.cfg(
      'interface fa0/5',
      'switchport mode access',
      'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security violation restrict',
      'switchport port-security aging time 10',
      'switchport port-security aging type inactivity',
      'switchport port-security mac-address 0001.0002.0003',
    );
    const rc = replayEqual(e, s1);
    expect(rc).toContain(' switchport port-security aging time 10');
    expect(rc).toContain(' switchport port-security aging type inactivity');
    const addr = s1.out('enable', 'show port-security address');
    expect(addr).toContain('Secure Mac Address Table');
    expect(addr).toMatch(/1\s+0001\.0002\.0003\s+SecureConfigured\s+Fa0\/5/);
    s1.cfg(
      'interface fa0/5',
      'no switchport port-security aging time',
      'no switchport port-security aging type',
    );
    expect(s1.out('show running-config')).not.toContain('aging time');
  });
});

describe('storm-control, voice vlan, nonegotiate, portfast default CLI', () => {
  it('config, show storm-control, errors and replay', () => {
    const { s1, e } = lab();
    s1.cfg(
      'vlan 20',
      'exit',
      'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      'interface fa0/2',
      'switchport mode access',
      'switchport voice vlan 20',
      'storm-control broadcast level 20.50 10',
      'storm-control multicast level pps 500',
      'storm-control action shutdown',
      'interface fa0/3',
      'spanning-tree portfast disable',
      'spanning-tree bpduguard disable',
      'interface gi0/1',
      'switchport mode trunk',
      'switchport nonegotiate',
    );
    const rc = replayEqual(e, s1);
    for (const l of [
      'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      ' switchport voice vlan 20',
      ' storm-control broadcast level 20.5 10',
      ' storm-control multicast level pps 500',
      ' storm-control action shutdown',
      ' spanning-tree portfast disable',
      ' switchport nonegotiate',
    ])
      expect(rc, l).toContain(l);
    const st = s1.out('enable', 'show storm-control broadcast');
    expect(st).toContain('Interface  Filter State   Upper        Lower        Current');
    expect(st).toMatch(/Fa0\/2\s+Link Down\s+20\.50%\s+10\.00%/);
    // nonegotiate conflicts with dynamic modes
    const err = s1.out('configure terminal', 'interface fa0/9', 'switchport nonegotiate');
    expect(err).toContain("Command rejected: Conflict between 'nonegotiate' and 'dynamic' status.");
    s1.cfg(
      'interface fa0/2',
      'no storm-control broadcast level',
      'no storm-control multicast level',
      'no storm-control action',
      'no switchport voice vlan',
    );
    const after = s1.out('show running-config');
    expect(after).not.toContain('storm-control');
    expect(after).not.toContain('voice vlan');
  });
});
