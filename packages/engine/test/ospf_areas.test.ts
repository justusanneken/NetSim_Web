import { describe, expect, it } from 'vitest';
import { Engine, newOspf, type OspfAreaCfg, type OspfCfg } from '../src';
import { fmtRoute, pcOn, rip4, rlink, routes, sec } from './labs4';

const cfgOf = (e: Engine, id: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config;
};

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

/**
 * R1 (Area 0, ASBR mit statischer Route 172.16.0.0/16) – R2 (ABR) – R3 (Area 1)
 * LANs: PC1 10.1.0.0/24 (R1), PC3 10.3.0.0/24 (R3); R3 p2: 10.9.0.0/24 mit PC9.
 */
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
  rip4(e, r1, 'p2', '172.16.5.1');
  rip4(e, r3, 'p2', '10.9.0.1');
  const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc3 = pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1', 'PC3');
  pcOn(e, r1, 'p2', '172.16.5.10', '172.16.5.1', 'PC16');
  pcOn(e, r3, 'p2', '10.9.0.10', '10.9.0.1', 'PC9');
  cfgOf(e, r1).staticRoutes.push({
    prefix: '172.16.0.0',
    mask: '255.255.0.0',
    outIfaceId: 'p2',
    ad: 1,
  });
  const o1 = proc(e, r1, [
    ['10.0.12.0', '0'],
    ['10.1.0.0', '0'],
  ]);
  o1.redistribute = [{ source: 'static', subnets: true }];
  proc(e, r2, [
    ['10.0.12.0', '0'],
    ['10.0.23.0', '1'],
  ]);
  proc(e, r3, [
    ['10.0.23.0', '1'],
    ['10.3.0.0', '1'],
    ['10.9.0.0', '1'],
  ]);
  return { e, r1, r2, r3, pc1, pc3 };
}

function proc(e: Engine, id: string, nets: [string, string][]): OspfCfg {
  const c = newOspf(1);
  c.networks = nets.map(([prefix, area]) => ({ prefix, wildcard: '0.0.0.255', area }));
  cfgOf(e, id).routing.ospf[1] = c;
  e.routingChanged(id);
  return c;
}

const setArea = (e: Engine, ids: string[], a: Partial<OspfAreaCfg> & { id: string }): void => {
  for (const id of ids) {
    const c = cfgOf(e, id).routing.ospf[1] as OspfCfg;
    c.areas ??= {};
    c.areas[a.id] = { type: 'normal', noSummary: false, ...a };
    c.dirty = true;
    e.routingChanged(id);
  }
};

const rs = (e: Engine, id: string): string[] => routes(e, id).map(fmtRoute);

describe('OSPF-Bereichstypen', () => {
  it('Normal: externe Route (E2) und Summaries erreichen R3', () => {
    const { e, r3 } = lab();
    sec(e, 120);
    expect(rs(e, r3).some((x) => x.startsWith('O E2 172.16.0.0/16'))).toBe(true);
    expect(rs(e, r3).some((x) => x.startsWith('O IA 10.1.0.0/24'))).toBe(true);
  });

  it('Stub: keine Externen, ABR speist Default ein, Ping über Default funktioniert', () => {
    const { e, r1, r2, r3, pc3 } = lab();
    setArea(e, [r2, r3], { id: '1', type: 'stub' });
    sec(e, 150);
    const t = rs(e, r3);
    expect(t.some((x) => x.includes('172.16.0.0/16'))).toBe(false);
    expect(t.some((x) => x.startsWith('O IA 0.0.0.0/0 [110/2] 10.0.23.2'))).toBe(true);
    expect(t.some((x) => x.startsWith('O IA 10.1.0.0/24'))).toBe(true);
    expect(rs(e, r2).some((x) => x.startsWith('O E2 172.16.0.0/16'))).toBe(true);
    expect(pingOk(e, pc3, '10.1.0.10')).toBe(true);
    void r1;
  });

  it('Totally Stubby: nur noch die Default-Route (keine Inter-Area-Summaries)', () => {
    const { e, r2, r3, pc3 } = lab();
    setArea(e, [r2], { id: '1', type: 'stub', noSummary: true });
    setArea(e, [r3], { id: '1', type: 'stub' });
    sec(e, 150);
    const t = rs(e, r3);
    expect(t.some((x) => x.startsWith('O IA 0.0.0.0/0'))).toBe(true);
    expect(t.some((x) => x.startsWith('O IA 10.1.0.0/24'))).toBe(false);
    expect(t.some((x) => x.startsWith('O IA 10.0.12.0/24'))).toBe(false);
    expect(pingOk(e, pc3, '10.1.0.10')).toBe(true);
  });

  it('Stub-Flag-Mismatch verhindert die Nachbarschaft', () => {
    const { e, r2, r3 } = lab();
    setArea(e, [r2], { id: '1', type: 'stub' });
    sec(e, 100);
    const c3 = cfgOf(e, r3).routing.ospf[1] as OspfCfg;
    expect(Object.values(c3.ifs['p0']?.neighbors ?? {}).some((n) => n.state === 'full')).toBe(
      false,
    );
    expect(e.log.some((l) => l.msg.key === 'ospf.mismatch')).toBe(true);
  });

  it('NSSA: Typ 7 im Bereich (N2), Übersetzung am ABR zu E2 im Backbone', () => {
    const { e, r1, r2, r3, pc1 } = lab();
    setArea(e, [r2, r3], { id: '1', type: 'nssa' });
    const o3 = cfgOf(e, r3).routing.ospf[1] as OspfCfg;
    cfgOf(e, r3).staticRoutes.push({
      prefix: '192.168.99.0',
      mask: '255.255.255.0',
      outIfaceId: 'p2',
      ad: 1,
    });
    o3.redistribute = [{ source: 'static', subnets: true, metric: 30 }];
    // 172.16/16 (Typ 5 aus Area 0) darf nicht in die NSSA gelangen
    e.routingChanged(r3);
    sec(e, 200);
    expect(rs(e, r2).some((x) => x.startsWith('O N2 192.168.99.0/24 [110/30]'))).toBe(true);
    expect(rs(e, r1).some((x) => x.startsWith('O E2 192.168.99.0/24 [110/30]'))).toBe(true);
    expect(rs(e, r3).some((x) => x.includes('172.16.0.0/16'))).toBe(false);
    expect(pingOk(e, pc1, '10.3.0.10')).toBe(true);
    // Entfernen der Redistribution zieht die Übersetzung zurück
    o3.redistribute = [];
    e.routingChanged(r3);
    sec(e, 100);
    expect(rs(e, r1).some((x) => x.includes('192.168.99.0/24'))).toBe(false);
  });

  it('NSSA no-summary erzeugt Default per Typ 3', () => {
    const { e, r2, r3 } = lab();
    setArea(e, [r2], { id: '1', type: 'nssa', noSummary: true });
    setArea(e, [r3], { id: '1', type: 'nssa' });
    sec(e, 150);
    expect(rs(e, r3).some((x) => x.startsWith('O IA 0.0.0.0/0'))).toBe(true);
    expect(rs(e, r3).some((x) => x.startsWith('O IA 10.1.0.0/24'))).toBe(false);
  });
});

