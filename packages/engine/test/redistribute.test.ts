import { describe, expect, it } from 'vitest';
import { Engine, newEigrp, newOspf, newRip, type OspfCfg } from '../src';
import { fmtRoute, pcOn, rip4, rlink, routes, sec } from './labs4';

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

/** PC1 – R1 –(10.0.12.0/24)– R2 –(10.0.23.0/24)– R3 – PC3 */
function lab() {
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
  rip4(e, r1, 'p1', '10.1.0.1');
  rip4(e, r3, 'p1', '10.3.0.1');
  const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc3 = pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1', 'PC3');
  return { e, r1, r2, r3, pc1, pc3 };
}

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

describe('Redistribution', () => {
  it('RIP ↔ OSPF am Grenzrouter: End-to-End-Ping', () => {
    const { e, r1, r2, r3, pc1, pc3 } = lab();
    // R1: RIP, R3: OSPF, R2: beide
    cfgOf(e, r1).routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
    const o3 = newOspf(1);
    o3.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }];
    cfgOf(e, r3).routing.ospf[1] = o3;
    const c2 = cfgOf(e, r2);
    c2.routing.rip = {
      ...newRip(),
      networks: ['10.0.0.0'],
      autoSummary: false,
      passive: ['p1'],
      redistribute: [{ source: 'ospf', id: 1, metric: 3, subnets: true }],
    };
    const o2 = newOspf(1);
    o2.networks = [{ prefix: '10.0.23.0', wildcard: '0.0.0.255', area: '0' }];
    o2.redistribute = [{ source: 'rip', metric: 10, subnets: true }];
    c2.routing.ospf[1] = o2;
    for (const id of [r1, r2, r3]) e.routingChanged(id);
    sec(e, 150);
    expect(
      routes(e, r3)
        .map(fmtRoute)
        .some((x) => x.startsWith('O E2 10.1.0.0/24 [110/10]')),
    ).toBe(true);
    const r1routes = routes(e, r1).map(fmtRoute);
    expect(r1routes.some((x) => x.startsWith('R 10.3.0.0/24 [120/4]'))).toBe(true);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
    expect(pingOk(e, pc3, '10.1.0.10')).toBe(true);
    void (null as unknown as OspfCfg);
  });

  it('EIGRP ↔ OSPF: externe Routen mit AD 170 bzw. E2', () => {
    const { e, r1, r2, r3, pc1 } = lab();
    const c1 = cfgOf(e, r1);
    const ei = newEigrp(10);
    ei.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255' }];
    ei.autoSummary = false;
    c1.routing.eigrp[10] = ei;
    const o3 = newOspf(1);
    o3.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }];
    cfgOf(e, r3).routing.ospf[1] = o3;
    const c2 = cfgOf(e, r2);
    const e2 = newEigrp(10);
    e2.networks = [{ prefix: '10.0.12.0', wildcard: '0.0.0.255' }];
    e2.autoSummary = false;
    e2.redistribute = [{ source: 'ospf', id: 1, subnets: true, bw: 100_000, delay: 10 }];
    c2.routing.eigrp[10] = e2;
    const o2 = newOspf(1);
    o2.networks = [{ prefix: '10.0.23.0', wildcard: '0.0.0.255', area: '0' }];
    o2.redistribute = [{ source: 'eigrp', id: 10, subnets: true, metric: 20 }];
    c2.routing.ospf[1] = o2;
    for (const id of [r1, r2, r3]) e.routingChanged(id);
    sec(e, 150);
    expect(
      routes(e, r1)
        .map(fmtRoute)
        .some((x) => x.startsWith('D EX 10.3.0.0/24 [170/')),
    ).toBe(true);
    expect(
      routes(e, r3)
        .map(fmtRoute)
        .some((x) => x.startsWith('O E2 10.1.0.0/24 [110/20]')),
    ).toBe(true);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
  });

  it('default-information originate (OSPF) verteilt 0.0.0.0/0', () => {
    const { e, r1, r2, r3 } = lab();
    for (const id of [r1, r2, r3]) {
      const o = newOspf(1);
      o.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }];
      cfgOf(e, id).routing.ospf[1] = o;
      e.routingChanged(id);
    }
    const o1 = cfgOf(e, r1).routing.ospf[1] as OspfCfg;
    o1.defaultOriginate = { always: true, metric: 1, metricType: 2 };
    e.routingChanged(r1);
    sec(e, 150);
    expect(
      routes(e, r3)
        .map(fmtRoute)
        .some((x) => x.startsWith('O E2 0.0.0.0/0 [110/1]')),
    ).toBe(true);
  });
});
