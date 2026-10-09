import { describe, expect, it } from 'vitest';
import { EngineService, type Engine } from '../src';
import { switchLab } from './helpers';

const CAP = 60;

function busy(cap = CAP) {
  const { e, ids } = switchLab(2);
  e.state.config.maxLogEntries = cap;
  return { e, ids };
}

function pingMany(e: Engine, from: string, n: number): void {
  for (let i = 0; i < n; i++) {
    e.ping(from, '10.0.0.2', { count: 1 });
    e.runAll();
  }
}

function service(cap: number) {
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

describe('Begrenztes Event-Log', () => {
  it('hält höchstens maxLogEntries Einträge; Ids bleiben monoton und lückenlos', () => {
    const { e, ids } = busy();
    pingMany(e, ids[0] as string, 30);
    expect(e.logLength).toBeGreaterThan(CAP * 2);
    expect(e.log.length).toBeLessThanOrEqual(CAP);
    expect(e.logOffset).toBe(e.logLength - e.log.length);
    e.log.forEach((l, i) => expect(l.id).toBe(e.logOffset + i));
  });

  it('getLog(from, limit) arbeitet mit absoluten Ids und klemmt getrimmte Bereiche', () => {
    const { svc, a } = service(CAP);
    for (let i = 0; i < 30; i++) {
      svc.ping(a, '10.0.0.2');
      svc.engine.runAll();
    }
    const v = svc.getView();
    expect(v.logLength).toBe(svc.engine.logLength);
    expect(v.logStart).toBe(svc.engine.logOffset);
    expect(v.logStart).toBeGreaterThan(0);
    const all = svc.getLog(0);
    expect(all[0]?.id).toBe(v.logStart);
    expect(all).toHaveLength(v.logLength - v.logStart);
    const tail = svc.getLog(v.logLength - 5, 100);
    expect(tail.map((l) => l.id)).toEqual([
      v.logLength - 5,
      v.logLength - 4,
      v.logLength - 3,
      v.logLength - 2,
      v.logLength - 1,
    ]);
    expect(svc.getLog(v.logLength)).toEqual([]);
    expect(svc.getLog(v.logStart + 2, 3).map((l) => l.id)).toEqual([
      v.logStart + 2,
      v.logStart + 3,
      v.logStart + 4,
    ]);
  });

  it('Snapshot/Restore: Länge ist absolut; Restore hinter den getrimmten Bereich leert das Log konsistent', () => {
    const { e, ids } = busy();
    pingMany(e, ids[0] as string, 3);
    const early = e.snapshot();
    pingMany(e, ids[0] as string, 30);
    expect(e.logOffset).toBeGreaterThan(early.logLength);
    const late = e.snapshot();
    expect(late.logLength).toBe(e.logLength);
    pingMany(e, ids[0] as string, 2);
    e.restore(late);
    expect(e.logLength).toBe(late.logLength);
    e.log.forEach((l, i) => expect(l.id).toBe(e.logOffset + i));
    // älterer Snapshot (Einträge bereits getrimmt): Log leer, nächste Id = Snapshot-Länge
    e.restore(early);
    expect(e.logLength).toBe(early.logLength);
    expect(e.log).toHaveLength(0);
    pingMany(e, ids[0] as string, 1);
    expect(e.log[0]?.id).toBe(early.logLength);
  });

  it('Simulationsmodus: Step Back über die Kappung hinweg', () => {
    const { svc, a } = service(16);
    svc.setMode('simulation');
    for (let i = 0; i < 5; i++) {
      svc.ping(a, '10.0.0.2');
      let guard = 0;
      while (svc.getView().queueLength > 0 && guard++ < 400) svc.step();
    }
    const v = svc.getView();
    expect(v.logStart).toBeGreaterThan(0);
    expect(svc.stepBack()).toBe(true);
    const w = svc.getView();
    expect(w.logEpoch).toBe(v.logEpoch + 1);
    expect(w.logLength).toBeLessThan(v.logLength);
    const entries = svc.getLog(0);
    entries.forEach((l, i) => expect(l.id).toBe(w.logStart + i));
    expect(entries.length).toBe(w.logLength - w.logStart);
  });

  it('maxLogEntries 0 = unbegrenzt; resetRuntime setzt Offset zurück', () => {
    const { e, ids } = busy(0);
    pingMany(e, ids[0] as string, 30);
    expect(e.logOffset).toBe(0);
    expect(e.log.length).toBe(e.logLength);
    e.state.config.maxLogEntries = 30;
    pingMany(e, ids[0] as string, 5);
    expect(e.logOffset).toBeGreaterThan(0);
    e.resetRuntime();
    expect(e.logOffset).toBe(0);
    expect(e.logLength).toBe(0);
  });
});
