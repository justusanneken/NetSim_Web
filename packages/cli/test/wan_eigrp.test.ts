import { describe, expect, it } from 'vitest';
import { sec } from './gapsLab';
import { lab } from './wanLab';

function eigrpLab() {
  const L = lab();
  for (const [r, ip] of [
    [L.r1, '10.0.0.1'],
    [L.r2, '10.0.0.2'],
  ] as const) {
    r.run(
      'enable',
      'configure terminal',
      'interface serial0/0/0',
      `ip address ${ip} 255.255.255.252`,
      'no shutdown',
      'exit',
      'router eigrp 1',
      'network 10.0.0.0 0.0.0.3',
      'no auto-summary',
      'end',
    );
  }
  L.r1.run('configure terminal', 'interface serial0/0/0', 'clock rate 64000', 'end');
  sec(L.e, 30);
  return L;
}

describe('EIGRP über Serial, Timer je Schnittstelle', () => {
  it('Nachbarschaft über Serial; ip hello-interval/hold-time eigrp verkürzen die Erkennung', () => {
    const { e, r1, r2 } = eigrpLab();
    expect(r2.run('show ip eigrp neighbors')).toContain('10.0.0.1');
    r1.run(
      'configure terminal',
      'interface serial0/0/0',
      'ip hello-interval eigrp 1 1',
      'ip hold-time eigrp 1 3',
      'end',
    );
    expect(r1.run('show running-config')).toContain(' ip hold-time eigrp 1 3');
    sec(e, 3);
    expect(r2.run('show ip eigrp neighbors')).toContain('10.0.0.1');
    // R1 stellt die Hellos ein (passive): R2 kennt Hold-Time 3 aus R1s letztem Hello und vergisst R1 nach wenigen Sekunden
    r1.run('configure terminal', 'router eigrp 1', 'passive-interface serial0/0/0', 'end');
    sec(e, 8);
    expect(r2.run('show ip eigrp neighbors')).not.toContain('10.0.0.1');
    r1.run('configure terminal', 'interface serial0/0/0', 'no ip hold-time eigrp 1 3', 'end');
    expect(r1.run('show running-config')).not.toContain('hold-time');
  });
});
