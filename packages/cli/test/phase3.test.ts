import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession } from '../src';

function mk(type: 'router' | 'switch-l2' | 'switch-l3', name: string) {
  const e = new Engine({ seed: 1 });
  const id = e.addDevice(type, { name });
  const d = e.getDevice(id);
  if (d) d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  return { e, id, s, run };
}

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
});
