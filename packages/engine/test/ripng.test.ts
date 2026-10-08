import { describe, expect, it } from 'vitest';
import { Engine, newOspf, newRipng, type RipngCfg } from '../src';
import { must, rlink, sec } from './labs4';

/** PC1 – R1 – R2 – R3 – PC3; IPv6 auf allen Strecken. */
function chain() {
  const e = new Engine({ seed: 1 });
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
    string,
    string,
    string,
  ];
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc3 = e.addDevice('pc', { name: 'PC3' });
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r2, 'p1', r3, 'p0');
  must(e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'crossover'));
  must(e.connect({ deviceId: pc3, portId: 'p0' }, { deviceId: r3, portId: 'p1' }, 'crossover'));
  e.setPortAdmin(r1, 'p1', true);
  e.setPortAdmin(r3, 'p1', true);
  for (const id of [r1, r2, r3]) must(e.setIpv6Routing(id, true));
  for (const [id, port, addr] of [
    [r1, 'p0', '2001:db8:12::1'],
    [r2, 'p0', '2001:db8:12::2'],
    [r2, 'p1', '2001:db8:23::2'],
    [r3, 'p0', '2001:db8:23::3'],
    [r1, 'p1', '2001:db8:1::1'],
    [r3, 'p1', '2001:db8:3::1'],
  ] as const)
    must(e.setInterfaceIp6(id, port, addr, 64));
  must(e.setHostIpv6(pc1, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' }));
  must(e.setHostIpv6(pc3, { addr: '2001:db8:3::10', plen: 64, gateway: '2001:db8:3::1' }));
  return { e, r: [r1, r2, r3] as const, pc1, pc3 };
}

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

function ripng(e: Engine, id: string): RipngCfg {
  const c = newRipng('LAB');
  (cfgOf(e, id).routing.ripng ??= {})['LAB'] = c;
  for (const ic of Object.values(cfgOf(e, id).ifaces)) if (ic.v6) ic.v6.ripng = 'LAB';
  e.routingChanged(id);
  return c;
}

const rt6 = (e: Engine, id: string, type: string) =>
  e
    .routingTable6(id)
    .filter((x) => x.type === type)
    .map((x) => `${x.prefix}/${x.plen} [${x.ad}/${x.metric}]`)
    .sort();

const ping = (e: Engine, from: string, dst: string): string | undefined => {
  e.ping(from, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(from)?.config;
  return cfg?.kind === 'host' ? cfg.pings.at(-1)?.status : undefined;
};

describe('RIPng', () => {
  it('lernt IPv6-Präfixe über Link-Local-Nachbarn und routet End-to-End', () => {
    const { e, r, pc1, pc3 } = chain();
    for (const id of r) ripng(e, id);
    sec(e, 100);
    expect(rt6(e, r[0], 'R')).toEqual(['2001:db8:23::/64 [120/1]', '2001:db8:3::/64 [120/2]']);
    expect(ping(e, pc1, '2001:db8:3::10')).toBe('reply');
    expect(ping(e, pc3, '2001:db8:1::10')).toBe('reply');
  });

  it('Linkausfall: Routen werden entwertet und nach Rückkehr wieder gelernt', () => {
    const { e, r } = chain();
    for (const id of r) ripng(e, id);
    sec(e, 100);
    e.setPortAdmin(r[1], 'p1', false);
    sec(e, 20);
    expect(rt6(e, r[0], 'R').some((x) => x.startsWith('2001:db8:3::/64'))).toBe(false);
    e.setPortAdmin(r[1], 'p1', true);
    sec(e, 100);
    expect(rt6(e, r[0], 'R').some((x) => x.startsWith('2001:db8:3::/64'))).toBe(true);
  });

  it('redistribute: ohne Metrik unendlich, mit Metrik und Route-Map übernommen; distribute-list out', () => {
    const { e, r } = chain();
    const c1 = ripng(e, r[0]);
    ripng(e, r[1]);
    // Interface zum PC nicht in RIPng: das Netz kommt nur per Redistribution (connected)
    const lan = cfgOf(e, r[0]).ifaces['p1'];
    if (lan?.v6) lan.v6.ripng = undefined;
    e.routingChanged(r[0]);
    c1.redistribute = [{ source: 'connected', subnets: true }];
    e.routingChanged(r[0]);
    sec(e, 80);
    expect(rt6(e, r[1], 'R').some((x) => x.startsWith('2001:db8:1::/64'))).toBe(false);
    c1.redistribute = [{ source: 'connected', subnets: true, metric: 3 }];
    e.routingChanged(r[0]);
    sec(e, 80);
    expect(rt6(e, r[1], 'R')).toContain('2001:db8:1::/64 [120/4]');
    // Ausgangsfilter
    cfgOf(e, r[0]).routing.prefixLists6['NOLAN'] = {
      name: 'NOLAN',
      entries: [
        { seq: 5, action: 'deny', prefix: '2001:db8:1::', plen: 64 },
        { seq: 10, action: 'permit', prefix: '::', plen: 0, le: 128 },
      ],
    };
    c1.distributeLists = [{ kind: 'prefix-list', name: 'NOLAN', dir: 'out' }];
    e.routingChanged(r[0]);
    sec(e, 400);
    expect(rt6(e, r[1], 'R').some((x) => x.startsWith('2001:db8:1::/64'))).toBe(false);
  });
});

describe('OSPFv3 Redistribution', () => {
  it('connected/static werden als externe Routen (E2) in OSPFv3 eingespeist', () => {
    const { e, r, pc1 } = chain();
    for (const [id, rid] of [
      [r[0], '1.1.1.1'],
      [r[1], '2.2.2.2'],
      [r[2], '3.3.3.3'],
    ] as const) {
      const c = newOspf(1, true);
      c.routerId = rid;
      cfgOf(e, id).routing.ospf6[1] = c;
      for (const [pid, ic] of Object.entries(cfgOf(e, id).ifaces)) {
        // PC-Netz an R1 bleibt außerhalb von OSPFv3 (nur Redistribution)
        if (ic.v6 && !(id === r[0] && pid === 'p1')) ic.v6.ospf = { pid: 1, area: '0' };
      }
      e.routingChanged(id);
    }
    const o1 = cfgOf(e, r[0]).routing.ospf6[1];
    if (!o1) throw new Error('ospf6');
    must(e.addStaticRoute6(r[0], { prefix: '2001:db8:99::', plen: 64, outIfaceId: 'p1' }));
    o1.redistribute = [
      { source: 'connected', subnets: true, metric: 5 },
      { source: 'static', subnets: true, metric: 7, metricType: 1 },
    ];
    e.routingChanged(r[0]);
    sec(e, 150);
    const tbl = e
      .routingTable6(r[2])
      .filter((x) => x.type === 'O' && x.sub?.startsWith('E'))
      .map((x) => `${x.prefix}/${x.plen} ${x.sub} ${x.metric}`)
      .sort();
    expect(tbl).toContain('2001:db8:1::/64 E2 5');
    expect(tbl.some((x) => x.startsWith('2001:db8:99::/64 E1'))).toBe(true);
    expect(ping(e, pc1, '2001:db8:23::3')).toBe('reply');
    // Redistribution entfernen zieht die Routen zurück
    o1.redistribute = [];
    e.routingChanged(r[0]);
    sec(e, 100);
    expect(e.routingTable6(r[2]).some((x) => x.type === 'O' && x.sub?.startsWith('E'))).toBe(false);
  });
});
