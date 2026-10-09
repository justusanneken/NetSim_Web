import { describe, expect, it } from 'vitest';
import { EngineService } from '@netsim/engine';
import { syncLogWindow, type LogWindow } from '../src/logSync';

function setup(cap: number) {
  const svc = new EngineService(1, { maxLogEntries: cap });
  const sw = svc.addDevice('switch-l2', { x: 0, y: 0 });
  const a = svc.addDevice('pc', { x: 0, y: 0 });
  const b = svc.addDevice('pc', { x: 0, y: 0 });
  svc.connect({ deviceId: a, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
  svc.connectAuto(b, sw);
  svc.setHostIp(a, '10.0.0.1', '255.255.255.0');
  svc.setHostIp(b, '10.0.0.2', '255.255.255.0');
  return { svc, a };
}

const fetchFrom = (svc: EngineService) => (from: number, limit: number) =>
  Promise.resolve(svc.getLog(from, limit));

describe('syncLogWindow', () => {
  it('lädt inkrementell, folgt dem Trimmen der Engine und behält lückenlose Ids', async () => {
    const { svc, a } = setup(50);
    let w: LogWindow = { log: [], base: 0 };
    let epoch = svc.getView().logEpoch;
    for (let round = 0; round < 20; round++) {
      svc.ping(a, '10.0.0.2');
      svc.engine.runAll();
      const v = svc.getView();
      w = await syncLogWindow(w, v, v.logEpoch !== epoch, fetchFrom(svc));
      epoch = v.logEpoch;
      expect(w.base).toBe(v.logStart);
      expect(w.base + w.log.length).toBe(v.logLength);
      w.log.forEach((l, i) => expect(l.id).toBe(w.base + i));
    }
    expect(w.base).toBeGreaterThan(0);
    expect(w.log.length).toBeLessThanOrEqual(50);
  });

  it('neue Epoche (Step Back / Reset) setzt die Kopie neu auf', async () => {
    const { svc, a } = setup(30);
    svc.setMode('simulation');
    let w: LogWindow = { log: [], base: 0 };
    let epoch = svc.getView().logEpoch;
    for (let i = 0; i < 6; i++) {
      svc.ping(a, '10.0.0.2');
      let g = 0;
      while (svc.getView().queueLength > 0 && g++ < 400) svc.step();
    }
    let v = svc.getView();
    w = await syncLogWindow(w, v, v.logEpoch !== epoch, fetchFrom(svc));
    epoch = v.logEpoch;
    expect(w.base).toBeGreaterThan(0);
    expect(svc.stepBack()).toBe(true);
    v = svc.getView();
    w = await syncLogWindow(w, v, v.logEpoch !== epoch, fetchFrom(svc));
    expect(w.base).toBe(v.logStart);
    expect(w.base + w.log.length).toBe(v.logLength);
    w.log.forEach((l, i) => expect(l.id).toBe(w.base + i));
  });
});
