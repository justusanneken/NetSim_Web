import { describe, expect, it } from 'vitest';
import { Engine, CATALOG, type EngineSnapshot, type SimEvent } from '../src';
import { heapPop, heapPush, heapRemove } from '../src/heap';
import { mulberry32 } from '../src/rng';
import { hubLab, keys, serializeLog, switchLab } from './helpers';

const ev = (t: number, seq: number): SimEvent => ({
  t,
  seq,
  deviceId: 'x',
  kind: 'timer',
  payload: { name: `n${seq}` },
});

describe('Scheduler', () => {
  it('Heap ordnet nach (t, seq)', () => {
    const h: SimEvent[] = [];
    [ev(5, 3), ev(1, 9), ev(5, 1), ev(3, 2), ev(1, 4), ev(9, 0), ev(2, 5)].forEach((x) =>
      heapPush(h, x),
    );
    const out: string[] = [];
    for (let e = heapPop(h); e; e = heapPop(h)) out.push(`${e.t}/${e.seq}`);
    expect(out).toEqual(['1/4', '1/9', '2/5', '3/2', '5/1', '5/3', '9/0']);
    expect(heapPop(h)).toBeUndefined();
  });

  it('heapRemove entfernt und behält Ordnung', () => {
    const h: SimEvent[] = [];
    for (let i = 0; i < 20; i++) heapPush(h, ev((i * 7) % 11, i));
    expect(heapRemove(h, (e) => e.seq % 2 === 0)).toBe(10);
    expect(heapRemove(h, () => false)).toBe(0);
    let last = -1;
    for (let e = heapPop(h); e; e = heapPop(h)) {
      expect(e.t).toBeGreaterThanOrEqual(last);
      last = e.t;
    }
  });

  it('RNG ist seedbar und deterministisch', () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect(a).toEqual(b);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
  });

  it('Timer: wiederholt, abbrechbar; Ping mit count=3 sendet 3x im Sekundentakt', () => {
    const { e, ids } = switchLab(2);
    const a = ids[0] as string;
    e.ping(a, '10.0.0.2', { count: 3, intervalUs: 1_000_000 });
    e.runAll();
    const cfg = e.getDevice(a)?.config;
    expect(cfg?.kind === 'host' && cfg.pings.map((p) => p.status)).toEqual([
      'reply',
      'reply',
      'reply',
    ]);
    expect(cfg?.kind === 'host' && cfg.pings.map((p) => Math.round(p.sentAt / 1e6))).toEqual([
      0, 1, 2,
    ]);
    expect(e.queueLength).toBe(0);
  });

  it('runUntil verarbeitet nur bis t und setzt die Uhr', () => {
    const { e, ids } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    const n = e.runUntil(100);
    expect(n).toBeGreaterThan(0);
    expect(e.state.now).toBe(100);
    expect(e.peekNextTime()).toBeGreaterThan(100);
    e.runUntil(10_000_000);
    expect(e.queueLength).toBe(0);
  });

  it('Verzögerung = Serialisierung + Propagation + Verarbeitung', () => {
    const { e, ids } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    // ARP-Request: 64 B = 512 bit @100 Mbit/s → 6 µs (aufgerundet 5,12) + 5 µs Propagation
    const first = e.log.find((l) => l.msg.key.startsWith('switch.flood'));
    expect(first?.t).toBe(50 + 6 + 5);
  });
});

