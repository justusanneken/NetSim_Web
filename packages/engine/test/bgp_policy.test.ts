import { describe, expect, it } from 'vitest';
import {
  Engine,
  newBgp,
  newBgpNbr,
  newRouteMapClause,
  type BgpCfg,
  type BgpNbrCfg,
  type RouteMapSet,
} from '../src';
import { fmtRoute, must, pcOn, rip4, rlink, routes, sec } from './labs4';

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

function bgp(
  e: Engine,
  id: string,
  asn: number,
  nbrs: (Partial<BgpNbrCfg> & { ip: string; asn: number })[],
  nets: string[] = [],
): BgpCfg {
  const c = newBgp(asn);
  for (const n of nbrs) c.neighbors[n.ip] = { ...newBgpNbr(n.ip, n.asn), ...n };
  c.networks = nets.map((x) => {
    const [prefix, plen] = x.split('/') as [string, string];
    return { prefix, plen: Number(plen) };
  });
  cfgOf(e, id).routing.bgp = c;
  e.routingChanged(id);
  return c;
}

const rmap = (
  e: Engine,
  id: string,
  name: string,
  set: RouteMapSet,
  match?: (c: ReturnType<typeof newRouteMapClause>) => void,
): void => {
  const cl = newRouteMapClause(10, 'permit');
  cl.set = set;
  match?.(cl);
  const rm = (cfgOf(e, id).routing.routeMaps[name] ??= { name, clauses: [] });
  rm.clauses.push(cl);
};

/** R2 (AS200) und R3 (AS300) hängen an R1 (AS100); beide kündigen 10.9.0.0/24 an. R2 zusätzlich 10.22.0.0/24. */
function triple() {
  const e = new Engine({ seed: 1 });
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
    string,
    string,
    string,
  ];
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r1, 'p1', r3, 'p0');
  rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
  rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
  rip4(e, r1, 'p1', '192.168.13.1', '255.255.255.252');
  rip4(e, r3, 'p0', '192.168.13.2', '255.255.255.252');
  rip4(e, r2, 'p1', '10.9.0.1');
  rip4(e, r2, 'p2', '10.22.0.1');
  rip4(e, r3, 'p1', '10.9.0.1');
  pcOn(e, r2, 'p1', '10.9.0.10', '10.9.0.1', 'PC9a');
  pcOn(e, r2, 'p2', '10.22.0.10', '10.22.0.1', 'PC22');
  pcOn(e, r3, 'p1', '10.9.0.11', '10.9.0.1', 'PC9b');
  return { e, r1, r2, r3 };
}

const best = (e: Engine, r1: string, key = '10.9.0.0/24'): BgpCfg['locRib'][string] | undefined =>
  cfgOf(e, r1).routing.bgp?.locRib[key];

