import { describe, expect, it } from 'vitest';
import { Engine, newEigrp, type EigrpCfg } from '../src';
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

/** `ipv6 router eigrp 100` + `ipv6 eigrp 100` auf allen IPv6-Schnittstellen. */
function eigrp6(e: Engine, id: string, rid: string, asn = 100, noShut = true): EigrpCfg {
  const cfg = cfgOf(e, id);
  const c = newEigrp(asn, true);
  c.routerId = rid;
  if (noShut) c.shutdown = false;
  (cfg.routing.eigrp6 ??= {})[asn] = c;
  for (const ic of Object.values(cfg.ifaces)) if (ic.v6) ic.v6.eigrp = asn;
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

describe('EIGRP für IPv6', () => {
  it('Nachbarn über Link-Local, Routen D mit derselben Metrik wie IPv4-EIGRP, Ping End-to-End', () => {
    const { e, r, pc1, pc3 } = chain();
    r.forEach((id, i) => eigrp6(e, id, `1.1.1.${i + 1}`));
    sec(e, 30);
    const c1 = cfgOf(e, r[0]).routing.eigrp6?.[100];
    expect(Object.keys(c1?.neighbors ?? {})).toHaveLength(1);
    expect(Object.keys(c1?.neighbors ?? {})[0]).toMatch(/^fe80:/);
    // LAN 100 Mbit/s (Delay 10) + zwei Gigabit-Segmente (je 1) wie in eigrp.test: 28672
    expect(rt6(e, r[0], 'D')).toEqual(['2001:db8:23::/64 [90/3072]', '2001:db8:3::/64 [90/28672]']);
    expect(ping(e, pc1, '2001:db8:3::10')).toBe('reply');
    expect(ping(e, pc3, '2001:db8:1::10')).toBe('reply');
  });

  it('läuft nur mit no shutdown und Router-ID', () => {
    const { e, r } = chain();
    eigrp6(e, r[0], '1.1.1.1', 100, false);
    eigrp6(e, r[1], '1.1.1.2');
    sec(e, 30);
    expect(Object.keys(cfgOf(e, r[1]).routing.eigrp6?.[100]?.neighbors ?? {})).toHaveLength(0);
    const c = cfgOf(e, r[0]).routing.eigrp6?.[100];
    if (!c) throw new Error('c');
    c.shutdown = false;
    e.routingChanged(r[0]);
    sec(e, 30);
    expect(Object.keys(cfgOf(e, r[1]).routing.eigrp6?.[100]?.neighbors ?? {})).toHaveLength(1);
    // ohne Router-ID: keine IPv4-Adresse ⇒ Prozess bleibt inaktiv
    const d = chain();
    const c3 = eigrp6(d.e, d.r[0], '1.1.1.1');
    c3.routerId = undefined;
    d.e.routingChanged(d.r[0]);
    sec(d.e, 30);
    expect(c3.helloIfs).toEqual([]);
  });

  it('Linkausfall entfernt die Route, Rückkehr lernt sie wieder', () => {
    const { e, r } = chain();
    r.forEach((id, i) => eigrp6(e, id, `1.1.1.${i + 1}`));
    sec(e, 30);
    e.setPortAdmin(r[1], 'p1', false);
    sec(e, 30);
    expect(rt6(e, r[0], 'D').some((x) => x.startsWith('2001:db8:3::/64'))).toBe(false);
    e.setPortAdmin(r[1], 'p1', true);
    sec(e, 40);
    expect(rt6(e, r[0], 'D').some((x) => x.startsWith('2001:db8:3::/64'))).toBe(true);
  });

  it('Redistribution statischer IPv6-Routen erscheint als D EX (AD 170)', () => {
    const { e, r } = chain();
    r.forEach((id, i) => eigrp6(e, id, `1.1.1.${i + 1}`));
    must(e.addStaticRoute6(r[2], { prefix: '2001:db8:99::', plen: 64, outIfaceId: 'p1' }));
    const c = cfgOf(e, r[2]).routing.eigrp6?.[100];
    c?.redistribute.push({ source: 'static', subnets: true, bw: 10000, delay: 100 });
    e.routingChanged(r[2]);
    sec(e, 30);
    const ex = e.routingTable6(r[0]).find((x) => x.prefix.startsWith('2001:db8:99'));
    expect(ex?.type).toBe('D');
    expect(ex?.sub).toBe('EX');
    expect(ex?.ad).toBe(170);
  });

  it('IPv4-EIGRP und EIGRP für IPv6 laufen unabhängig nebeneinander', () => {
    const { e, r } = chain();
    r.forEach((id, i) => eigrp6(e, id, `1.1.1.${i + 1}`));
    sec(e, 30);
    expect(cfgOf(e, r[0]).routing.eigrp[100]).toBeUndefined();
    expect(rt6(e, r[0], 'D').length).toBeGreaterThan(0);
    expect(e.routingTable(r[0]).filter((x) => x.type === 'D')).toHaveLength(0);
  });

  it('Verlauf ist deterministisch', () => {
    const run = () => {
      const { e, r } = chain();
      r.forEach((id, i) => eigrp6(e, id, `1.1.1.${i + 1}`));
      sec(e, 30);
      return JSON.stringify(e.log.map((l) => [l.t, l.msg.key]));
    };
    expect(run()).toBe(run());
  });
});
