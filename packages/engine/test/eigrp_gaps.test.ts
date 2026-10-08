import { describe, expect, it } from 'vitest';
import { Engine, newEigrp, type EigrpCfg } from '../src';
import { diamond, fmtRoute, pcOn, rip4, rlink, routes, sec } from './labs4';

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

const eigrpAll = (e: Engine, ids: readonly string[]): void => {
  for (const id of ids) {
    const c = newEigrp(100);
    c.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255' }];
    c.autoSummary = false;
    cfgOf(e, id).routing.eigrp[100] = c;
    e.routingChanged(id);
  }
};

describe('EIGRP: Variance (ungleiche Lastverteilung)', () => {
  it('variance 1: nur der beste Pfad; variance 4: auch der Feasible Successor', () => {
    const { e, r, pc1 } = diamond();
    // Pfad über R3 schlechter machen (kleinere Bandbreite am Ausgang von R1)
    const ic = cfgOf(e, r[0]).ifaces['p1'];
    if (!ic) throw new Error('iface');
    ic.bandwidth = 25_000;
    eigrpAll(e, r);
    sec(e, 40);
    const to4 = (): string[] =>
      routes(e, r[0])
        .filter((x) => x.prefix === '10.4.0.0')
        .map(fmtRoute);
    expect(to4()).toHaveLength(1);
    expect(to4()[0]).toContain('10.0.12.2');
    const c = cfgOf(e, r[0]).routing.eigrp[100] as EigrpCfg;
    c.variance = 4;
    e.routingChanged(r[0]);
    sec(e, 5);
    const rs = to4();
    expect(rs).toHaveLength(2);
    const m = rs.map((x) => Number(/\[90\/(\d+)\]/.exec(x)?.[1]));
    expect(m[0]).not.toBe(m[1]);
    const rib = e.routingTable(r[0]).filter((x) => x.prefix === '10.4.0.0');
    expect(rib.every((x) => x.share !== undefined)).toBe(true);
    const shares = rib.map((x) => x.share as number);
    expect(Math.max(...shares)).toBeGreaterThan(Math.min(...shares));
    // Ping funktioniert über beide Pfade
    e.ping(pc1, '10.4.0.10', { count: 3 });
    e.runAll();
    const h = e.getDevice(pc1)?.config;
    expect(h?.kind === 'host' && h.pings.every((p) => p.status === 'reply')).toBe(true);
    // zu kleine Variance entfernt den zweiten Pfad wieder
    c.variance = 2;
    e.routingChanged(r[0]);
    sec(e, 5);
    expect(to4()).toHaveLength(1);
  });
});

describe('EIGRP: Stuck-in-Active', () => {
  it('nach 3 Minuten ohne Reply wird der säumige Nachbar zurückgesetzt', () => {
    const e = new Engine({ seed: 1 });
    const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
      string,
      string,
      string,
    ];
    rlink(e, r1, 'p0', r2, 'p0');
    rlink(e, r2, 'p1', r3, 'p0');
    rip4(e, r1, 'p0', '10.0.12.1');
    rip4(e, r2, 'p0', '10.0.12.2');
    rip4(e, r2, 'p1', '10.0.23.2');
    rip4(e, r3, 'p0', '10.0.23.3');
    rip4(e, r3, 'p1', '10.3.0.1');
    pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1', 'PC3');
    eigrpAll(e, [r1, r2, r3]);
    sec(e, 40);
    expect(routes(e, r1).some((x) => x.prefix === '10.3.0.0')).toBe(true);
    // R2 ignoriert künftig Replies von R1 (simulierter Verlust)
    const c2 = cfgOf(e, r2).routing.eigrp[100] as EigrpCfg;
    const nR1 = c2.neighbors['10.0.12.1'];
    if (!nR1) throw new Error('nbr');
    nR1.seqIn = 1_000_000_000;
    e.setPortAdmin(r3, 'p1', false);
    sec(e, 20);
    const topo = c2.topology['10.3.0.0/24'];
    expect(topo?.active).toBe(true);
    sec(e, 185);
    expect(e.log.some((l) => l.msg.key === 'eigrp.sia')).toBe(true);
    expect(c2.topology['10.3.0.0/24']?.active ?? false).toBe(false);
    expect(routes(e, r2).some((x) => x.prefix === '10.3.0.0')).toBe(false);
  });
});
