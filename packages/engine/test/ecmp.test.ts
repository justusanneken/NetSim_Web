import { describe, expect, it } from 'vitest';
import { Engine, newEigrp, newOspf, newRip, lookupRibPaths, pickPath, type RibEntry } from '../src';
import { fmtRoute, must, pcOn, rip4, rlink, routes, sec } from './labs4';

/** R1 – (R2 | R3) – R4: zwei gleichwertige Pfade; LANs 10.1.0.0/24 (R1) und 10.4.0.0/24 (R4). */
export function diamond() {
  const e = new Engine({ seed: 1 });
  const [r1, r2, r3, r4] = ['R1', 'R2', 'R3', 'R4'].map((n) =>
    e.addDevice('router', { name: n }),
  ) as [string, string, string, string];
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r1, 'p1', r3, 'p0');
  rlink(e, r2, 'p1', r4, 'p0');
  rlink(e, r3, 'p1', r4, 'p1');
  rip4(e, r1, 'p0', '10.0.12.1');
  rip4(e, r2, 'p0', '10.0.12.2');
  rip4(e, r1, 'p1', '10.0.13.1');
  rip4(e, r3, 'p0', '10.0.13.3');
  rip4(e, r2, 'p1', '10.0.24.2');
  rip4(e, r4, 'p0', '10.0.24.4');
  rip4(e, r3, 'p1', '10.0.34.3');
  rip4(e, r4, 'p1', '10.0.34.4');
  rip4(e, r1, 'p2', '10.1.0.1');
  rip4(e, r4, 'p2', '10.4.0.1');
  const pc1 = pcOn(e, r1, 'p2', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc4 = pcOn(e, r4, 'p2', '10.4.0.10', '10.4.0.1', 'PC4');
  return { e, r: [r1, r2, r3, r4] as const, pc1, pc4 };
}

const l3 = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

const toLan4 = (e: Engine, id: string) =>
  routes(e, id)
    .filter((r) => r.prefix === '10.4.0.0')
    .map(fmtRoute)
    .sort();

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

describe('ECMP', () => {
  it('OSPF: zwei gleichwertige Pfade, maximum-paths begrenzt', () => {
    const { e, r, pc1 } = diamond();
    for (const id of r) {
      const c = newOspf(1);
      c.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }];
      l3(e, id).routing.ospf[1] = c;
      e.routingChanged(id);
    }
    sec(e, 100);
    expect(toLan4(e, r[0])).toEqual([
      'O 10.4.0.0/24 [110/3] 10.0.12.2',
      'O 10.4.0.0/24 [110/3] 10.0.13.3',
    ]);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
    const c1 = l3(e, r[0]).routing.ospf[1];
    if (!c1) throw new Error('ospf');
    c1.maxPaths = 1;
    c1.dirty = true;
    e.routingChanged(r[0]);
    sec(e, 5);
    expect(toLan4(e, r[0])).toHaveLength(1);
  });

  it('EIGRP: Successors mit gleicher Distanz werden beide installiert', () => {
    const { e, r, pc1 } = diamond();
    for (const id of r) {
      const c = newEigrp(100);
      c.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255' }];
      c.autoSummary = false;
      l3(e, id).routing.eigrp[100] = c;
      e.routingChanged(id);
    }
    sec(e, 40);
    expect(toLan4(e, r[0]).map((x) => x.split(' ')[3])).toEqual(['10.0.12.2', '10.0.13.3']);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
  });

  it('RIP: gleiche Metrik über zwei Nachbarn ergibt zwei Pfade', () => {
    const { e, r, pc1 } = diamond();
    for (const id of r) {
      l3(e, id).routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
      e.routingChanged(id);
    }
    sec(e, 100);
    expect(toLan4(e, r[0])).toEqual([
      'R 10.4.0.0/24 [120/2] 10.0.12.2',
      'R 10.4.0.0/24 [120/2] 10.0.13.3',
    ]);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
  });

  it('statische Routen mit gleicher AD bilden ECMP', () => {
    const { e, r, pc1 } = diamond();
    const st = (id: string, net: string, nh: string): void =>
      must(e.addStaticRoute(id, { prefix: net, mask: '255.255.255.0', nextHop: nh }));
    st(r[0], '10.4.0.0', '10.0.12.2');
    st(r[0], '10.4.0.0', '10.0.13.3');
    st(r[1], '10.4.0.0', '10.0.24.4');
    st(r[2], '10.4.0.0', '10.0.34.4');
    st(r[3], '10.1.0.0', '10.0.24.2');
    st(r[1], '10.1.0.0', '10.0.12.1');
    st(r[2], '10.1.0.0', '10.0.13.1');
    const rib = e.routingTable(r[0]).filter((x) => x.prefix === '10.4.0.0');
    expect(rib).toHaveLength(2);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
  });

  it('Pro-Flow-Hash ist deterministisch und verteilt auf beide Pfade', () => {
    const mk = (nh: string): RibEntry => ({
      type: 'O',
      prefix: '10.4.0.0',
      plen: 24,
      ad: 110,
      metric: 3,
      nextHop: nh,
      ifaceId: 'p0',
    });
    const rib = [mk('10.0.12.2'), mk('10.0.13.3')];
    const paths = lookupRibPaths(rib, '10.4.0.10');
    expect(paths).toHaveLength(2);
    const seen = new Set<string>();
    for (let i = 1; i < 40; i++) {
      const a = pickPath(paths, `10.1.0.${i}`, '10.4.0.10');
      expect(pickPath(paths, `10.1.0.${i}`, '10.4.0.10')).toBe(a);
      seen.add(a.nextHop as string);
    }
    expect(seen.size).toBe(2);
  });
});
