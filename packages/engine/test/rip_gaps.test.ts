import { describe, expect, it } from 'vitest';
import { Engine, newRip } from '../src';
import { pcOn, rip4, rlink, routes, sec } from './labs4';

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

/** Dreieck R1–R2–R3; LAN 10.2.0.0/24 an R2. */
function triangle() {
  const e = new Engine({ seed: 1 });
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
    string,
    string,
    string,
  ];
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r1, 'p1', r3, 'p0');
  rlink(e, r3, 'p1', r2, 'p1');
  rip4(e, r1, 'p0', '10.0.12.1');
  rip4(e, r2, 'p0', '10.0.12.2');
  rip4(e, r1, 'p1', '10.0.13.1');
  rip4(e, r3, 'p0', '10.0.13.3');
  rip4(e, r3, 'p1', '10.0.32.3');
  rip4(e, r2, 'p1', '10.0.32.2');
  rip4(e, r2, 'p2', '10.2.0.1');
  pcOn(e, r2, 'p2', '10.2.0.10', '10.2.0.1', 'PC2');
  for (const id of [r1, r2, r3]) {
    cfgOf(e, id).routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
    e.routingChanged(id);
  }
  return { e, r1, r2, r3 };
}

describe('RIP: Holddown', () => {
  it('nach Ausfall der Route gilt Holddown; gleich gute Meldungen anderer Nachbarn werden ignoriert', () => {
    const { e, r1, r2, r3 } = triangle();
    sec(e, 100);
    const rip1 = cfgOf(e, r1).routing.rip;
    if (!rip1) throw new Error('rip');
    expect(routes(e, r1).filter((x) => x.prefix === '10.2.0.0').length).toBeGreaterThanOrEqual(1);
    const before = rip1.routes['10.2.0.0/24'];
    expect(before?.metric).toBe(1);
    e.setPortAdmin(r2, 'p2', false);
    sec(e, 5);
    expect(rip1.held?.['10.2.0.0/24']?.via).toBe('10.0.12.2');
    expect(routes(e, r1).some((x) => x.prefix === '10.2.0.0')).toBe(false);
    // R3 „weiß“ künftig fälschlich von einer Route mit Metrik 1 → R1 meldet Metrik 2 ≥ 1: ignorieren
    const rip3 = cfgOf(e, r3).routing.rip;
    if (!rip3) throw new Error('rip');
    rip3.routes['10.2.0.0/24'] = {
      prefix: '10.2.0.0',
      plen: 24,
      metric: 1,
      nextHop: '10.0.32.2',
      ifaceId: 'p1',
      updatedAt: e.state.now,
      changed: true,
      origin: 'rip',
      tag: 0,
    };
    sec(e, 40);
    expect(routes(e, r1).some((x) => x.prefix === '10.2.0.0')).toBe(false);
    // nach Ablauf (180 s) wird eine Meldung wieder akzeptiert (R3 hält die Route mangels Update bis zum Timeout)
    e.setPortAdmin(r2, 'p2', true);
    sec(e, 240);
    expect(routes(e, r1).some((x) => x.prefix === '10.2.0.0')).toBe(true);
  });

  it('der ursprüngliche Nachbar darf das Ziel mit gleicher Metrik wieder anbieten', () => {
    const { e, r1, r2 } = triangle();
    sec(e, 100);
    e.setPortAdmin(r2, 'p2', false);
    sec(e, 5);
    e.setPortAdmin(r2, 'p2', true);
    sec(e, 40);
    expect(routes(e, r1).some((x) => x.prefix === '10.2.0.0')).toBe(true);
  });
});
