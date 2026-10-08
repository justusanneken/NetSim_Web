import { describe, expect, it } from 'vitest';
import type { Engine } from '@netsim/engine';
import { diamond, sec } from './gapsLab';

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 10_000_000);
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

const tables = (e: Engine): string[] =>
  Object.keys(e.state.devices).map((id) =>
    JSON.stringify(e.routingTable(id).map((r) => ({ ...r, since: 0 }))),
  );

describe('QA mutual redistribution', () => {
  function lab(tagged: boolean) {
    const L = diamond();
    const { r1, r2, r3, r4 } = L;
    r1.run('configure terminal', 'router eigrp 10', 'network 10.0.0.0', 'end');
    for (const r of [r2, r3]) {
      r.run(
        'configure terminal',
        'route-map E2O deny 10',
        'match tag 110',
        'exit',
        'route-map E2O permit 20',
        'set tag 90',
        'exit',
        'route-map O2E deny 10',
        'match tag 90',
        'exit',
        'route-map O2E permit 20',
        'set tag 110',
        'exit',
        'router eigrp 10',
        'network 10.0.12.0 0.0.0.255',
        'network 10.0.13.0 0.0.0.255',
        tagged
          ? 'redistribute ospf 1 metric 10000 100 255 1 1500 route-map O2E'
          : 'redistribute ospf 1 metric 10000 100 255 1 1500',
        'exit',
        'router ospf 1',
        'network 10.0.24.0 0.0.0.255 area 0',
        'network 10.0.34.0 0.0.0.255 area 0',
        tagged ? 'redistribute eigrp 10 subnets route-map E2O' : 'redistribute eigrp 10 subnets',
        'end',
      );
    }
    r4.run('configure terminal', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end');
    return L;
  }

  it('tag-filtered mutual redistribution converges, stays stable, pings work', () => {
    const { e, r1, r2, r4, pc1, pc4 } = lab(true);
    sec(e, 120);
    const a = tables(e);
    sec(e, 120);
    expect(tables(e)).toEqual(a);
    expect(r1.run('show ip route')).toMatch(/D EX\s+10\.4\.0\.0\/24/);
    expect(r4.run('show ip route')).toMatch(/O E2\s+10\.1\.0\.0\/24/);
    expect(r2.run('show ip route')).toMatch(/D\s+10\.1\.0\.0\/24/);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
    expect(pingOk(e, pc4, '10.1.0.10')).toBe(true);
  });

  it('untagged mutual redistribution does not crash or run unbounded', () => {
    const { e } = lab(false);
    sec(e, 300);
    expect(e.state.queue.length).toBeLessThan(500);
  });
});

describe('QA ECMP', () => {
  it('load-shares per flow and fails over on link shut', () => {
    const { e, r1, r2, r3, r4, pc1 } = diamond();
    for (const r of [r1, r2, r3, r4])
      r.run('configure terminal', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end');
    sec(e, 100);
    const ctr = (id: string, port: string): number =>
      e.getDevice(id)?.ports.find((p) => p.id === port)?.counters.inPkts ?? 0;
    const b2 = ctr(r2.id, 'p0');
    const b3 = ctr(r3.id, 'p0');
    for (let i = 20; i < 40; i++) {
      e.ping(pc1, `10.4.0.${i}`, { count: 1 });
      e.runUntil(e.state.now + 3_000_000);
    }
    const d2 = ctr(r2.id, 'p0') - b2;
    const d3 = ctr(r3.id, 'p0') - b3;
    expect(d2).toBeGreaterThan(3);
    expect(d3).toBeGreaterThan(3);
    r1.run('configure terminal', 'interface gi0/0', 'shutdown', 'end');
    sec(e, 2);
    for (let i = 0; i < 6; i++) expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
    r1.run('configure terminal', 'interface gi0/0', 'no shutdown', 'end');
    sec(e, 60);
    expect(e.routingTable(r1.id).filter((x) => x.prefix === '10.4.0.0')).toHaveLength(2);
  });
});
