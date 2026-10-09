import { describe, expect, it } from 'vitest';
import { diamond, roundTrip, sec } from './gapsLab';

function areas() {
  const lab = diamond();
  const { r1, r2, r4 } = lab;
  r1.run(
    'configure terminal',
    'router ospf 1',
    'network 10.0.12.0 0.0.0.255 area 0',
    'network 10.1.0.0 0.0.0.255 area 0',
    'end',
  );
  r2.run(
    'configure terminal',
    'router ospf 1',
    'network 10.0.12.0 0.0.0.255 area 0',
    'network 10.0.24.0 0.0.0.255 area 1',
    'end',
  );
  r4.run(
    'configure terminal',
    'router ospf 1',
    'network 10.0.24.0 0.0.0.255 area 1',
    'network 10.4.0.0 0.0.0.255 area 1',
    'end',
  );
  return lab;
}

describe('Lücken: OSPF-Bereichstypen und Authentifizierung im CLI', () => {
  it('area stub / no-summary, show ip ospf, Replay', () => {
    const { e, r1, r2, r4, pc4 } = areas();
    r2.run('configure terminal', 'router ospf 1', 'area 1 stub no-summary', 'end');
    r4.run('configure terminal', 'router ospf 1', 'area 1 stub', 'end');
    sec(e, 150);
    const rt = r4.run('show ip route');
    expect(rt).toMatch(/O\*IA\s+0\.0\.0\.0\/0/);
    expect(rt).not.toContain('10.1.0.0/24');
    expect(r4.run('show ip ospf')).toContain('It is a stub area');
    expect(r2.run('show ip ospf')).toContain('no summary LSA in this area');
    expect(r1.run('show ip route')).toMatch(/O IA\s+10\.4\.0\.0\/24/);
    const cfg = roundTrip(e, r2);
    expect(cfg).toContain(' area 1 stub no-summary');
    r2.run('configure terminal', 'router ospf 1', 'no area 1 stub', 'end');
    expect(r2.run('show running-config')).not.toContain('area 1 stub');
    void pc4;
  });

  it('area nssa, default-cost, virtual-link, area authentication im Replay', () => {
    const { e, r2 } = areas();
    r2.run(
      'configure terminal',
      'router ospf 1',
      'area 1 nssa no-summary default-information-originate',
      'area 1 default-cost 7',
      'area 1 virtual-link 9.9.9.9',
      'area 0 authentication message-digest',
      'end',
    );
    const cfg = roundTrip(e, r2);
    for (const must of [
      ' area 1 nssa no-summary default-information-originate',
      ' area 1 default-cost 7',
      ' area 1 virtual-link 9.9.9.9',
      ' area 0 authentication message-digest',
    ])
      expect(cfg).toContain(must);
    expect(r2.run('show ip ospf virtual-links')).toContain(
      'Virtual Link OSPF_VL0 to router 9.9.9.9',
    );
    expect(r2.run('configure terminal', 'router ospf 1', 'area 0 stub')).toContain('Backbone');
  });

  it('no area N entfernt alle Bereichseinstellungen, aber keine network-Anweisungen', () => {
    const { e, r2 } = areas();
    r2.run(
      'configure terminal',
      'router ospf 1',
      'area 1 nssa no-summary',
      'area 1 default-cost 7',
      'area 1 authentication message-digest',
      'area 1 range 10.4.0.0 255.255.0.0',
      'area 1 virtual-link 9.9.9.9',
      'area 2 virtual-link 8.8.8.8',
      'area 0 authentication',
      'end',
    );
    let cfg = r2.run('show running-config');
    expect(cfg).toContain(' area 1 nssa no-summary');
    expect(cfg).toContain(' area 1 range 10.4.0.0 255.255.0.0');
    const out = r2.run('configure terminal', 'router ospf 1', 'no area 1', 'end');
    expect(out).not.toContain('%');
    cfg = roundTrip(e, r2);
    expect(cfg).not.toMatch(/ area 1 (nssa|default-cost|authentication|range|virtual-link)/);
    // andere Bereiche und network-Anweisungen bleiben
    expect(cfg).toContain(' area 2 virtual-link 8.8.8.8');
    expect(cfg).toContain(' area 0 authentication');
    expect(cfg).toContain(' network 10.0.24.0 0.0.0.255 area 1');
    // idempotent, auch für unbekannte Areas
    expect(
      r2.run('configure terminal', 'router ospf 1', 'no area 1', 'no area 7', 'end'),
    ).not.toContain('%');
    expect(r2.run('configure terminal', 'router ospf 1', 'area 1')).toContain('% Incomplete');
  });

  it('Schnittstellen-Authentifizierung: Befehle, Hello-Verwurf bei falschem Schlüssel', () => {
    const { e, r1, r2 } = areas();
    r1.run(
      'configure terminal',
      'interface gi0/0',
      'ip ospf authentication',
      'ip ospf authentication-key geheim',
      'end',
    );
    r2.run(
      'configure terminal',
      'interface gi0/0',
      'ip ospf authentication',
      'ip ospf authentication-key falsch',
      'end',
    );
    sec(e, 100);
    expect(r1.run('show ip ospf neighbor')).not.toContain('10.0.12.2');
    expect(e.log.some((l) => l.msg.key === 'ospf.authFail')).toBe(true);
    r2.run('configure terminal', 'interface gi0/0', 'ip ospf authentication-key geheim', 'end');
    sec(e, 100);
    expect(r1.run('show ip ospf neighbor')).toContain('FULL');
    r2.run(
      'configure terminal',
      'interface gi0/0',
      'ip ospf message-digest-key 3 md5 abc',
      'ip ospf authentication message-digest',
      'end',
    );
    const cfg = r2.run('show running-config');
    expect(cfg).toContain(' ip ospf authentication message-digest');
    expect(cfg).toContain(' ip ospf message-digest-key 3 md5 abc');
    // Interface-Optionen ohne `ip ospf PID area` ändern nichts an der network-Zuordnung
    expect(cfg).not.toContain('ip ospf 1 area');
    roundTrip(e, r2);
  });
});