describe('BGP-Policies', () => {
  it('Prefix-List in und out filtern Präfixe', () => {
    const { e, r1, r2, r3 } = triple();
    cfgOf(e, r1).routing.prefixLists['ONLY22'] = {
      name: 'ONLY22',
      entries: [{ seq: 5, action: 'permit', prefix: '10.22.0.0', plen: 24 }],
    };
    cfgOf(e, r2).routing.prefixLists['NO9'] = {
      name: 'NO9',
      entries: [
        { seq: 5, action: 'deny', prefix: '10.9.0.0', plen: 24 },
        { seq: 10, action: 'permit', prefix: '0.0.0.0', plen: 0, le: 32 },
      ],
    };
    bgp(e, r1, 100, [
      { ip: '192.168.12.2', asn: 200, prefixListIn: 'ONLY22' },
      { ip: '192.168.13.2', asn: 300 },
    ]);
    bgp(
      e,
      r2,
      200,
      [{ ip: '192.168.12.1', asn: 100, prefixListOut: 'NO9' }],
      ['10.9.0.0/24', '10.22.0.0/24'],
    );
    bgp(e, r3, 300, [{ ip: '192.168.13.1', asn: 100 }]);
    sec(e, 40);
    expect(routes(e, r1).some((r) => r.prefix === '10.22.0.0')).toBe(true);
    expect(routes(e, r1).some((r) => r.prefix === '10.9.0.0')).toBe(false);
    // Out-Filter alleine: R1 nimmt alles, R2 unterdrückt 10.9/24
    cfgOf(e, r1).routing.bgp!.neighbors['192.168.12.2']!.prefixListIn = undefined;
    e.routingChanged(r1);
    sec(e, 10);
    expect(routes(e, r1).some((r) => r.prefix === '10.9.0.0')).toBe(false);
    expect(routes(e, r1).some((r) => r.prefix === '10.22.0.0')).toBe(true);
  });

  it('Route-Map in: local-preference und weight beeinflussen die Bestpath-Wahl', () => {
    const { e, r1, r2, r3 } = triple();
    bgp(e, r1, 100, [
      { ip: '192.168.12.2', asn: 200 },
      { ip: '192.168.13.2', asn: 300, routeMapIn: 'LP' },
    ]);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }], ['10.9.0.0/24']);
    bgp(e, r3, 300, [{ ip: '192.168.13.1', asn: 100 }], ['10.9.0.0/24']);
    sec(e, 40);
    // ohne Policy gewinnt die niedrigere Router-ID (R2: 192.168.12.2 ... kleinerer fromRid)
    expect(best(e, r1)?.from).toBe('192.168.12.2');
    rmap(e, r1, 'LP', { localPref: 200 });
    e.routingChanged(r1);
    sec(e, 10);
    expect(best(e, r1)?.from).toBe('192.168.13.2');
    expect(best(e, r1)?.attrs.localPref).toBe(200);
    // weight schlägt local-preference
    rmap(e, r1, 'W', { weight: 500 });
    cfgOf(e, r1).routing.bgp!.neighbors['192.168.12.2']!.routeMapIn = 'W';
    e.routingChanged(r1);
    sec(e, 10);
    expect(best(e, r1)?.from).toBe('192.168.12.2');
    expect(best(e, r1)?.weight).toBe(500);
  });

  it('Route-Map in: as-path prepend verlängert den Pfad, Route-Map out: metric/prepend/Match per Prefix-List', () => {
    const { e, r1, r2, r3 } = triple();
    bgp(e, r1, 100, [
      { ip: '192.168.12.2', asn: 200, routeMapIn: 'PRE' },
      { ip: '192.168.13.2', asn: 300 },
    ]);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }], ['10.9.0.0/24']);
    bgp(e, r3, 300, [{ ip: '192.168.13.1', asn: 100, routeMapOut: 'OUT' }], ['10.9.0.0/24']);
    rmap(e, r1, 'PRE', { asPathPrepend: [65000, 65000] });
    cfgOf(e, r3).routing.prefixLists['P9'] = {
      name: 'P9',
      entries: [{ seq: 5, action: 'permit', prefix: '10.9.0.0', plen: 24 }],
    };
    rmap(e, r3, 'OUT', { metric: 77 }, (c) => (c.matchPrefixLists = ['P9']));
    sec(e, 40);
    // Pfad via R2 ist wegen Prepend länger → R3 gewinnt
    const b = best(e, r1);
    expect(b?.from).toBe('192.168.13.2');
    expect(b?.attrs.asPath).toEqual([300]);
    expect(b?.attrs.med).toBe(77);
    const viaR2 = cfgOf(e, r1).routing.bgp!.neighbors['192.168.12.2']!.ribIn['10.9.0.0/24'];
    expect(viaR2?.attrs.asPath).toEqual([200]);
  });

  it('Communities: ohne send-community entfernt, mit send-community übertragen; no-export stoppt an der AS-Grenze', () => {
    const { e, r1, r2, r3 } = triple();
    bgp(e, r1, 100, [
      { ip: '192.168.12.2', asn: 200 },
      { ip: '192.168.13.2', asn: 300, sendCommunity: true },
    ]);
    bgp(
      e,
      r2,
      200,
      [{ ip: '192.168.12.1', asn: 100, routeMapOut: 'COM', sendCommunity: false }],
      ['10.22.0.0/24'],
    );
    rmap(e, r2, 'COM', { community: { values: ['65000:7', 'no-export'], additive: true } });
    bgp(e, r3, 300, [{ ip: '192.168.13.1', asn: 100 }]);
    sec(e, 40);
    // R2 sendet ohne send-community: R1 sieht keine Community
    expect(best(e, r1, '10.22.0.0/24')?.attrs.communities).toBeUndefined();
    cfgOf(e, r2).routing.bgp!.neighbors['192.168.12.1']!.sendCommunity = true;
    e.routingChanged(r2);
    sec(e, 10);
    expect(best(e, r1, '10.22.0.0/24')?.attrs.communities).toEqual(['65000:7', 'no-export']);
    // no-export: R1 gibt die Route nicht an R3 (anderes AS) weiter
    expect(routes(e, r3).some((r) => r.prefix === '10.22.0.0')).toBe(false);
    // set community none auf R1 eingehend entfernt die Marke → Weitergabe an R3
    rmap(e, r1, 'CLR', { community: { values: [], additive: false, none: true } });
    cfgOf(e, r1).routing.bgp!.neighbors['192.168.12.2']!.routeMapIn = 'CLR';
    e.routingChanged(r1);
    sec(e, 10);
    expect(routes(e, r3).some((r) => r.prefix === '10.22.0.0')).toBe(true);
  });

  it('Route-Map-Match auf Community (community-list)', () => {
    const { e, r1, r2, r3 } = triple();
    cfgOf(e, r1).routing.communityLists['C7'] = {
      name: 'C7',
      entries: [{ action: 'permit', values: ['65000:7'] }],
    };
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200, routeMapIn: 'M' }]);
    const cl = newRouteMapClause(10, 'permit');
    cl.matchCommunities = ['C7'];
    cl.set = { localPref: 300 };
    cfgOf(e, r1).routing.routeMaps['M'] = {
      name: 'M',
      clauses: [cl, newRouteMapClause(20, 'deny')],
    };
    rmap(e, r2, 'TAG', { community: { values: ['65000:7'], additive: false } });
    bgp(
      e,
      r2,
      200,
      [{ ip: '192.168.12.1', asn: 100, routeMapOut: 'TAG', sendCommunity: true }],
      ['10.22.0.0/24'],
    );
    bgp(e, r3, 300, []);
    sec(e, 40);
    expect(best(e, r1, '10.22.0.0/24')?.attrs.localPref).toBe(300);
  });
});

