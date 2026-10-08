import { describe, expect, it } from 'vitest';
import { Engine, newRip } from '../src';
import { fmtRoute, pcOn, rip4, rlink, routes, sec } from './labs4';

/** PC1 – R1 – R2 – R3 – PC3, alle Strecken /24 */
function chain() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const r3 = e.addDevice('router', { name: 'R3' });
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r2, 'p1', r3, 'p0');
  rip4(e, r1, 'p0', '10.0.12.1');
  rip4(e, r2, 'p0', '10.0.12.2');
  rip4(e, r2, 'p1', '10.0.23.2');
  rip4(e, r3, 'p0', '10.0.23.3');
  rip4(e, r1, 'p1', '10.1.0.1');
  rip4(e, r3, 'p1', '10.3.0.1');
  const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc3 = pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1', 'PC3');
  for (const id of [r1, r2, r3]) {
    const d = e.getDevice(id);
    if (d?.config.kind !== 'router') throw new Error('router');
    d.config.routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
    e.routingChanged(id);
  }
  return { e, r1, r2, r3, pc1, pc3 };
}

describe('RIPv2', () => {
  it('lernt Routen über zwei Hops (Metrik 2) und routet Pings', () => {
    const { e, r1, r3, pc1 } = chain();
    sec(e, 70);
    const rs = routes(e, r1).map(fmtRoute);
    expect(rs).toContain('R 10.3.0.0/24 [120/2] 10.0.12.2');
    expect(rs).toContain('R 10.0.23.0/24 [120/1] 10.0.12.2');
    expect(routes(e, r3).map(fmtRoute)).toContain('R 10.1.0.0/24 [120/2] 10.0.23.2');
    const pr = e.ping(pc1, '10.3.0.10', { count: 1 });
    expect(pr.ok).toBe(true);
    e.runAll();
    const cfg = e.getDevice(pc1)?.config;
    expect(cfg?.kind === 'host' && cfg.pings.at(-1)?.status).toBe('reply');
  });

  it('Auto-Summary fasst Subnetze an klassengrenzen zusammen', () => {
    const e = new Engine({ seed: 1 });
    const r1 = e.addDevice('router', { name: 'R1' });
    const r2 = e.addDevice('router', { name: 'R2' });
    rlink(e, r1, 'p0', r2, 'p0');
    rip4(e, r1, 'p0', '192.168.12.1');
    rip4(e, r2, 'p0', '192.168.12.2');
    rip4(e, r1, 'p1', '10.1.1.1');
    rip4(e, r1, 'p2', '10.1.2.1');
    pcOn(e, r1, 'p1', '10.1.1.10', '10.1.1.1');
    pcOn(e, r1, 'p2', '10.1.2.10', '10.1.2.1');
    for (const id of [r1, r2]) {
      const d = e.getDevice(id);
      if (d?.config.kind !== 'router') throw new Error('router');
      d.config.routing.rip = { ...newRip(), networks: ['192.168.12.0', '10.0.0.0'] };
      e.routingChanged(id);
    }
    sec(e, 40);
    expect(routes(e, r2).map(fmtRoute)).toEqual(['R 10.0.0.0/8 [120/1] 192.168.12.1']);
  });

  it('Linkausfall: Route wird sofort entwertet, Rückkehr stellt sie wieder her', () => {
    const { e, r1, r2 } = chain();
    sec(e, 70);
    expect(routes(e, r1).some((r) => r.prefix === '10.3.0.0')).toBe(true);
    e.setPortAdmin(r2, 'p1', false);
    sec(e, 10);
    expect(routes(e, r1).some((r) => r.prefix === '10.3.0.0')).toBe(false);
    e.setPortAdmin(r2, 'p1', true);
    sec(e, 70);
    expect(routes(e, r1).some((r) => r.prefix === '10.3.0.0')).toBe(true);
  });

  it('Gerät fällt aus: Nachbar entwertet Routen per Link-Down und Triggered Update', () => {
    const { e, r1, r3 } = chain();
    sec(e, 70);
    e.setPower(r3, false);
    sec(e, 60);
    expect(routes(e, r1).some((r) => r.prefix === '10.3.0.0')).toBe(false);
  });
});
