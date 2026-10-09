import { describe, expect, it } from 'vitest';
import { CONFIG_ROUTER, rig } from './helpers';

describe('Statische Routen (IOS-Syntax)', () => {
  it('Null0, name, tag, permanent, Schnittstelle + Next-Hop erscheinen in der running-config und im Replay', () => {
    const r = rig();
    r.run(
      ...CONFIG_ROUTER,
      'configure terminal',
      'ip route 10.9.0.0 255.255.0.0 Null0',
      'ip route 10.8.0.0 255.255.0.0 10.0.1.10 name BACKUP tag 5 permanent',
      'ip route 10.7.0.0 255.255.0.0 gi0/0 10.0.1.10 150',
      'end',
    );
    const cfg = r.run('show running-config');
    expect(cfg).toContain('ip route 10.7.0.0 255.255.0.0 GigabitEthernet0/0 10.0.1.10 150');
    expect(cfg).toContain('ip route 10.8.0.0 255.255.0.0 10.0.1.10 name BACKUP tag 5 permanent');
    expect(cfg).toContain('ip route 10.9.0.0 255.255.0.0 Null0');
    const rt = r.run('show ip route static');
    expect(rt).toContain('S        10.9.0.0/16 is directly connected, Null0');
    expect(rt).toContain('S        10.7.0.0/16 [150/0] via 10.0.1.10');
  });

  it('Null0-Route verwirft Verkehr (ICMP net unreachable) und überdeckt die Default-Route', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER, 'configure terminal', 'ip route 10.9.0.0 255.255.0.0 Null0', 'end');
    expect(r.run('ping 10.9.9.9')).toContain('Success rate is 0 percent');
  });

  it('show ip route <addr> und <addr> <mask> im IOS-Format', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER, 'configure terminal', 'ip route 10.5.0.0 255.255.0.0 10.0.1.10', 'end');
    expect(r.run('show ip route 10.5.1.1')).toContain(
      [
        'Routing entry for 10.5.0.0/16',
        '  Known via "static", distance 1, metric 0',
        '  Routing Descriptor Blocks:',
        '  * 10.0.1.10',
        '      Route metric is 0, traffic share count is 1',
      ].join('\n'),
    );
    expect(r.run('show ip route 10.0.1.0')).toContain(
      '  Known via "connected", distance 0, metric 0 (connected, via interface)',
    );
    expect(r.run('show ip route 10.5.0.0 255.255.0.0')).toContain('Routing entry for 10.5.0.0/16');
    expect(r.run('show ip route 10.5.0.0 255.255.255.0')).toContain('% Subnet not in table');
    expect(r.run('show ip route 99.9.9.9')).toContain('% Network not in table');
  });

  it('Floating Static: Route mit höherer AD wird erst bei Ausfall der besseren aktiv', () => {
    const r = rig();
    r.run(
      ...CONFIG_ROUTER,
      'configure terminal',
      'ip route 10.5.0.0 255.255.0.0 10.0.1.10',
      'ip route 10.5.0.0 255.255.0.0 10.0.2.10 200',
      'end',
    );
    const t = r.run('show ip route 10.5.1.1');
    expect(t).toContain('* 10.0.1.10');
    expect(t).not.toContain('10.0.2.10');
    r.run('configure terminal', 'interface gi0/0', 'shutdown', 'end');
    const t2 = r.run('show ip route 10.5.1.1');
    expect(t2).toContain('distance 200');
    expect(t2).toContain('* 10.0.2.10');
  });

  it('erneute Eingabe mit anderer AD ersetzt die Route, no-Form entfernt sie', () => {
    const r = rig();
    r.run(
      ...CONFIG_ROUTER,
      'configure terminal',
      'ip route 10.5.0.0 255.255.0.0 10.0.1.10 100',
      'ip route 10.5.0.0 255.255.0.0 10.0.1.10 120',
    );
    expect(r.run('end', 'show running-config')).toContain(
      'ip route 10.5.0.0 255.255.0.0 10.0.1.10 120',
    );
    expect(r.run('show running-config')).not.toContain(' 100\n');
    r.run('configure terminal', 'no ip route 10.5.0.0 255.255.0.0 10.0.1.10', 'end');
    expect(r.run('show running-config')).not.toContain('ip route 10.5.0.0');
  });
});