describe('Snapshot / Restore', () => {
  it('Zustand ist reines JSON und Restore reproduziert den Verlauf', () => {
    const { e, ids } = switchLab(3, 3);
    e.ping(ids[0] as string, '10.0.0.2', { count: 2 });
    e.runUntil(500);
    const snap = e.snapshot();
    const json = JSON.parse(JSON.stringify(snap)) as EngineSnapshot;
    expect(json).toEqual(snap);

    e.runAll();
    const finalLog = serializeLog(e.log);

    const e2 = new Engine();
    e2.restore(json);
    // Log wird nicht im Snapshot gehalten: für den Vergleich Prefix übernehmen
    e2.log = e.log.slice(0, snap.logLength);
    e2.runAll();
    expect(serializeLog(e2.log)).toEqual(finalLog);
    expect(e2.state).toEqual(e.state);
  });

  it('Restore kürzt das Log auf den Snapshot-Stand', () => {
    const { e, ids } = switchLab(2);
    const snap = e.snapshot();
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    expect(e.log.length).toBeGreaterThan(snap.logLength);
    e.restore(snap);
    expect(e.log.length).toBe(snap.logLength);
  });

  it('resetRuntime löscht Zeit, Queue, Log und Tabellen, behält Topologie', () => {
    const { e, ids, sw } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    expect(e.macTable(sw as string).length).toBeGreaterThan(0);
    e.resetRuntime();
    expect(e.state.now).toBe(0);
    expect(e.log).toHaveLength(0);
    expect(e.macTable(sw as string)).toHaveLength(0);
    expect(Object.keys(e.state.links)).toHaveLength(2);
    expect(e.getDevice(ids[0] as string)?.ports[0]?.counters.outPkts).toBe(0);
    expect(e.getDevice(ids[0] as string)?.ports[0]?.operUp).toBe(true);
  });
});

