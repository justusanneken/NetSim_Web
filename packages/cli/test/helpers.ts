import { Engine } from '@netsim/engine';
import { CliSession } from '../src';

export interface Rig {
  e: Engine;
  r1: string;
  pc0: string;
  pc1: string;
  s: CliSession;
  /** Führt Zeilen nacheinander aus; liefert die Ausgabe (Prompt + Eingabe + Ausgabe wie am Terminal). */
  run(...lines: string[]): string;
}

export function rig(opts: { setup?: boolean } = {}): Rig {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const pc0 = e.addDevice('pc', { name: 'PC0' });
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  e.connect({ deviceId: pc0, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight');
  e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight');
  e.setHostIp(pc0, '10.0.1.10', '255.255.255.0', '10.0.1.1');
  e.setHostIp(pc1, '10.0.2.10', '255.255.255.0', '10.0.2.1');
  const s = new CliSession(e, r1);
  if (opts.setup !== true) {
    const d = e.getDevice(r1);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  }
  const run = (...lines: string[]): string => {
    let out = '';
    for (const l of lines) {
      const prompt = s.prompt();
      const o = s.input(l);
      out += `${prompt}${s.secret() ? '' : l}\n${o}`;
    }
    return out;
  };
  return { e, r1, pc0, pc1, s, run };
}

export const CONFIG_ROUTER = [
  'enable',
  'configure terminal',
  'interface gi0/0',
  'ip address 10.0.1.1 255.255.255.0',
  'no shutdown',
  'exit',
  'interface gi0/1',
  'ip address 10.0.2.1 255.255.255.0',
  'no shutdown',
  'end',
];
