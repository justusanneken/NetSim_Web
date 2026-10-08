import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession, HostShell } from '../src';

function mk(type: 'router' | 'switch-l2' | 'switch-l3', name: string) {
  const e = new Engine({ seed: 1 });
  const id = e.addDevice(type, { name });
  const d = e.getDevice(id);
  if (d && (d.config.kind === 'router' || d.config.kind === 'switch'))
    d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  return { e, id, s, run };
}

/** Zeilen vor jeder Fehlermeldung (Befehl mit Prompt) für aussagekräftige Fehler. */
const ctx = (out: string): string =>
  out
    .split('\n')
    .map((l, i, a) => (l.startsWith('%') ? a.slice(Math.max(0, i - 3), i).join(' | ') : ''))
    .filter(Boolean)
    .join('\n');

describe('CLI Phase 3', () => {
  it('VLAN, Access/Trunk, show vlan brief / trunk / switchport', () => {
    const t = mk('switch-l2', 'SW1');
    const out = t.run(
      'enable',
      'configure terminal',
      'vlan 10',
      'name Sales',
      'exit',
      'interface range fa0/1 - 2',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',
      'interface gi0/1',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10,20',
      'end',
      'show vlan brief',
      'show interfaces trunk',
      'show running-config',
    );
    expect(out).toMatch(/10\s+Sales\s+active\s+Fa0\/1, Fa0\/2/);
    expect(out).toContain('switchport trunk allowed vlan 10,20');
    expect(out).toContain('switchport access vlan 10');
  });

  it('running-config round trip mit Phase-3-Konfiguration', () => {
    const t = mk('router', 'R1');
    t.run(
      'enable',
      'configure terminal',
      'interface gi0/0.10',
      'encapsulation dot1Q 10',
      'ip address 10.0.10.1 255.255.255.0',
      'ip helper-address 10.0.20.5',
      'exit',
      'ip dhcp pool LAN',
      'network 10.0.10.0 255.255.255.0',
      'default-router 10.0.10.1',
      'exit',
      'ip access-list extended WEB',
      'deny tcp any any eq 80',
      'permit ip any any',
      'exit',
      'access-list 1 permit 10.0.10.0 0.0.0.255',
      'ip nat inside source list 1 interface gi0/1 overload',
      'end',
    );
    const before = t.s.input('show running-config');
    expect(before).toContain('ip access-list extended WEB');
    expect(before).toContain('ip nat inside source list 1 interface');
    t.run('copy running-config startup-config', '');
    t.run('reload', '');
    const after = new CliSession(t.e, t.id);
    after.input('enable');
    const again = after.input('show running-config');
    expect(again.replace(/Current configuration.*\n/, '')).toBe(
      before.replace(/Current configuration.*\n/, ''),
    );
  });

  it('ACL- und NAT-Show-Befehle', () => {
    const t = mk('router', 'R1');
    const out = t.run(
      'enable',
      'configure terminal',
      'ip access-list extended WEB',
      'deny tcp any any eq 80',
      'permit ip any any',
      'end',
      'show access-lists',
      'show ip nat translations',
    );
    expect(out).toContain('Extended IP access list WEB');
    expect(out).toContain('10 deny tcp any any eq www');
  });

  it('Host-Shell: ipconfig /renew per DHCP, nslookup, Ping per Name', () => {
    const e = new Engine({ seed: 1 });
    const sw = e.addDevice('switch-l2', { name: 'SW' });
    const srv = e.addDevice('server', { name: 'SRV' });
    const pc = e.addDevice('pc', { name: 'PC' });
    e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
    e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight');
    e.setHostIp(srv, '10.0.0.2', '255.255.255.0');
    e.setService(srv, {
      dhcp: {
        enabled: true,
        pools: [
          {
            name: 'LAN',
            network: '10.0.0.0',
            mask: '255.255.255.0',
            router: '10.0.0.1',
            dns: ['10.0.0.2'],
            leaseSec: 3600,
            rangeStart: '10.0.0.100',
            rangeEnd: '10.0.0.150',
          },
        ],
      },
      dns: { enabled: true, records: [{ name: 'srv.lab', type: 'A', data: '10.0.0.2', ttl: 300 }] },
    });
    e.runUntil(e.state.now + 40_000_000);
    const sh = new HostShell(e, pc);
    expect(sh.input('ipconfig /renew')).toContain('10.0.0.100');
    expect(sh.input('nslookup srv.lab')).toContain('Address:  10.0.0.2');
    const ping = sh.input('ping -n 1 srv.lab');
    expect(ping).toContain('Pinging srv.lab [10.0.0.2]');
    expect(ping).toContain('Reply from 10.0.0.2');
  });

  it('Switch: breite Befehlsabdeckung ohne Fehlermeldungen', () => {
    const t = mk('switch-l3', 'SW3');
    const cmds = [
      'enable',
      'configure terminal',
      'vtp mode server',
      'vtp domain LAB',
      'vlan 10',
      'name Sales',
      'exit',
      'vlan 20',
      'name Eng',
      'exit',
      'spanning-tree mode rapid-pvst',
      'spanning-tree vlan 10 priority 4096',
      'spanning-tree portfast default',
      'errdisable recovery cause psecure-violation',
      'errdisable recovery interval 60',
      'mac address-table aging-time 120',
      'ip routing',
      'interface vlan 10',
      'ip address 10.0.10.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface range fa0/1 - 3',
      'switchport mode access',
      'switchport access vlan 10',
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
      'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security violation restrict',
      'switchport port-security mac-address sticky',
      'exit',
      'interface range fa0/10 - 11',
      'channel-group 1 mode active',
      'exit',
      'interface port-channel 1',
      'switchport mode trunk',
      'exit',
      'interface gi0/1',
      'switchport mode trunk',
      'switchport trunk native vlan 99',
      'switchport trunk allowed vlan 10,20',
      'exit',
      'ip dhcp excluded-address 10.0.10.1 10.0.10.10',
      'ip dhcp pool P',
      'network 10.0.10.0 255.255.255.0',
      'default-router 10.0.10.1',
      'dns-server 10.0.10.2',
      'lease 1',
      'exit',
      'access-list 10 permit 10.0.10.0 0.0.0.255',
      'ip access-list standard STD',
      'permit host 10.0.10.5',
      'exit',
      'interface vlan 10',
      'ip access-group STD in',
      'ip helper-address 10.0.20.2',
      'end',
      'show vlan brief',
      'show vlan id 10',
      'show interfaces trunk',
      'show interfaces switchport',
      'show interfaces status',
      'show spanning-tree',
      'show spanning-tree vlan 10',
      'show spanning-tree summary',
      'show etherchannel summary',
      'show port-security',
      'show port-security interface fa0/1',
      'show vtp status',
      'show ip dhcp binding',
      'show ip dhcp pool',
      'show ip dhcp conflict',
      'show access-lists',
      'show ip interface brief',
      'show ip route',
      'show mac address-table',
      'show running-config',
    ];
    const out = t.run(...cmds);
    const bad = out.split('\n').filter((l) => l.startsWith('%'));
    expect(bad, ctx(out)).toEqual([]);
    expect(out).toContain('spanning-tree mode rapid-pvst');
  });

  it('Router: NAT, Relay, ACL-Anwendung und no-Formen', () => {
    const t = mk('router', 'R1');
    const out = t.run(
      'enable',
      'configure terminal',
      'interface gi0/0',
      'ip address 10.0.0.1 255.255.255.0',
      'ip nat inside',
      'ip access-group 101 in',
      'no shutdown',
      'exit',
      'interface gi0/1',
      'ip address 203.0.113.2 255.255.255.0',
      'ip nat outside',
      'no shutdown',
      'exit',
      'access-list 101 permit tcp any any eq 80',
      'access-list 101 deny ip any any',
      'ip nat pool POOL 203.0.113.10 203.0.113.20 netmask 255.255.255.0',
      'ip nat inside source list 1 pool POOL',
      'ip nat inside source static 10.0.0.5 203.0.113.30',
      'ip nat inside source static tcp 10.0.0.6 80 203.0.113.2 8080',
      'ip nat translation timeout 600',
      'no ip nat inside source static 10.0.0.5 203.0.113.30',
      'no access-list 101',
      'end',
      'show ip nat translations',
      'show ip nat statistics',
      'show ip interface gi0/0',
      'show running-config',
    );
    expect(
      out.split('\n').filter((l) => l.startsWith('%')),
      ctx(out),
    ).toEqual([]);
  });
});
