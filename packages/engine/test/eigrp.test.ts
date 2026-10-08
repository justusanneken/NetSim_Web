import { describe, expect, it } from 'vitest';
import { Engine, newEigrp, type EigrpCfg } from '../src';
import { fmtRoute, pcOn, rip4, rlink, routes, sec } from './labs4';

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

function eigrpOn(e: Engine, id: string, asn = 100): EigrpCfg {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  const c = newEigrp(asn);
  c.networks = [{ prefix: '10.0.0.0', wildcard: '0.255.255.255' }];
  c.autoSummary = false;
  d.config.routing.eigrp[asn] = c;
  e.routingChanged(id);
  return c;
}

function ring() {
  const e = new Engine({ seed: 1 });
  const r = ['R1', 'R2', 'R3', 'R4'].map((n) => e.addDevice('router', { name: n })) as [
    string,
    string,
    string,
    string,
  ];
  rlink(e, r[0], 'p0', r[1], 'p0');
  rlink(e, r[1], 'p1', r[2], 'p0');
  rlink(e, r[2], 'p1', r[3], 'p0');
  rlink(e, r[3], 'p1', r[0], 'p1');
  rip4(e, r[0], 'p0', '10.0.12.1');
  rip4(e, r[1], 'p0', '10.0.12.2');
  rip4(e, r[1], 'p1', '10.0.23.2');
  rip4(e, r[2], 'p0', '10.0.23.3');
  rip4(e, r[2], 'p1', '10.0.34.3');
  rip4(e, r[3], 'p0', '10.0.34.4');
  rip4(e, r[3], 'p1', '10.0.41.4');
  rip4(e, r[0], 'p1', '10.0.41.1');
  rip4(e, r[0], 'p2', '10.1.0.1');
  rip4(e, r[2], 'p2', '10.3.0.1');
  const pc1 = pcOn(e, r[0], 'p2', '10.1.0.10', '10.1.0.1', 'PC1');
  pcOn(e, r[2], 'p2', '10.3.0.10', '10.3.0.1', 'PC3');
  for (const id of r) eigrpOn(e, id);
  return { e, r, pc1 };
}

describe('EIGRP', () => {
  it('bildet Nachbarschaften und lernt Routen mit klassischer Metrik', () => {
    const { e, r, pc1 } = ring();
    sec(e, 30);
    const rs = routes(e, r[0]).map(fmtRoute);
    // PC-Anbindung 100 Mbit/s (BW-Minimum 100000 kbit/s, Delay 10·10 µs) + zwei Gigabit-Segmente (je 1·10 µs):
    // 256·(10⁷/100000 + 10 + 1 + 1) = 28672
    expect(rs.some((x) => x.startsWith('D 10.3.0.0/24 [90/28672]'))).toBe(true);
    expect(rs.some((x) => x.startsWith('D 10.0.23.0/24 [90/3072]'))).toBe(true);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
  });

  it('Feasible Successor: Umschalten ohne Query (kein aktiver Zustand)', () => {
    const { e, r, pc1 } = ring();
    sec(e, 30);
    const primary = routes(e, r[0]).find((x) => x.prefix === '10.3.0.0');
    const viaR2 = primary?.nextHop === '10.0.12.2';
    e.log.length = 0;
    e.setPortAdmin(r[0], viaR2 ? 'p0' : 'p1', false);
    sec(e, 5);
    const next = routes(e, r[0]).find((x) => x.prefix === '10.3.0.0');
    expect(next?.nextHop).toBe(viaR2 ? '10.0.41.4' : '10.0.12.2');
    expect(
      e.log.some(
        (l) =>
          l.atDeviceName === 'R1' &&
          l.msg.key === 'eigrp.active' &&
          l.msg.params?.prefix === '10.3.0.0/24',
      ),
    ).toBe(false);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
  });

  it('ohne Feasible Successor: Query/Reply, Route verschwindet überall', () => {
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
    pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1');
    for (const id of [r1, r2, r3]) eigrpOn(e, id);
    sec(e, 30);
    expect(routes(e, r1).some((x) => x.prefix === '10.3.0.0')).toBe(true);
    e.setPortAdmin(r3, 'p1', false);
    sec(e, 10);
    expect(routes(e, r1).some((x) => x.prefix === '10.3.0.0')).toBe(false);
    expect(routes(e, r2).some((x) => x.prefix === '10.3.0.0')).toBe(false);
    expect(e.log.some((l) => l.msg.key === 'eigrp.active')).toBe(true);
    // Wiederkehr
    e.setPortAdmin(r3, 'p1', true);
    sec(e, 20);
    expect(routes(e, r1).some((x) => x.prefix === '10.3.0.0')).toBe(true);
  });

  it('Nachbar fällt aus: Hold-Timer (15 s) entfernt Nachbarschaft', () => {
    const { e, r } = ring();
    sec(e, 30);
    e.setPower(r[1], false);
    sec(e, 25);
    const d = e.getDevice(r[0]);
    if (d?.config.kind !== 'router') throw new Error('router');
    const c = d.config.routing.eigrp[100] as EigrpCfg;
    expect(Object.keys(c.neighbors)).toEqual(['10.0.41.4']);
  });
});
