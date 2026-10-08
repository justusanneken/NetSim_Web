import { describe, expect, it } from 'vitest';
import { Engine, newOspf, type OspfCfg } from '../src';
import { fmtRoute, must, pcOn, rip4, rlink, routes, sec } from './labs4';

function ospfOn(
  e: Engine,
  id: string,
  nets: [string, string][],
  pid = 1,
  wc = '0.255.255.255',
): OspfCfg {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  const c = newOspf(pid);
  c.networks = nets.map(([prefix, area]) => ({ prefix, wildcard: wc, area }));
  d.config.routing.ospf[pid] = c;
  e.routingChanged(id);
  return c;
}

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

/** Vier Router im Ring: R1–R2–R3–R4–R1, LANs an R1 (10.1.0.0/24) und R3 (10.3.0.0/24). */
function ring() {
  const e = new Engine({ seed: 1 });
  const r = ['R1', 'R2', 'R3', 'R4'].map((n) => e.addDevice('router', { name: n })) as [
    string,
    string,
    string,
    string,
  ];
  const l12 = rlink(e, r[0], 'p0', r[1], 'p0');
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
  const pc3 = pcOn(e, r[2], 'p2', '10.3.0.10', '10.3.0.1', 'PC3');
  for (const id of r) ospfOn(e, id, [['10.0.0.0', '0']]);
  return { e, r, pc1, pc3, l12 };
}

describe('OSPF', () => {
  it('Nachbarn erreichen FULL, DR/BDR werden gewählt, Routen werden gelernt', () => {
    const { e, r } = ring();
    sec(e, 100);
    const d = e.getDevice(r[0]);
    if (d?.config.kind !== 'router') throw new Error('router');
    const c = d.config.routing.ospf[1] as OspfCfg;
    for (const ifs of Object.values(c.ifs)) {
      for (const n of Object.values(ifs.neighbors)) {
        if (ifs.state === 'dr' || ifs.state === 'bdr' || n.rid === ifs.dr || n.rid === ifs.bdr)
          expect(n.state).toBe('full');
      }
    }
    // pro Segment gibt es DR und BDR (zwei Router)
    const p0 = c.ifs['p0'];
    expect(p0?.dr).not.toBe('0.0.0.0');
    expect(p0?.bdr).not.toBe('0.0.0.0');
    const rs = routes(e, r[0]).map(fmtRoute);
    expect(rs.some((x) => x.startsWith('O 10.3.0.0/24 [110/3]'))).toBe(true);
    expect(rs.some((x) => x.startsWith('O 10.0.23.0/24 [110/2]'))).toBe(true);
  });

  it('Abnahme: konvergiert im 4-Router-Ring; Linkausfall führt zum Umschalten', () => {
    const { e, r, pc1, pc3 } = ring();
    sec(e, 100);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
    // Primärpfad ermitteln und dessen ersten Link trennen
    const first = routes(e, r[0]).find((x) => x.prefix === '10.3.0.0');
    expect(first).toBeDefined();
    const viaR2 = first?.nextHop === '10.0.12.2';
    e.setPortAdmin(r[0], viaR2 ? 'p0' : 'p1', false);
    sec(e, 10);
    const second = routes(e, r[0]).find((x) => x.prefix === '10.3.0.0');
    expect(second).toBeDefined();
    expect(second?.nextHop).toBe(viaR2 ? '10.0.41.4' : '10.0.12.2');
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
  });

  it('Point-to-Point-Netze brauchen keine DR-Wahl und konvergieren schneller', () => {
    const e = new Engine({ seed: 1 });
    const a = e.addDevice('router', { name: 'A' });
    const b = e.addDevice('router', { name: 'B' });
    rlink(e, a, 'p0', b, 'p0');
    rip4(e, a, 'p0', '10.0.0.1', '255.255.255.252');
    rip4(e, b, 'p0', '10.0.0.2', '255.255.255.252');
    for (const id of [a, b]) {
      const c = ospfOn(e, id, [['10.0.0.0', '0']]);
      const d = e.getDevice(id);
      if (d?.config.kind === 'router') {
        const ic = d.config.ifaces['p0'];
        if (ic) ic.ospf = { pid: 1, area: '0', network: 'point-to-point' };
      }
      void c;
      e.routingChanged(id);
    }
    sec(e, 25);
    const d = e.getDevice(a);
    if (d?.config.kind !== 'router') throw new Error('router');
    const n = Object.values((d.config.routing.ospf[1] as OspfCfg).ifs['p0']?.neighbors ?? {});
    expect(n).toHaveLength(1);
    expect(n[0]?.state).toBe('full');
  });

  it('Multi-Area: ABR erzeugt Inter-Area-Routen (IA), Ping funktioniert', () => {
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
    const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1');
    pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1');
    ospfOn(e, r1, [['10.0.0.0', '1']]);
    ospfOn(
      e,
      r2,
      [
        ['10.0.12.0', '1'],
        ['10.0.23.0', '0'],
      ],
      1,
      '0.0.0.255',
    );
    ospfOn(e, r3, [['10.0.0.0', '0']]);
    // r1: 10.0.12.0 + 10.1.0.0 in Area 1; r3: 10.0.23.0 + 10.3.0.0 in Area 0
    sec(e, 120);
    const rs1 = routes(e, r1).map(fmtRoute);
    expect(rs1.some((x) => x.startsWith('O IA 10.3.0.0/24'))).toBe(true);
    expect(rs1.some((x) => x.startsWith('O IA 10.0.23.0/24'))).toBe(true);
    const rs3 = routes(e, r3).map(fmtRoute);
    expect(rs3.some((x) => x.startsWith('O IA 10.1.0.0/24'))).toBe(true);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
  });

  it('Redistribution: statische Route erscheint als E2 mit Metrik 20', () => {
    const { e, r, pc1 } = ring();
    sec(e, 100);
    must(
      e.addStaticRoute(r[2], {
        prefix: '192.168.100.0',
        mask: '255.255.255.0',
        nextHop: '10.3.0.10',
      }),
    );
    const d = e.getDevice(r[2]);
    if (d?.config.kind !== 'router') throw new Error('router');
    (d.config.routing.ospf[1] as OspfCfg).redistribute = [{ source: 'static', subnets: true }];
    e.routingChanged(r[2]);
    sec(e, 20);
    const rs = routes(e, r[0]).map(fmtRoute);
    expect(rs.some((x) => x.startsWith('O E2 192.168.100.0/24 [110/20]'))).toBe(true);
    void pc1;
  });
});
