import { expect } from 'vitest';
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

/** running-config speichern, neu laden und prüfen, dass das Replay identisch rendert. */
export function roundTrip(e: Engine, r: R): string {
  const before = r.s.input('show running-config');
  r.run('copy running-config startup-config', '');
  r.run('reload', '');
  r.s.input('enable');
  const again = new CliSession(e, r.id);
  again.input('enable');
  const after = again.input('show running-config');
  const strip = (x: string): string => x.replace(/Current configuration.*\n/, '');
  expect(strip(after)).toBe(strip(before));
  return before;
}