describe('BGP Route Reflector', () => {
  function line() {
    const e = new Engine({ seed: 1 });
    const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
      string,
      string,
      string,
    ];
    rlink(e, r1, 'p0', r2, 'p0');
    rlink(e, r2, 'p1', r3, 'p0');
    rip4(e, r1, 'p0', '10.0.12.1', '255.255.255.252');
    rip4(e, r2, 'p0', '10.0.12.2', '255.255.255.252');
    rip4(e, r2, 'p1', '10.0.23.2', '255.255.255.252');
    rip4(e, r3, 'p0', '10.0.23.1', '255.255.255.252');
    rip4(e, r1, 'p1', '10.1.0.1');
    pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
    must(
      e.addStaticRoute(r3, { prefix: '10.0.12.0', mask: '255.255.255.252', nextHop: '10.0.23.2' }),
    );
    return { e, r1, r2, r3 };
  }

  it('ohne Reflector werden iBGP-Routen nicht weitergegeben; mit route-reflector-client schon', () => {
    const { e, r1, r2, r3 } = line();
    bgp(e, r1, 100, [{ ip: '10.0.12.2', asn: 100 }], ['10.1.0.0/24']);
    const c2 = bgp(e, r2, 100, [
      { ip: '10.0.12.1', asn: 100 },
      { ip: '10.0.23.1', asn: 100 },
    ]);
    bgp(e, r3, 100, [{ ip: '10.0.23.2', asn: 100 }]);
    sec(e, 40);
    expect(routes(e, r2).some((r) => r.prefix === '10.1.0.0')).toBe(true);
    expect(routes(e, r3).some((r) => r.prefix === '10.1.0.0')).toBe(false);
    c2.neighbors['10.0.12.1']!.rrClient = true;
    e.routingChanged(r2);
    sec(e, 10);
    const b = cfgOf(e, r3).routing.bgp?.locRib['10.1.0.0/24'];
    expect(b).toBeDefined();
    expect(b?.attrs.originatorId).toBe('10.1.0.1');
    expect(b?.attrs.clusterList).toEqual([c2.rid ?? c2.routerId]);
    expect(routes(e, r3).map(fmtRoute)).toContain('B 10.1.0.0/24 [200/0] 10.0.23.2');
  });

  it('Schleifenschutz: eigene Router-ID/Cluster-ID in Originator/Cluster-List verwirft die Route', () => {
    const { e, r1, r2, r3 } = line();
    bgp(e, r1, 100, [{ ip: '10.0.12.2', asn: 100 }], ['10.1.0.0/24']);
    const c2 = bgp(e, r2, 100, [
      { ip: '10.0.12.1', asn: 100, rrClient: true },
      { ip: '10.0.23.1', asn: 100, rrClient: true },
    ]);
    c2.clusterId = '9.9.9.9';
    const c3 = bgp(e, r3, 100, [{ ip: '10.0.23.2', asn: 100 }]);
    c3.clusterId = '9.9.9.9'; // gleiche Cluster-ID ⇒ Route wird als Schleife verworfen
    sec(e, 40);
    expect(cfgOf(e, r3).routing.bgp?.locRib['10.1.0.0/24']).toBeUndefined();
  });
});

