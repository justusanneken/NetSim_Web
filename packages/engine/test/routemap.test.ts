import { describe, expect, it } from 'vitest';
import {
  Engine,
  evalRouteMap,
  newEigrp,
  newOspf,
  newRip,
  newRouteMapClause,
  newRouting,
  prefixListPermits,
  type Acl,
} from '../src';
import { fmtRoute, pcOn, rip4, rlink, routes, sec } from './labs4';

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

/** R1 –(10.0.12.0/24)– R2 –(10.0.23.0/24)– R3; LANs 10.1.0.0/24 und 10.5.0.0/24 an R1, 10.3.0.0/24 an R3. */
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
  rip4(e, r1, 'p2', '10.5.0.1');
  rip4(e, r3, 'p1', '10.3.0.1');
  pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  pcOn(e, r1, 'p2', '10.5.0.10', '10.5.0.1', 'PC5');
  pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1', 'PC3');
  return { e, r1, r2, r3 };
}

const std = (name: string, ...rows: ['permit' | 'deny', string, string][]): Acl => ({
  name,
  type: 'standard',
  entries: rows.map(([action, ip, wildcard], i) => ({
    seq: (i + 1) * 10,
    action,
    proto: 'ip' as const,
    src: { ip, wildcard },
    matches: 0,
  })),
});

