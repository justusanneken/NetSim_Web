import { describe, expect, it } from 'vitest';
import { Engine, newOspf, type OspfCfg } from '../src';
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

/** R1 –(A0)– R2 –(A1)– R3 –(A2)– R4: Area 2 hat keine Verbindung zum Backbone. */
function lab() {
  const e = new Engine({ seed: 1 });
  const [r1, r2, r3, r4] = ['R1', 'R2', 'R3', 'R4'].map((n) =>
    e.addDevice('router', { name: n }),
  ) as [string, string, string, string];
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r2, 'p1', r3, 'p0');
  rlink(e, r3, 'p1', r4, 'p0');
  rip4(e, r1, 'p0', '10.0.12.1');
  rip4(e, r2, 'p0', '10.0.12.2');
  rip4(e, r2, 'p1', '10.0.23.2');
  rip4(e, r3, 'p0', '10.0.23.3');
  rip4(e, r3, 'p1', '10.0.34.3');
  rip4(e, r4, 'p0', '10.0.34.4');
  rip4(e, r1, 'p1', '10.1.0.1');
  rip4(e, r4, 'p1', '10.4.0.1');
  const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc4 = pcOn(e, r4, 'p1', '10.4.0.10', '10.4.0.1', 'PC4');
  const mk = (id: string, nets: [string, string][]): OspfCfg => {
    const c = newOspf(1);
    c.networks = nets.map(([prefix, area]) => ({ prefix, wildcard: '0.0.0.255', area }));
    cfgOf(e, id).routing.ospf[1] = c;
    e.routingChanged(id);
    return c;
  };
  mk(r1, [
    ['10.0.12.0', '0'],
    ['10.1.0.0', '0'],
  ]);
  const o2 = mk(r2, [
    ['10.0.12.0', '0'],
    ['10.0.23.0', '1'],
  ]);
  const o3 = mk(r3, [
    ['10.0.23.0', '1'],
    ['10.0.34.0', '2'],
  ]);
  mk(r4, [
    ['10.0.34.0', '2'],
    ['10.4.0.0', '2'],
  ]);
  return { e, r: [r1, r2, r3, r4] as const, o2, o3, pc1, pc4 };
}

const rs = (e: Engine, id: string): string[] => routes(e, id).map(fmtRoute);

describe('OSPF Virtual Link', () => {
  it('ohne Virtual Link ist Area 2 vom Backbone getrennt', () => {
    const { e, r, pc1 } = lab();
    sec(e, 150);
    expect(rs(e, r[0]).some((x) => x.includes('10.4.0.0/24'))).toBe(false);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(false);
  });

  it('Virtual Link über Area 1 verbindet Area 2 mit dem Backbone', () => {
    const { e, r, o2, o3, pc1, pc4 } = lab();
    const rid2 = '10.0.23.2';
    const rid3 = '10.0.34.3';
    sec(e, 60);
    o2.vlinks = [{ area: '1', rid: rid3 }];
    o3.vlinks = [{ area: '1', rid: rid2 }];
    o2.dirty = o3.dirty = true;
    e.routingChanged(r[1]);
    e.routingChanged(r[2]);
    sec(e, 200);
    const nbrs = Object.entries(o2.ifs).filter(([id]) => id.startsWith('vl-'));
    expect(nbrs).toHaveLength(1);
    expect(Object.values(nbrs[0]?.[1].neighbors ?? {})[0]?.state).toBe('full');
    expect(rs(e, r[0]).some((x) => x.startsWith('O IA 10.4.0.0/24'))).toBe(true);
    expect(rs(e, r[3]).some((x) => x.startsWith('O IA 10.1.0.0/24'))).toBe(true);
    expect(pingOk(e, pc1, '10.4.0.10')).toBe(true);
    expect(pingOk(e, pc4, '10.1.0.10')).toBe(true);
  });
});