describe('BGP IPv6-Adressfamilie', () => {
  it('network X::/L wird per MP-BGP an den eBGP-Nachbarn weitergegeben und installiert', () => {
    const e = new Engine({ seed: 1 });
    const r1 = e.addDevice('router', { name: 'R1' });
    const r2 = e.addDevice('router', { name: 'R2' });
    rlink(e, r1, 'p0', r2, 'p0');
    rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
    rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
    pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
    rip4(e, r1, 'p1', '10.1.0.1');
    for (const id of [r1, r2]) must(e.setIpv6Routing(id, true));
    must(e.setInterfaceIp6(r1, 'p0', '2001:db8:12::1', 64));
    must(e.setInterfaceIp6(r2, 'p0', '2001:db8:12::2', 64));
    must(e.setInterfaceIp6(r1, 'p1', '2001:db8:1::1', 64));
    const c1 = bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200, activate6: true }]);
    c1.networks6 = [{ prefix: '2001:db8:1::', plen: 64 }];
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100, activate6: true }]);
    e.routingChanged(r1);
    sec(e, 40);
    const rt6 = e.routingTable6(r2).filter((x) => x.type === 'B');
    expect(rt6.map((x) => `${x.prefix}/${x.plen} via ${x.nextHop}`)).toEqual([
      '2001:db8:1::/64 via 2001:db8:12::1',
    ]);
    // Ping vom R2 zur IPv6-Adresse hinter R1
    e.ping(r2, '2001:db8:1::1', { count: 1 });
    e.runAll();
    const p = cfgOf(e, r2).pings.at(-1);
    expect(p?.status).toBe('reply');
    // Rückzug bei Entfernen des network-Statements
    c1.networks6 = [];
    e.routingChanged(r1);
    sec(e, 10);
    expect(e.routingTable6(r2).some((x) => x.type === 'B')).toBe(false);
  });
});