describe('OSPF-Authentifizierung', () => {
  const ifOspf = (e: Engine, id: string, port: string, o: Record<string, unknown>): void => {
    const ic = cfgOf(e, id).ifaces[port];
    if (!ic) throw new Error('iface');
    ic.ospf = { pid: 1, area: '0', ...ic.ospf, ...o };
    cfgOf(e, id).routing.ospf[1]!.dirty = true;
    e.routingChanged(id);
  };

  it('Klartext: gleicher Schlüssel → FULL; falscher Schlüssel → Hellos werden verworfen', () => {
    const { e, r1, r2 } = lab();
    for (const [id, port] of [
      [r1, 'p0'],
      [r2, 'p0'],
    ] as const)
      ifOspf(e, id, port, { auth: 'simple', authKey: 'geheim' });
    sec(e, 100);
    const c1 = cfgOf(e, r1).routing.ospf[1] as OspfCfg;
    expect(Object.values(c1.ifs['p0']?.neighbors ?? {})[0]?.state).toBe('full');
    expect(e.log.some((l) => l.msg.key === 'ospf.authFail')).toBe(false);
    ifOspf(e, r2, 'p0', { authKey: 'falsch' });
    sec(e, 100);
    expect(Object.keys(c1.ifs['p0']?.neighbors ?? {})).toHaveLength(0);
    expect(e.log.some((l) => l.msg.key === 'ospf.authFail')).toBe(true);
  });

  it('MD5 über area-Authentifizierung und Schlüssel-ID', () => {
    const { e, r1, r2 } = lab();
    setArea(e, [r1, r2], { id: '0', type: 'normal', auth: 'md5' });
    ifOspf(e, r1, 'p0', { md5Keys: { 1: 'abc' } });
    ifOspf(e, r2, 'p0', { md5Keys: { 1: 'abc' } });
    sec(e, 100);
    const c1 = cfgOf(e, r1).routing.ospf[1] as OspfCfg;
    expect(Object.values(c1.ifs['p0']?.neighbors ?? {})[0]?.state).toBe('full');
    ifOspf(e, r2, 'p0', { md5Keys: { 2: 'abc' } });
    sec(e, 100);
    expect(Object.keys(c1.ifs['p0']?.neighbors ?? {})).toHaveLength(0);
  });

  it('einseitige Authentifizierung scheitert', () => {
    const { e, r1 } = lab();
    ifOspf(e, r1, 'p0', { auth: 'simple', authKey: 'x' });
    sec(e, 100);
    const c1 = cfgOf(e, r1).routing.ospf[1] as OspfCfg;
    expect(Object.keys(c1.ifs['p0']?.neighbors ?? {})).toHaveLength(0);
  });
});
