import { Engine } from '@netsim/engine';
import { CliSession } from '../src';

export function wanRouter(e: Engine, name: string) {
  const id = e.addDevice('router', { name });
  e.setPower(id, false);
  if (!e.p5.insertModule(id, 0, 'HWIC-2T').ok) throw new Error('module');
  e.setPower(id, true);
  const d = e.getDevice(id);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  return { id, s, run };
}

export function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = wanRouter(e, 'R1');
  const r2 = wanRouter(e, 'R2');
  const a = e.getDevice(r1.id)?.ports.find((p) => p.kind === 'serial')?.id as string;
  const b = e.getDevice(r2.id)?.ports.find((p) => p.kind === 'serial')?.id as string;
  const c = e.connect({ deviceId: r1.id, portId: a }, { deviceId: r2.id, portId: b }, 'serial-dce');
  if (!c.ok) throw new Error(c.error);
  return { e, r1, r2 };
}
