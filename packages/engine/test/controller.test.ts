import { describe, expect, it } from 'vitest';
import { EngineService, SimController } from '../src';

describe('SimController', () => {
  const setup = (): { svc: EngineService; a: string } => {
    const svc = new EngineService(1);
    const sw = svc.addDevice('switch-l2', { x: 0, y: 0 });
    const a = svc.addDevice('pc', { x: 0, y: 0 });
    const b = svc.addDevice('pc', { x: 0, y: 0 });
    svc.connect({ deviceId: a, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
    svc.connectAuto(b, sw);
    svc.setHostIp(a, '10.0.0.1', '255.255.255.0');
    svc.setHostIp(b, '10.0.0.2', '255.255.255.0');
    return { svc, a };
  };

  it('Realtime: Wanduhr treibt die virtuelle Uhr, Faktor skaliert', () => {
    const { svc, a } = setup();
    svc.ping(a, '10.0.0.2');
    svc.tick(1);
    expect(svc.getView().now).toBe(1000);
    svc.setSpeed(10);
    svc.tick(1);
    expect(svc.getView().now).toBe(11_000);
    svc.setSpeed(1000);
    expect(svc.getView().speed).toBe(20);
    svc.setSpeed(0.0001);
    expect(svc.getView().speed).toBe(0.1);
    svc.setSpeed(20);
    for (let i = 0; i < 200; i++) svc.tick(16);
    expect(svc.getView().queueLength).toBe(0);
    expect(svc.consumeDirty()).toBe(true);
  });

  it('Pause stoppt die Zeit, Play setzt fort', () => {
    const { svc } = setup();
    svc.pause();
    svc.tick(100);
    expect(svc.getView().now).toBe(0);
    expect(svc.getView().mode).toBe('paused');
    svc.play();
    svc.tick(100);
    expect(svc.getView().mode).toBe('realtime');
    expect(svc.getView().now).toBe(100_000);
  });

  it('Simulation: Step bis zum nächsten sichtbaren Ereignis, Step Back via Snapshot', () => {
    const { svc, a } = setup();
    svc.setMode('simulation');
    svc.consumeDirty();
    svc.ping(a, '10.0.0.2');
    expect(svc.getView().canStepBack).toBe(false);
    const n0 = svc.getView().logLength;
    expect(svc.step()).toBe(true);
    expect(svc.getView().logLength).toBe(n0 + 1);
    expect(svc.getView().canStepBack).toBe(true);
    const t1 = svc.getView().now;
    svc.step();
    expect(svc.getView().logLength).toBe(n0 + 2);
    expect(svc.stepBack()).toBe(true);
    expect(svc.getView().now).toBe(t1);
    expect(svc.getView().logLength).toBe(n0 + 1);
    expect(svc.stepBack()).toBe(true);
    expect(svc.stepBack()).toBe(false);
    // erneut vorwärts liefert denselben Verlauf
    svc.step();
    expect(svc.getView().now).toBe(t1);
  });

  it('Auto-Capture läuft mit Verzögerung und endet bei leerer Queue', () => {
    const { svc, a } = setup();
    svc.setMode('simulation');
    svc.ping(a, '10.0.0.2');
    svc.play();
    expect(svc.getView().autoCapture).toBe(true);
    svc.tick(399);
    const l0 = svc.getView().logLength;
    svc.tick(1);
    expect(svc.getView().logLength).toBe(l0 + 1);
    for (let i = 0; i < 100; i++) svc.tick(400);
    expect(svc.getView().queueLength).toBe(0);
    expect(svc.getView().autoCapture).toBe(false);
    svc.pause();
    expect(svc.getView().mode).toBe('simulation');
    expect(svc.step()).toBe(false);
  });

  it('Reset leert Zeit und Verlauf', () => {
    const { svc, a } = setup();
    svc.setMode('simulation');
    svc.ping(a, '10.0.0.2');
    svc.step();
    svc.reset();
    expect(svc.getView()).toMatchObject({ now: 0, logLength: 0, canStepBack: false, logEpoch: 1 });
    svc.clear();
    expect(svc.getView()).toMatchObject({ devices: [], links: [], logEpoch: 2 });
  });

  it('Service reicht Befehle durch', () => {
    const { svc, a } = setup();
    expect(svc.getView().devices.find((d) => d.id === a)?.ip).toBe('10.0.0.1');
    svc.renameDevice(a, 'Alpha');
    svc.moveDevice(a, { x: 3, y: 4 });
    svc.setPortAdmin(a, 'p0', false);
    svc.setPortAdmin(a, 'p0', true);
    svc.setPower(a, false);
    svc.setPower(a, true);
    expect(svc.getView().devices.find((d) => d.id === a)).toMatchObject({
      name: 'Alpha',
      pos: { x: 3, y: 4 },
      powered: true,
    });
    expect(svc.connectAuto(a, 'nope').ok).toBe(false);
    expect(
      svc.connect({ deviceId: a, portId: 'p0' }, { deviceId: 'zz', portId: 'p0' }, 'straight').ok,
    ).toBe(false);
    expect(svc.getLog(0).length).toBeGreaterThan(0);
    svc.removeDevice(a);
    svc.disconnect('nope');
    expect(svc.getView().devices).toHaveLength(2);
    expect(svc.engine.state.devices[a]).toBeUndefined();
  });

  it('Router-Befehle über den Service und Router-View', () => {
    const svc = new EngineService(1);
    const r = svc.addDevice('router', { x: 0, y: 0 });
    const pc = svc.addDevice('pc', { x: 0, y: 0 });
    svc.connectAuto(pc, r);
    expect(svc.setInterfaceIp(r, 'p0', '10.0.0.1', '255.255.255.0').ok).toBe(true);
    svc.setPortAdmin(r, 'p0', true);
    svc.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1');
    expect(
      svc.addStaticRoute(r, { prefix: '10.9.0.0', mask: '255.255.0.0', nextHop: '10.0.0.2' }).ok,
    ).toBe(true);
    expect(svc.setPortMtu(r, 'p0', 1400).ok).toBe(true);
    expect(svc.trace(pc, '10.0.0.1').ok).toBe(true);
    svc.setSpeed(20);
    for (let i = 0; i < 400; i++) svc.tick(16);
    const v = svc.getView().devices.find((d) => d.id === r);
    expect(v?.routes?.some((x) => x.type === 'S')).toBe(true);
    expect(v?.ifaces?.p0?.ip).toBe('10.0.0.1');
    expect(v?.staticRoutes).toHaveLength(1);
    expect(v?.ports[0]?.mtu).toBe(1400);
    expect(svc.getView().devices.find((d) => d.id === pc)?.traces?.[0]?.done).toBe(true);
    expect(
      svc.removeStaticRoute(r, { prefix: '10.9.0.0', mask: '255.255.0.0', nextHop: '10.0.0.2' }).ok,
    ).toBe(true);
    svc.touch();
  });

  it('View enthält MAC-/ARP-Tabellen und Domänen', () => {
    const { svc, a } = setup();
    svc.ping(a, '10.0.0.2');
    new SimController();
    svc.setSpeed(20);
    for (let i = 0; i < 100; i++) svc.tick(16);
    const v = svc.getView();
    expect(v.devices.find((d) => d.type === 'switch-l2')?.macTable).toHaveLength(2);
    expect(v.devices.find((d) => d.id === a)?.arpTable).toHaveLength(1);
    expect(v.links[0]?.cableOk).toBe(true);
    expect(v.domains).toEqual([]);
  });
});
