import { describe, expect, it } from 'vitest';
import { diamond, roundTrip, sec } from './gapsLab';

describe('Lücken: HSRP v2, Authentifizierung, IPv6 im CLI', () => {
  it('standby version 2, Gruppe > 255, authentication, show standby, Replay', () => {
    const { e, r1, r2 } = diamond();
    const cfg = (r: typeof r1, prio: number, extra: string[] = []): void => {
      r.run(
        'configure terminal',
        'interface gi0/0',
        'standby version 2',
        'standby 300 ip 10.0.12.254',
        'standby 300 priority ' + prio,
        'standby 300 preempt',
        'standby 300 authentication hsrpkey',
        ...extra,
        'end',
      );
    };
    cfg(r1, 120);
    cfg(r2, 100);
    sec(e, 60);
    const out = r1.run('show standby');
    expect(out).toContain('GigabitEthernet0/0 - Group 300');
    expect(out).toContain('State is Active');
    expect(out).toContain('(HSRP version 2)');
    expect(out).toContain('0000.0c9f.f12c');
    expect(out).toContain('Authentication text "hsrpkey"');
    expect(r2.run('show standby brief')).toContain('Standby');
    const text = roundTrip(e, r1);
    for (const must of [
      ' standby version 2',
      ' standby 300 ip 10.0.12.254',
      ' standby 300 authentication hsrpkey',
      ' standby 300 priority 120',
      ' standby 300 preempt',
    ])
      expect(text).toContain(must);
    // falscher Schlüssel: kein Gespräch mehr
    r2.run('configure terminal', 'interface gi0/0', 'standby 300 authentication anders', 'end');
    sec(e, 60);
    expect(e.log.some((l) => l.msg.key === 'hsrp.authFail')).toBe(true);
  });

  it('Fehler: Gruppe > 255 ohne Version 2; IPv6 ohne Version 2', () => {
    const { r1 } = diamond();
    expect(r1.run('configure terminal', 'interface gi0/0', 'standby 300 ip 10.0.12.254')).toContain(
      'out of range',
    );
    expect(r1.run('standby 1 ipv6 autoconfig')).toContain('requires HSRP version 2');
  });

  it('standby ipv6 autoconfig / Adresse: Konfiguration, show standby, Replay', () => {
    const { e, r1, r2 } = diamond();
    for (const [r, prio] of [
      [r1, 120],
      [r2, 100],
    ] as const)
      r.run(
        'configure terminal',
        'ipv6 unicast-routing',
        'interface gi0/0',
        'ipv6 address 2001:db8:12::' + (prio === 120 ? '1' : '2') + '/64',
        'standby version 2',
        'standby 5 priority ' + prio,
        'standby 5 preempt',
        'standby 5 ipv6 autoconfig',
        'standby 6 ipv6 2001:db8:12::ff',
        'end',
      );
    sec(e, 60);
    const out = r1.run('show standby');
    expect(out).toContain('Group 5 (IPv6)');
    expect(out).toContain('Virtual IPv6 address is fe80::5:73ff:fea0:5');
    expect(out).toContain('0005.73a0.0005');
    expect(out).toContain('Virtual IPv6 address is 2001:db8:12::ff');
    const text = roundTrip(e, r1);
    expect(text).toContain(' standby 5 ipv6 autoconfig');
    expect(text.toLowerCase()).toContain(' standby 6 ipv6 2001:db8:12::ff');
    r1.run('configure terminal', 'interface gi0/0', 'no standby 5 ipv6', 'end');
    expect(r1.run('show running-config')).not.toContain('standby 5 ipv6');
  });
});
