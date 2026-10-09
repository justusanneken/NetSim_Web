import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { ifcfg, link, router, sec } from './gapsLab';

/** R1 – R2 – R3 in Reihe. */
function chain() {
  const e = new Engine({ seed: 1 });
  const r1 = router(e, 'R1');
  const r2 = router(e, 'R2');
  const r3 = router(e, 'R3');
  link(e, r1.id, 'p0', r2.id, 'p0');
  link(e, r2.id, 'p1', r3.id, 'p0');
  ifcfg(r1, [['gi0/0', '10.0.12.1']]);
  ifcfg(r2, [
    ['gi0/0', '10.0.12.2'],
    ['gi0/1', '10.0.23.2'],
  ]);
  ifcfg(r3, [['gi0/0', '10.0.23.3']]);
  return { e, r1, r2, r3 };
}

const status = (r: ReturnType<typeof router>): string => r.s.input('show ntp status');

describe('QA2: NTP-Hierarchie, Schleifen und Verlust', () => {
  it('gegenseitige ntp server mit ntp master: Stratum bleibt stabil (keine Zählschleife)', () => {
    const { e, r1, r2 } = chain();
    r1.run('configure terminal', 'ntp master 3', 'ntp server 10.0.12.2', 'end');
    r2.run('configure terminal', 'ntp server 10.0.12.1', 'end');
    sec(e, 1200);
    expect(status(r2)).toContain('stratum 4');
    // R1 bleibt die maßgebliche Quelle (eigene Uhr, Stratum 3), statt sich an R2 zu hängen
    expect(status(r1)).toContain('stratum 3');
  });

  it('zwei Router ohne Referenz, die sich gegenseitig abfragen, bleiben unsynchronisiert', () => {
    const { e, r1, r2 } = chain();
    r1.run('configure terminal', 'ntp server 10.0.12.2', 'end');
    r2.run('configure terminal', 'ntp server 10.0.12.1', 'end');
    sec(e, 600);
    expect(status(r1)).toContain('unsynchronized');
    expect(status(r2)).toContain('unsynchronized');
  });

  it('Verlust der Quelle pflanzt sich fort: R2 und danach R3 werden unsynchronisiert', () => {
    const { e, r1, r2, r3 } = chain();
    r1.run('configure terminal', 'ntp master 2', 'end');
    r2.run('configure terminal', 'ntp server 10.0.12.1', 'end');
    r3.run('configure terminal', 'ntp server 10.0.23.2', 'end');
    sec(e, 300);
    expect(status(r2)).toContain('stratum 3');
    expect(status(r3)).toContain('stratum 4');
    r1.run('configure terminal', 'interface gi0/0', 'shutdown', 'end');
    sec(e, 64 * 6);
    expect(status(r2)).toContain('unsynchronized');
    sec(e, 64 * 6);
    expect(status(r3)).toContain('unsynchronized');
    r1.run('configure terminal', 'interface gi0/0', 'no shutdown', 'end');
    sec(e, 300);
    expect(status(r3)).toContain('stratum 4');
  });
});
