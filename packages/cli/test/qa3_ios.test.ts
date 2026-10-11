import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, secs } from './ccnaLab';
import { lab as serialLab } from './wanLab';

/** QA3: IOS-Treue neuer Anzeigen. */

describe('QA3: show controllers serial', () => {
  it('nimmt `serial0/0/0` und `s0/0/0` wie IOS an; Abbruchzähler zählt keine guten Pakete', () => {
    const { e, r1, r2 } = serialLab();
    for (const [r, ip] of [
      [r1, '10.0.0.1'],
      [r2, '10.0.0.2'],
    ] as const)
      r.run(
        'enable',
        'configure terminal',
        'interface serial0/0/0',
        `ip address ${ip} 255.255.255.252`,
        ...(r === r1 ? ['clock rate 64000'] : []),
        'no shutdown',
        'end',
      );
    secs(e, 15);
    r1.run('ping 10.0.0.2');
    for (const c of [
      'show controllers serial 0/0/0',
      'show controllers serial0/0/0',
      'show controllers s0/0/0',
    ]) {
      const out = r1.s.input(c);
      expect(out, c).toContain('DCE V.35, clock rate 64000');
      expect(out, c).toContain('\n0 input aborts on receiving flag sequence');
    }
    expect(r1.s.input('show controllers gi0/0')).toContain('% Invalid interface');
  });
});

describe('QA3: show policy-map interface', () => {
  function lab() {
    const e = new Engine({ seed: 1 });
    const r1 = cli(e, 'R1', 'router');
    const a = e.addDevice('pc', { name: 'A' });
    const b = e.addDevice('pc', { name: 'B' });
    e.connect({ deviceId: a, portId: 'p0' }, { deviceId: r1.id, portId: 'p0' }, 'crossover');
    e.connect({ deviceId: b, portId: 'p0' }, { deviceId: r1.id, portId: 'p1' }, 'crossover');
    e.setHostIp(a, '10.0.1.10', '255.255.255.0', '10.0.1.1');
    e.setHostIp(b, '10.0.2.10', '255.255.255.0', '10.0.2.1');
    return { e, r1, a, b };
  }

  it('class-default ist implizit vorhanden, steht zuletzt und zählt nicht passende Pakete', () => {
    const { e, r1, a } = lab();
    r1.cfg(
      'class-map match-all WEB',
      'match protocol http',
      'exit',
      'policy-map P',
      // class-default zuerst eingegeben: IOS wertet sie trotzdem zuletzt aus
      'class class-default',
      'set dscp af11',
      'exit',
      'class WEB',
      'set dscp af21',
      'exit',
      'exit',
      'interface gi0/0',
      'ip address 10.0.1.1 255.255.255.0',
      'service-policy input P',
      'no shutdown',
      'interface gi0/1',
      'ip address 10.0.2.1 255.255.255.0',
      'no shutdown',
    );
    e.ping(a, '10.0.2.10', { count: 2 });
    e.runAll();
    const out = r1.out('enable', 'show policy-map interface gi0/0');
    const web = out.indexOf('Class-map: WEB');
    const dflt = out.indexOf('Class-map: class-default');
    expect(web).toBeGreaterThan(0);
    expect(dflt).toBeGreaterThan(web);
    expect(out).toContain('Match: protocol http');
    expect(out.slice(dflt)).toMatch(/class-default \(match-any\)\n\s+2 packets/);
    expect(r1.out('show running-config')).toMatch(
      /policy-map P\n class WEB\n {2}set dscp af21\n class class-default\n {2}set dscp af11/,
    );
  });

  it('ohne konfigurierte class-default erscheint sie trotzdem mit Zählern', () => {
    const { e, r1, a } = lab();
    r1.cfg(
      'class-map match-all WEB',
      'match protocol http',
      'exit',
      'policy-map P',
      'class WEB',
      'set dscp af21',
      'exit',
      'exit',
      'interface gi0/0',
      'ip address 10.0.1.1 255.255.255.0',
      'service-policy input P',
      'no shutdown',
      'interface gi0/1',
      'ip address 10.0.2.1 255.255.255.0',
      'no shutdown',
    );
    e.ping(a, '10.0.2.10', { count: 3 });
    e.runAll();
    const out = r1.out('enable', 'show policy-map interface');
    expect(out).toMatch(/Class-map: class-default \(match-any\)\n\s+3 packets, \d+ bytes/);
    expect(out).toContain('      Match: any');
  });
});