describe('Prefix-Lists und Route-Maps', () => {
  it('Prefix-List: exakt, ge/le, implizites deny', () => {
    const pl = {
      name: 'P',
      entries: [
        { seq: 5, action: 'deny' as const, prefix: '10.9.0.0', plen: 16, le: 32 },
        { seq: 10, action: 'permit' as const, prefix: '10.0.0.0', plen: 8, ge: 24, le: 26 },
        { seq: 20, action: 'permit' as const, prefix: '192.168.1.0', plen: 24 },
      ],
    };
    const r = (prefix: string, plen: number) => prefixListPermits(pl, { prefix, plen });
    expect(r('10.1.2.0', 24)).toBe(true);
    expect(r('10.1.2.0', 26)).toBe(true);
    expect(r('10.1.2.0', 27)).toBe(false);
    expect(r('10.1.0.0', 16)).toBe(false);
    expect(r('10.9.1.0', 24)).toBe(false); // deny davor
    expect(r('192.168.1.0', 24)).toBe(true);
    expect(r('192.168.1.0', 25)).toBe(false);
    expect(r('172.16.0.0', 24)).toBe(false);
  });

  it('Route-Map: match prefix-list/ACL/Tag, set, deny-Klausel, implizites deny', () => {
    const routing = newRouting();
    routing.prefixLists['A'] = {
      name: 'A',
      entries: [{ seq: 10, action: 'permit', prefix: '10.1.0.0', plen: 24 }],
    };
    const c10 = newRouteMapClause(10, 'permit');
    c10.matchPrefixLists = ['A'];
    c10.set = { metric: 50, tag: 7 };
    const c20 = newRouteMapClause(20, 'deny');
    c20.matchAcls = ['9'];
    const c30 = newRouteMapClause(30, 'permit');
    c30.matchTags = [3];
    routing.routeMaps['RM'] = { name: 'RM', clauses: [c20, c10, c30] };
    const env = { routing, acls: { '9': std('9', ['permit', '10.5.0.0', '0.0.0.255']) } };
    expect(evalRouteMap(env, 'RM', { prefix: '10.1.0.0', plen: 24 })).toEqual({
      permit: true,
      set: { metric: 50, tag: 7 },
    });
    expect(evalRouteMap(env, 'RM', { prefix: '10.5.0.0', plen: 24 }).permit).toBe(false);
    expect(evalRouteMap(env, 'RM', { prefix: '10.8.0.0', plen: 24, tag: 3 }).permit).toBe(true);
    expect(evalRouteMap(env, 'RM', { prefix: '10.8.0.0', plen: 24 }).permit).toBe(false);
    // unbekannte Route-Map: alles erlaubt
    expect(evalRouteMap(env, 'NOPE', { prefix: '1.0.0.0', plen: 8 }).permit).toBe(true);
  });

  it('redistribute … route-map filtert und setzt Metrik/Typ (RIP → OSPF)', () => {
    const { e, r1, r2, r3 } = lab();
    cfgOf(e, r1).routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
    const c2 = cfgOf(e, r2);
    c2.routing.rip = {
      ...newRip(),
      networks: ['10.0.0.0'],
      autoSummary: false,
      passive: ['p1'],
    };
    const o2 = newOspf(1);
    o2.networks = [{ prefix: '10.0.23.0', wildcard: '0.0.0.255', area: '0' }];
    c2.routing.ospf[1] = o2;
    c2.routing.prefixLists['LAN1'] = {
      name: 'LAN1',
      entries: [{ seq: 10, action: 'permit', prefix: '10.1.0.0', plen: 24 }],
    };
    const cl = newRouteMapClause(10, 'permit');
    cl.matchPrefixLists = ['LAN1'];
    cl.set = { metric: 77, metricType: 1, tag: 9 };
    c2.routing.routeMaps['R2O'] = { name: 'R2O', clauses: [cl] };
    o2.redistribute = [{ source: 'rip', subnets: true, routeMap: 'R2O' }];
    const o3 = newOspf(1);
    o3.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' }];
    cfgOf(e, r3).routing.ospf[1] = o3;
    for (const id of [r1, r2, r3]) e.routingChanged(id);
    sec(e, 150);
    const rs = routes(e, r3).map(fmtRoute);
    expect(rs.some((x) => x.startsWith('O E1 10.1.0.0/24 [110/'))).toBe(true);
    expect(rs.some((x) => x.includes('10.5.0.0/24'))).toBe(false);
    // E1: Gesamtkosten = 77 + Kosten bis zum ASBR (R2: 1)
    expect(rs.find((x) => x.includes('10.1.0.0/24'))).toContain('[110/78]');
  });

  it('RIP: redistribute ohne Metrik = unendlich (IOS), mit default-metric wird übernommen', () => {
    const { e, r1, r2, r3 } = lab();
    const c1 = cfgOf(e, r1);
    c1.routing.rip = { ...newRip(), networks: ['10.0.12.0'], autoSummary: false };
    c1.routing.rip.redistribute = [{ source: 'static', subnets: true }];
    c1.staticRoutes.push({
      prefix: '192.168.50.0',
      mask: '255.255.255.0',
      outIfaceId: 'p2',
      ad: 1,
    });
    const c2 = cfgOf(e, r2);
    c2.routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
    for (const id of [r1, r2, r3]) e.routingChanged(id);
    sec(e, 100);
    expect(routes(e, r2).some((x) => x.prefix === '192.168.50.0')).toBe(false);
    const rip1 = cfgOf(e, r1).routing.rip;
    if (!rip1) throw new Error('rip');
    rip1.defaultMetric = 2;
    e.routingChanged(r1);
    sec(e, 100);
    expect(routes(e, r2).map(fmtRoute)).toContain('R 192.168.50.0/24 [120/3] 10.0.12.1');
  });

  it('RIP: distribute-list in/out mit ACL und Prefix-List', () => {
    const { e, r1, r2, r3 } = lab();
    for (const id of [r1, r2, r3]) {
      cfgOf(e, id).routing.rip = { ...newRip(), networks: ['10.0.0.0'], autoSummary: false };
      e.routingChanged(id);
    }
    sec(e, 100);
    expect(routes(e, r3).some((x) => x.prefix === '10.5.0.0')).toBe(true);
    const c2 = cfgOf(e, r2);
    c2.acls['5'] = std(
      '5',
      ['deny', '10.5.0.0', '0.0.0.255'],
      ['permit', '0.0.0.0', '255.255.255.255'],
    );
    const rip2 = c2.routing.rip;
    if (!rip2) throw new Error('rip');
    rip2.distributeLists = [{ kind: 'acl', name: '5', dir: 'in' }];
    e.routingChanged(r2);
    sec(e, 400);
    expect(routes(e, r2).some((x) => x.prefix === '10.5.0.0')).toBe(false);
    expect(routes(e, r2).some((x) => x.prefix === '10.1.0.0')).toBe(true);
    // out: R2 gibt 10.1.0.0 nicht an R3 weiter
    c2.routing.prefixLists['NO1'] = {
      name: 'NO1',
      entries: [
        { seq: 5, action: 'deny', prefix: '10.1.0.0', plen: 24 },
        { seq: 10, action: 'permit', prefix: '0.0.0.0', plen: 0, le: 32 },
      ],
    };
    rip2.distributeLists = [{ kind: 'prefix-list', name: 'NO1', dir: 'out', ifaceId: 'p1' }];
    e.routingChanged(r2);
    sec(e, 400);
    expect(routes(e, r3).some((x) => x.prefix === '10.1.0.0')).toBe(false);
    expect(routes(e, r3).some((x) => x.prefix === '10.0.12.0')).toBe(true);
  });

  it('EIGRP: distribute-list out unterdrückt ein Präfix; Aufheben stellt es wieder her', () => {
    const { e, r1, r2, r3 } = lab();
    for (const id of [r1, r2, r3]) {
      const c = newEigrp(100);
      c.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255' }];
      c.autoSummary = false;
      cfgOf(e, id).routing.eigrp[100] = c;
      e.routingChanged(id);
    }
    sec(e, 40);
    expect(routes(e, r3).some((x) => x.prefix === '10.5.0.0')).toBe(true);
    const c2 = cfgOf(e, r2);
    c2.acls['7'] = std(
      '7',
      ['deny', '10.5.0.0', '0.0.0.255'],
      ['permit', '0.0.0.0', '255.255.255.255'],
    );
    const eg = c2.routing.eigrp[100];
    if (!eg) throw new Error('eigrp');
    eg.distributeLists = [{ kind: 'acl', name: '7', dir: 'out' }];
    e.routingChanged(r2);
    sec(e, 20);
    expect(routes(e, r3).some((x) => x.prefix === '10.5.0.0')).toBe(false);
    expect(routes(e, r3).some((x) => x.prefix === '10.1.0.0')).toBe(true);
    eg.distributeLists = [];
    e.routingChanged(r2);
    sec(e, 20);
    expect(routes(e, r3).some((x) => x.prefix === '10.5.0.0')).toBe(true);
    // in: R3 filtert 10.1.0.0 ein
    const c3 = cfgOf(e, r3);
    c3.acls['8'] = std(
      '8',
      ['deny', '10.1.0.0', '0.0.0.255'],
      ['permit', '0.0.0.0', '255.255.255.255'],
    );
    const e3 = c3.routing.eigrp[100];
    if (!e3) throw new Error('eigrp');
    e3.distributeLists = [{ kind: 'acl', name: '8', dir: 'in' }];
    e.routingChanged(r3);
    sec(e, 20);
    expect(routes(e, r3).some((x) => x.prefix === '10.1.0.0')).toBe(false);
  });
});