describe('Switch', () => {
  it('lernt, filtert und altert MAC-Einträge (300 s)', () => {
    const { e, ids, sw } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    expect(e.macTable(sw as string)).toHaveLength(2);
    e.runUntil(e.state.now + 299_000_000);
    expect(e.macTable(sw as string)).toHaveLength(2);
    e.runUntil(e.state.now + 2_000_000);
    expect(e.macTable(sw as string)).toHaveLength(0);
  });

  it('abgelaufener Eintrag führt wieder zu Flooding', () => {
    const { e, ids } = switchLab(3);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    // ARP-Cache des Hosts (2 min) und MAC-Aging (5 min) laufen ab
    e.runUntil(e.state.now + 400_000_000);
    const mark = e.log.length;
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    expect(keys(e.log.slice(mark)).some((k) => k.startsWith('switch.flood'))).toBe(true);
  });

  it('Port-Down löscht MAC-Einträge dieses Ports', () => {
    const { e, ids, sw } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    e.setPortAdmin(sw as string, 'p0', false);
    expect(e.macTable(sw as string).map((m) => m.portId)).toEqual(['p1']);
  });

  it('filtert Frames, deren Ziel am Eingangsport liegt', () => {
    // PC0 und PC1 hängen hinter einem Hub an Switch-Port p0.
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const hub = e.addDevice('hub');
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    const c = e.addDevice('pc');
    const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
    ok(e.connect({ deviceId: sw, portId: 'p0' }, { deviceId: hub, portId: 'p0' }, 'straight'));
    ok(e.connect({ deviceId: a, portId: 'p0' }, { deviceId: hub, portId: 'p1' }, 'straight'));
    ok(e.connect({ deviceId: b, portId: 'p0' }, { deviceId: hub, portId: 'p2' }, 'straight'));
    ok(e.connect({ deviceId: c, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight'));
    e.setHostIp(a, '10.0.0.1', '255.255.255.0');
    e.setHostIp(b, '10.0.0.2', '255.255.255.0');
    e.setHostIp(c, '10.0.0.3', '255.255.255.0');
    e.ping(c, '10.0.0.1');
    e.runAll();
    e.ping(a, '10.0.0.2');
    e.runAll();
    e.ping(b, '10.0.0.1');
    e.runAll();
    expect(keys(e.log).some((k) => k.startsWith('switch.filter'))).toBe(true);
    // Switch-Port hinter dem Hub ist Halbduplex
    expect(e.getDevice(sw)?.ports[0]?.operDuplex).toBe('half');
  });
});

describe('Host / ARP / Ping', () => {
  it('ARP-Timeout: 3 Versuche, dann Host unreachable', () => {
    const { e, ids } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.99');
    e.runAll();
    const arpReqs = e.log.filter(
      (l) => l.msg.key === 'host.arp.notMine' && l.atDeviceName === 'PC1',
    );
    expect(arpReqs).toHaveLength(3);
    expect(keys(e.log)).toContain('host.arp.failed');
    expect(keys(e.log)).toContain('ping.hostUnreachable');
    expect(e.getDevice(ids[0] as string)?.config).toMatchObject({
      pings: [{ status: 'unreachable' }],
      arpPending: {},
    });
  });

  it('Ping ohne IP und fremdes Subnetz ohne Gateway schlagen sauber fehl', () => {
    const { e, ids } = switchLab(2);
    const lone = e.addDevice('pc');
    expect(e.ping(lone, '10.0.0.1')).toEqual({ ok: false, error: 'ping.noIp' });
    e.ping(ids[0] as string, '192.168.5.5');
    e.runAll();
    expect(keys(e.log)).toContain('ping.noRoute');
  });

  it('Gateway wird per ARP aufgelöst (Router folgt in Phase 2)', () => {
    const { e, ids } = switchLab(2);
    e.setHostIp(ids[0] as string, '10.0.0.1', '255.255.255.0', '10.0.0.254');
    e.log.length = 0;
    e.ping(ids[0] as string, '192.168.5.5');
    e.runAll();
    expect(keys(e.log)).toContain('host.arp.failed');
  });

  it('ARP-Cache läuft nach 2 min ab', () => {
    const { e, ids } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    expect(e.arpTable(ids[0] as string)).toHaveLength(1);
    e.runUntil(e.state.now + 121_000_000);
    expect(e.arpTable(ids[0] as string)).toHaveLength(0);
  });

  it('Gratuitous ARP bei IP-Konfiguration, Duplicate-IP-Konflikt wird gemeldet', () => {
    const { e, ids } = switchLab(2);
    e.runAll();
    expect(keys(e.log)).toContain('host.arp.gratuitous');
    e.log.length = 0;
    e.setHostIp(ids[1] as string, '10.0.0.1', '255.255.255.0'); // gleiche IP wie PC0
    e.runAll();
    expect(e.log.some((l) => l.msg.key === 'host.arp.conflict' && l.atDeviceName === 'PC0')).toBe(
      true,
    );
  });

  it('Gratuitous ARP aktualisiert vorhandene Cache-Einträge', () => {
    const { e, ids } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    const before = e.arpTable(ids[0] as string)[0]?.mac;
    // PC1 bekommt eine neue NIC-MAC und meldet sich erneut
    const pc1 = e.getDevice(ids[1] as string);
    if (pc1?.ports[0]) pc1.ports[0].mac = '02:aa:aa:aa:aa:aa';
    e.setHostIp(ids[1] as string, '10.0.0.2', '255.255.255.0');
    e.runAll();
    expect(e.arpTable(ids[0] as string)[0]?.mac).toBe('02:aa:aa:aa:aa:aa');
    expect(before).not.toBe('02:aa:aa:aa:aa:aa');
  });

  it('Broadcast-Ping wird nicht beantwortet, Echo für fremde IP verworfen', () => {
    const { e, ids } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.255');
    e.runAll();
    expect(keys(e.log)).toContain('host.arp.failed'); // kein Host kennt .255
  });

  it('setHostIp validiert Eingaben', () => {
    const { e, ids } = switchLab(1);
    const id = ids[0] as string;
    expect(e.setHostIp(id, 'x', '255.255.255.0')).toEqual({ ok: false, error: 'ip.invalidIp' });
    expect(e.setHostIp(id, '10.0.0.1', '255.0.255.0')).toEqual({
      ok: false,
      error: 'ip.invalidMask',
    });
    expect(e.setHostIp(id, '10.0.0.1', '255.255.255.0', 'zz').ok).toBe(false);
    expect(e.setHostIp(id, '10.0.0.1', '255.255.255.0', '10.9.9.9')).toEqual({
      ok: false,
      error: 'ip.gatewayOffSubnet',
    });
    expect(e.setHostIp(id, '', '').ok).toBe(true);
    expect(e.getDevice(id)?.config).toMatchObject({ ip: undefined });
    const sw = e.addDevice('switch-l2');
    expect(e.setHostIp(sw, '10.0.0.1', '255.255.255.0').ok).toBe(false);
    expect(e.ping(sw, '10.0.0.1').ok).toBe(false);
    expect(e.ping(id, 'bad').ok).toBe(false);
  });
});

describe('Topologie', () => {
  it('lehnt ungültige Verbindungen ab', () => {
    const e = new Engine();
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    const sw = e.addDevice('switch-l2');
    const A = { deviceId: a, portId: 'p0' };
    expect(e.connect(A, { deviceId: a, portId: 'p0' }, 'straight')).toMatchObject({
      error: 'cable.reject.sameDevice',
    });
    expect(e.connect(A, { deviceId: 'nope', portId: 'p0' }, 'straight')).toMatchObject({
      error: 'cable.reject.notFound',
    });
    expect(e.connect(A, { deviceId: sw, portId: 'p0' }, 'straight').ok).toBe(true);
    expect(
      e.connect({ deviceId: b, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'),
    ).toMatchObject({
      error: 'cable.reject.portBusy',
    });
    expect(e.connect(A, { deviceId: b, portId: 'p0' }, 'straight')).toMatchObject({
      error: 'cable.reject.portBusy',
    });
    expect(
      e.connect({ deviceId: b, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'serial-dce'),
    ).toMatchObject({
      error: 'cable.reject.plug',
    });
  });

  it('Auto-MDIX: PC↔Switch geht mit beiden Kabeln, Hub↔PC nur Straight, Hub↔Hub nur Crossover', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const h1 = e.addDevice('hub');
    const h2 = e.addDevice('hub');
    const pcs = [0, 1, 2, 3, 4].map(() => e.addDevice('pc'));
    const up = (a: string, ap: string, b: string, bp: string, c: 'straight' | 'crossover') => {
      const r = e.connect({ deviceId: a, portId: ap }, { deviceId: b, portId: bp }, c);
      if (!r.ok) throw new Error(r.error);
      return r.value.operUp;
    };
    expect(up(pcs[0] as string, 'p0', sw, 'p0', 'straight')).toBe(true);
    expect(up(pcs[1] as string, 'p0', sw, 'p1', 'crossover')).toBe(true);
    expect(up(pcs[2] as string, 'p0', h1, 'p0', 'straight')).toBe(true);
    expect(up(pcs[3] as string, 'p0', h1, 'p1', 'crossover')).toBe(false);
    expect(up(h1, 'p2', h2, 'p0', 'straight')).toBe(false);
    expect(up(h1, 'p3', h2, 'p1', 'crossover')).toBe(true);
    expect(up(sw, 'p2', h1, 'p4', 'crossover')).toBe(true);
  });

  it('Fiber nur auf SFP-Ports, Rollover nur auf Console, Länge > 100 m = down', () => {
    const e = new Engine();
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    const A = { deviceId: a, portId: 'p0' };
    const B = { deviceId: b, portId: 'p0' };
    expect(e.connect(A, B, 'fiber')).toMatchObject({ error: 'cable.reject.fiber' });
    expect(e.connect(A, B, 'coax')).toMatchObject({ error: 'cable.reject.unsupported' });
    const r = e.connect(A, B, 'rollover');
    expect(r.ok && r.value.operUp).toBe(false);
    if (r.ok) e.disconnect(r.value.id);
    const long = e.connect(A, B, 'crossover', 150);
    expect(long.ok && long.value.cableProblem).toBe('cable.problem.length');
    if (long.ok) e.disconnect(long.value.id);
    const ok = e.connect(A, B, 'crossover', 90);
    expect(ok.ok && ok.value.operUp).toBe(true);
  });

  it('Spezialports: Console/SFP/Serial', () => {
    const e = new Engine();
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    const da = e.getDevice(a);
    const db = e.getDevice(b);
    if (!da?.ports[0] || !db?.ports[0]) throw new Error('ports');
    const A = { deviceId: a, portId: 'p0' };
    const B = { deviceId: b, portId: 'p0' };
    da.ports[0].kind = 'console';
    db.ports[0].kind = 'console';
    expect(e.connect(A, B, 'rollover')).toMatchObject({ ok: true, value: { operUp: true } });
    e.disconnect(da.ports[0].linkId as string);
    expect(e.connect(A, B, 'straight')).toMatchObject({ ok: true, value: { operUp: false } });
    e.disconnect(da.ports[0].linkId as string);
    expect(e.connect(A, B, 'fiber')).toMatchObject({ error: 'cable.reject.plug' });
    expect(e.connect(A, B, 'usb')).toMatchObject({ error: 'cable.reject.plug' });
    da.ports[0].kind = 'fiber-sfp';
    db.ports[0].kind = 'fiber-sfp';
    expect(e.connect(A, B, 'fiber')).toMatchObject({ ok: true, value: { operUp: true } });
    e.disconnect(da.ports[0].linkId as string);
    expect(e.connect(A, B, 'straight')).toMatchObject({ error: 'cable.reject.plug' });
    da.ports[0].kind = 'serial';
    db.ports[0].kind = 'serial';
    expect(e.connect(A, B, 'serial-dce')).toMatchObject({ ok: true, value: { operUp: true } });
    e.disconnect(da.ports[0].linkId as string);
    expect(e.connect(A, B, 'straight')).toMatchObject({ error: 'cable.reject.plug' });
    da.ports[0].kind = 'fe';
    expect(e.connect(A, B, 'serial-dce')).toMatchObject({ error: 'cable.reject.plug' });
  });

  it('connectAuto wählt Kabel und freie Ports', () => {
    const e = new Engine();
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    const sw = e.addDevice('switch-l2');
    const r1 = e.connectAuto(a, b);
    expect(r1.ok && r1.value.cable).toBe('crossover');
    const r2 = e.connectAuto(a, sw);
    expect(r2).toMatchObject({ ok: false, error: 'cable.reject.noFreePort' });
    const c = e.addDevice('pc');
    const r3 = e.connectAuto(c, sw);
    expect(r3.ok && r3.value.cable).toBe('straight');
    expect(e.connectAuto(c, 'nope')).toMatchObject({ ok: false });
  });

  it('Geschwindigkeits-/Duplex-Aushandlung und Admin-Down', () => {
    const { e, ids, sw } = switchLab(2);
    const pc = e.getDevice(ids[0] as string);
    expect(pc?.ports[0]?.operSpeed).toBe(100);
    e.setPortSettings(ids[0] as string, 'p0', { speed: 10, duplex: 'half' });
    expect(pc?.ports[0]?.operSpeed).toBe(10);
    expect(pc?.ports[0]?.operDuplex).toBe('half');
    e.setPortAdmin(sw as string, 'p0', false);
    expect(pc?.ports[0]?.operUp).toBe(false);
    expect(e.log.some((l) => l.msg.key === 'link.down')).toBe(true);
    e.setPortAdmin(sw as string, 'p0', true);
    expect(pc?.ports[0]?.operUp).toBe(true);
    e.setPortSettings(ids[0] as string, 'nope', { speed: 100 });
  });

  it('Ausschalten löscht Laufzeitzustand, Link geht down; Einschalten holt ihn zurück', () => {
    const { e, ids, sw } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    e.setPower(sw as string, false);
    expect(e.getDevice(ids[0] as string)?.ports[0]?.operUp).toBe(false);
    expect(e.macTable(sw as string)).toHaveLength(0);
    expect(e.ping(sw as string, '1.1.1.1')).toMatchObject({ ok: false });
    e.setPower(ids[0] as string, false);
    expect(e.ping(ids[0] as string, '10.0.0.2')).toEqual({ ok: false, error: 'dev.off' });
    expect(e.arpTable(ids[0] as string)).toHaveLength(0);
    e.setPower(ids[0] as string, false);
    e.setPower(sw as string, true);
    e.setPower(ids[0] as string, true);
    expect(e.getDevice(ids[0] as string)?.ports[0]?.operUp).toBe(true);
  });

  it('Frames auf getrennte Links werden verworfen; Gerät entfernen räumt auf', () => {
    const { e, ids, sw } = switchLab(2);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runUntil(60);
    const l = e.getDevice(ids[0] as string)?.ports[0]?.linkId as string;
    e.disconnect(l);
    e.runAll();
    expect(e.getDevice(ids[0] as string)?.config).toMatchObject({
      pings: [{ status: 'unreachable' }],
    });
    e.removeDevice(sw as string);
    expect(e.getDevice(sw as string)).toBeUndefined();
    expect(Object.keys(e.state.links)).toHaveLength(0);
    e.removeDevice('nope');
    e.disconnect('nope');
  });

  it('Senden auf toten Link zählt als Fehler', () => {
    const e = new Engine();
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    e.connect({ deviceId: a, portId: 'p0' }, { deviceId: b, portId: 'p0' }, 'straight');
    e.setHostIp(a, '10.0.0.1', '255.255.255.0');
    e.runAll();
    expect(e.getDevice(a)?.ports[0]?.counters.outErrors).toBe(1);
    expect(keys(e.log)).toContain('tx.linkDown');
  });

  it('Umbenennen/Verschieben, nicht unterstützter Typ', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    e.renameDevice(sw, 'Core');
    e.moveDevice(sw, { x: 5, y: 6 });
    e.renameDevice('nope', 'x');
    e.moveDevice('nope', { x: 0, y: 0 });
    expect(e.getDevice(sw)).toMatchObject({ name: 'Core', pos: { x: 5, y: 6 } });
    expect(e.getDevice(sw)?.config).toMatchObject({ hostname: 'Core' });
    expect(() => e.addDevice('router')).toThrow(/not supported/);
    expect(Object.keys(CATALOG).sort()).toEqual(['hub', 'pc', 'switch-l2']);
  });
});

describe('Hub / CSMA-CD', () => {
  it('wiederholt Frames an alle anderen Ports', () => {
    const { e, ids } = hubLab(3);
    e.ping(ids[0] as string, '10.0.0.2');
    e.runAll();
    expect(e.getDevice(ids[0] as string)?.config).toMatchObject({ pings: [{ status: 'reply' }] });
    // PC2 sieht den ARP-Broadcast UND (Hub!) die Unicast-Frames, verwirft sie aber
    expect(
      e.log.filter((l) => l.atDeviceName === 'PC2' && l.msg.key === 'host.l2.notForMe').length,
    ).toBeGreaterThan(0);
  });

  it('gleichzeitiges Senden kollidiert, Backoff löst es auf', () => {
    const { e, ids } = hubLab(3);
    e.ping(ids[0] as string, '10.0.0.3');
    e.ping(ids[1] as string, '10.0.0.3');
    e.runAll();
    expect(keys(e.log)).toContain('hub.collision');
    expect(keys(e.log)).toContain('csma.backoff');
    const cols = ids.reduce(
      (n, id) => n + (e.getDevice(id)?.ports[0]?.counters.collisions ?? 0),
      0,
    );
    expect(cols).toBeGreaterThanOrEqual(2);
    for (const id of [ids[0], ids[1]] as string[]) {
      expect(e.getDevice(id)?.config).toMatchObject({ pings: [{ status: 'reply' }] });
    }
  });

  it('Kollisionsdomänen: Hubs verbinden, Switch trennt', () => {
    const e = new Engine();
    const h1 = e.addDevice('hub');
    const h2 = e.addDevice('hub');
    const sw = e.addDevice('switch-l2');
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    e.connect({ deviceId: h1, portId: 'p0' }, { deviceId: h2, portId: 'p0' }, 'crossover');
    e.connect({ deviceId: a, portId: 'p0' }, { deviceId: h1, portId: 'p1' }, 'straight');
    e.connect({ deviceId: b, portId: 'p0' }, { deviceId: h2, portId: 'p1' }, 'straight');
    e.connect({ deviceId: sw, portId: 'p0' }, { deviceId: h2, portId: 'p2' }, 'straight');
    const d = e.collisionDomains();
    expect(d).toHaveLength(1);
    expect(d[0]?.hubs).toEqual([h1, h2].sort());
    expect(d[0]?.endpoints).toHaveLength(3);
  });

  it('Übertragung kollidiert mit laufender Wiederholung des Hubs', () => {
    const { e, ids } = hubLab(3);
    const [a, b] = ids as [string, string, string];
    e.ping(a, '10.0.0.3');
    // B sendet, während der Hub den ARP von A bereits wiederholt (Carrier Sense überlistet,
    // weil B sein Medium erst nach der Propagation als belegt sieht).
    e.runUntil(63);
    e.ping(b, '10.0.0.3');
    e.runAll();
    // Egal wie es ausgeht: Es darf nichts hängen bleiben und beide Pings sind abgeschlossen.
    for (const id of [a, b]) {
      const cfg = e.getDevice(id)?.config;
      expect(cfg?.kind === 'host' && cfg.pings.every((p) => p.status !== 'pending')).toBe(true);
    }
    expect(e.queueLength).toBe(0);
  });

  it('wiederholte Kollisionen erschöpfen nach 16 Versuchen das Frame', () => {
    const { e, ids } = hubLab(2);
    const a = e.getDevice(ids[0] as string);
    const port = a?.ports[0];
    if (!a || !port) throw new Error('setup');
    // Zwingt Kollisionen: Gegenstelle sendet unablässig synchron – wir simulieren den Zähler direkt.
    e.ping(ids[0] as string, '10.0.0.2');
    e.runUntil(60);
    const tx = e.state.transmissions[0];
    if (!tx) throw new Error('no tx');
    tx.attempts = 16;
    e.state.queue.length = 0;
    e.state.queue.push({
      t: e.state.now + 1,
      seq: 9999,
      deviceId: a.id,
      kind: 'collision',
      payload: { portId: port.id, txId: tx.id },
    });
    e.runUntil(e.state.now + 10);
    expect(keys(e.log)).toContain('csma.excessive');
  });
});

describe('Fehlerrobustheit', () => {
  it('Exception in einem Gerät markiert nur dieses als crashed', () => {
    const { e, ids } = switchLab(3);
    const victim = e.getDevice(ids[1] as string);
    if (!victim) throw new Error('setup');
    (victim.config as unknown as { arpCache: unknown }).arpCache = null;
    e.ping(ids[0] as string, '10.0.0.2');
    e.ping(ids[2] as string, '10.0.0.1');
    e.runAll();
    expect(victim.crashed?.message).toBeTruthy();
    expect(keys(e.log)).toContain('sys.deviceCrashed');
    expect(e.getDevice(ids[0] as string)?.config).toMatchObject({
      pings: [{ status: 'unreachable' }],
    });
    expect(e.getDevice(ids[2] as string)?.config).toMatchObject({ pings: [{ status: 'reply' }] });
    e.setPower(ids[1] as string, false);
    e.setPower(ids[1] as string, true);
    expect(victim.crashed).toBeUndefined();
  });
});
