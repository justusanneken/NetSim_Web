import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession } from '../src';

export const sec = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

export function router(e: Engine, name: string) {
  const id = e.addDevice('router', { name });
  const d = e.getDevice(id);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  return { id, s, run };
}
export type R = ReturnType<typeof router>;

export function link(e: Engine, a: string, ap: string, b: string, bp: string): void {
  const r = e.connect({ deviceId: a, portId: ap }, { deviceId: b, portId: bp }, 'crossover');
  if (!r.ok) throw new Error(r.error);
}

/** Konfiguriert Schnittstellen (`gi0/0` …) und schaltet sie ein. */
export function ifcfg(r: R, rows: [string, string][], mask = '255.255.255.0'): void {
  r.run(
    'enable',
    'configure terminal',
    ...rows.flatMap(([i, ip]) => [
      `interface ${i}`,
      `ip address ${ip} ${mask}`,
      'no shutdown',
      'exit',
    ]),
    'end',
  );
}

/** R1 – (R2 | R3) – R4: LAN 10.1.0.0/24 an R1, 10.4.0.0/24 an R4. */
export function diamond() {
  const e = new Engine({ seed: 1 });
  const r1 = router(e, 'R1');
  const r2 = router(e, 'R2');
  const r3 = router(e, 'R3');
  const r4 = router(e, 'R4');
  link(e, r1.id, 'p0', r2.id, 'p0');
  link(e, r1.id, 'p1', r3.id, 'p0');
  link(e, r2.id, 'p1', r4.id, 'p0');
  link(e, r3.id, 'p1', r4.id, 'p1');
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc4 = e.addDevice('pc', { name: 'PC4' });
  link(e, pc1, 'p0', r1.id, 'p2');
  link(e, pc4, 'p0', r4.id, 'p2');
  e.setHostIp(pc1, '10.1.0.10', '255.255.255.0', '10.1.0.1');
  e.setHostIp(pc4, '10.4.0.10', '255.255.255.0', '10.4.0.1');
  ifcfg(r1, [
    ['gi0/0', '10.0.12.1'],
    ['gi0/1', '10.0.13.1'],
    ['gi0/2', '10.1.0.1'],
  ]);
  ifcfg(r2, [
    ['gi0/0', '10.0.12.2'],
    ['gi0/1', '10.0.24.2'],
  ]);
  ifcfg(r3, [
    ['gi0/0', '10.0.13.3'],
    ['gi0/1', '10.0.34.3'],
  ]);
  ifcfg(r4, [
    ['gi0/0', '10.0.24.4'],
    ['gi0/1', '10.0.34.4'],
    ['gi0/2', '10.4.0.1'],
  ]);
  return { e, r1, r2, r3, r4, pc1, pc4 };
}

describe('Lücken: ECMP im CLI', () => {
  it('OSPF maximum-paths; show ip route zeigt mehrere via-Zeilen; show ip route <net> mit zwei Blöcken', () => {
    const { e, r1, r2, r3, r4 } = diamond();
    for (const r of [r1, r2, r3, r4])
      r.run('configure terminal', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end');
    sec(e, 100);
    const rt = r1.run('show ip route');
    expect(rt).toMatch(
      /O\s+10\.4\.0\.0\/24 \[110\/3\] via 10\.0\.12\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/0\n\s+\[110\/3\] via 10\.0\.13\.3, \d\d:\d\d:\d\d, GigabitEthernet0\/1/,
    );
    const one = r1.run('show ip route 10.4.0.0');
    expect(one).toContain('traffic share count is 1');
    expect(one.match(/Route metric is 3/g)).toHaveLength(2);
    r1.run('configure terminal', 'router ospf 1', 'maximum-paths 1', 'end');
    sec(e, 5);
    expect(r1.run('show ip route')).not.toMatch(/\n\s+\[110\/3\] via 10\.0\.13\.3/);
    const cfg = r1.run('show running-config');
    expect(cfg).toContain(' maximum-paths 1');
    r1.run('configure terminal', 'router ospf 1', 'no maximum-paths', 'end');
    expect(r1.run('show running-config')).not.toContain(' maximum-paths');
  });
});
