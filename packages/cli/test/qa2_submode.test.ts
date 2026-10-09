import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { router } from './gapsLab';

describe('QA2: globale Befehle aus Untermodi (IOS-Parser fällt auf den globalen Modus zurück)', () => {
  it('Konfiguration ohne exit zwischen den Blöcken (typisches Einfügen)', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    const out = r.run(
      'enable',
      'configure terminal',
      'crypto isakmp policy 10',
      'encryption aes',
      'authentication pre-share',
      'crypto isakmp key geheim address 198.51.100.1',
      'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
      'crypto map VPN 10 ipsec-isakmp',
      'set peer 198.51.100.1',
      'set transform-set TS',
      'tacacs server T1',
      'address ipv4 10.0.0.5',
      'line vty 0 4',
      'password cisco',
      'interface gi0/0',
      'ip address 10.0.0.1 255.255.255.0',
      'router ospf 1',
      'network 10.0.0.0 0.0.0.255 area 0',
      'end',
    );
    expect(out).not.toMatch(/% Invalid/);
    const rc = r.s.input('show running-config');
    expect(rc).toContain('crypto isakmp key geheim address 198.51.100.1');
    expect(rc).toContain('crypto ipsec transform-set TS esp-aes esp-sha-hmac');
    expect(rc).toContain('crypto map VPN 10 ipsec-isakmp\n set peer 198.51.100.1');
    expect(rc).toContain('tacacs server T1\n address ipv4 10.0.0.5');
    expect(rc).toMatch(/line vty 0 4\n password cisco/);
    expect(rc).toContain(' network 10.0.0.0 0.0.0.255 area 0');
    // der Modus wechselt mit dem globalen Befehl
    r.run('configure terminal', 'interface gi0/1', 'hostname EDGE');
    expect(r.s.prompt()).toBe('EDGE(config)#');
  });

  it('ungültige Eingaben bleiben ungültig und der Modus unverändert', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run('enable', 'configure terminal', 'interface gi0/0');
    expect(r.run('blubber 1')).toContain('% Invalid input');
    expect(r.s.prompt()).toBe('R1(config-if)#');
  });
});
