import type { DeviceType, Engine } from '@netsim/engine';
import { CliSession } from '../src';

export const secs = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

/** Router oder Switch mit CLI-Sitzung (Setup-Dialog übersprungen). */
export function cli(e: Engine, name: string, type: DeviceType = 'switch-l2') {
  const id = e.addDevice(type, { name });
  const d = e.getDevice(id);
  if (d && (d.config.kind === 'switch' || d.config.kind === 'router'))
    d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  /** Führt Zeilen aus; Rückgabe mit Prompt + Eingabe + Ausgabe (wie am Terminal). */
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  /** Nur die Ausgabe der letzten Zeile. */
  const out = (...ls: string[]): string => {
    let last = '';
    for (const l of ls) last = s.input(l);
    return last;
  };
  const cfg = (...ls: string[]): string => run('enable', 'configure terminal', ...ls, 'end');
  return { id, s, run, out, cfg };
}
export type Cli = ReturnType<typeof cli>;

export function wire(e: Engine, a: Cli, ap: string, b: Cli, bp: string): void {
  const r = e.connect({ deviceId: a.id, portId: ap }, { deviceId: b.id, portId: bp }, 'crossover');
  if (!r.ok) throw new Error(r.error);
}

/** running-config -> startup-config -> reload: Ausgabe muss identisch bleiben (Render/Replay). */
export function replayEqual(e: Engine, c: Cli): string {
  c.run('enable');
  const before = c.s.input('show running-config');
  c.run('copy running-config startup-config', '');
  c.run('reload', '');
  const again = new CliSession(e, c.id);
  again.input('enable');
  const after = again.input('show running-config');
  const strip = (x: string): string => x.replace(/Current configuration.*\n/, '');
  if (strip(after) !== strip(before)) {
    throw new Error(`Replay differs:\n--- before\n${before}\n--- after\n${after}`);
  }
  return before;
}
