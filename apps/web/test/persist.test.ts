import { describe, expect, it } from 'vitest';
import { EngineService5 } from '@netsim/engine';
import { CliSession } from '@netsim/cli';
import { Persistence } from '../src/engine/persistGlue';
import { UndoManager } from '../src/engine/undo';

function setup() {
  const svc = new EngineService5(1);
  const p = new Persistence(svc, () => undefined);
  const count = (): number => Object.keys(svc.engine.state.devices).length;
  return { svc, p, count };
}

describe('Undo/Redo (Entwurf)', () => {
  it('macht Platzieren, Verschieben, Verkabeln und Löschen rückgängig und stellt sie wieder her', () => {
    const { svc, p, count } = setup();
    const a = svc.addDevice('pc', { x: 0, y: 0 });
    const b = svc.addDevice('pc', { x: 100, y: 0 });
    expect(count()).toBe(2);
    svc.moveDevice(a, { x: 50, y: 60 });
    const link = svc.connectAuto(a, b);
    expect(link.ok).toBe(true);
    expect(Object.keys(svc.engine.state.links)).toHaveLength(1);
    svc.removeDevice(b);
    expect(count()).toBe(1);

    expect(p.undo()).toBe(true); // Gerät wieder da
    expect(count()).toBe(2);
    expect(Object.keys(svc.engine.state.links)).toHaveLength(1);
    expect(p.undo()).toBe(true); // Kabel weg
    expect(Object.keys(svc.engine.state.links)).toHaveLength(0);
    expect(p.undo()).toBe(true); // Verschieben zurück
    expect(svc.engine.getDevice(a)?.pos).toEqual({ x: 0, y: 0 });
    expect(p.redo()).toBe(true);
    expect(svc.engine.getDevice(a)?.pos).toEqual({ x: 50, y: 60 });
    expect(p.undoMgr.info()).toEqual(
      { undo: 3, redo: 3 - 1 + 0 }.undo === 3 ? { undo: 3, redo: 2 } : { undo: 0, redo: 0 },
    );
  });

  it('eine neue Änderung verwirft die Redo-Liste; fehlgeschlagene Befehle erzeugen keinen Schritt', () => {
    const { svc, p } = setup();
    const a = svc.addDevice('pc', { x: 0, y: 0 });
    svc.addDevice('pc', { x: 10, y: 0 });
    p.undo();
    expect(p.undoMgr.info().redo).toBe(1);
    svc.moveDevice(a, { x: 5, y: 5 });
    expect(p.undoMgr.info().redo).toBe(0);
    const n = p.undoMgr.info().undo;
    svc.setHostIp(a, 'kein-ip', '255.255.255.0');
    expect(p.undoMgr.info().undo).toBe(n);
    expect(p.undo()).toBe(true);
    expect(p.undo()).toBe(true);
    expect(p.undo()).toBe(false);
  });

  it('GUI-Konfiguration (setHostIp) und CLI-Konfiguration sind rückgängig machbar', () => {
    const { svc, p } = setup();
    const r = svc.addDevice('router', { x: 0, y: 0 });
    const d = svc.engine.getDevice(r);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
    const s = new CliSession(svc.engine, r);
    const pre = p.cliBegin(r);
    for (const l of [
      'enable',
      'configure terminal',
      'interface gi0/0',
      'ip address 10.1.1.1 255.255.255.0',
      'no shutdown',
      'end',
    ])
      s.input(l);
    p.cliEnd(r, pre);
    const ip = (): string | undefined => {
      const c = svc.engine.getDevice(r)?.config;
      return c?.kind === 'router' ? c.ifaces['p0']?.ip : undefined;
    };
    expect(ip()).toBe('10.1.1.1');
    // show-Befehle ändern die Konfiguration nicht -> kein Schritt
    const n = p.undoMgr.info().undo;
    const pre2 = p.cliBegin(r);
    s.input('show running-config');
    p.cliEnd(r, pre2);
    expect(p.undoMgr.info().undo).toBe(n);
    p.undo();
    expect(ip()).toBeUndefined();
    p.redo();
    expect(ip()).toBe('10.1.1.1');
  });

  it('stört den Schritt-zurück der Simulation nicht', () => {
    const { svc, p } = setup();
    const a = svc.addDevice('pc', { x: 0, y: 0 });
    const b = svc.addDevice('pc', { x: 1, y: 0 });
    svc.connectAuto(a, b);
    svc.setHostIp(a, '10.0.0.1', '255.255.255.0');
    svc.setHostIp(b, '10.0.0.2', '255.255.255.0');
    svc.setMode('simulation');
    svc.ping(a, '10.0.0.2');
    expect(svc.step()).toBe(true);
    expect(svc.getView().canStepBack).toBe(true);
    // Step-Back berührt den Undo-Stapel nicht
    const before = p.undoMgr.info();
    expect(svc.stepBack()).toBe(true);
    expect(p.undoMgr.info()).toEqual(before);
    // und Undo bleibt danach nutzbar
    expect(p.undo()).toBe(true);
  });

  it('begrenzt den Speicher: höchstens maxSteps Schritte, älteste fallen heraus', () => {
    let n = 0;
    const m = new UndoManager(
      () => String(n),
      () => true,
      undefined,
      100,
    );
    for (let i = 0; i < 250; i++) m.run(() => n++);
    expect(m.info().undo).toBe(100);
    const small = new UndoManager(
      () => String(n).repeat(1000),
      () => true,
      undefined,
      100,
      5000,
    );
    for (let i = 0; i < 20; i++) small.run(() => n++);
    expect(small.info().undo).toBeLessThanOrEqual(5);
  });

  it('ein fehlschlagendes Wiederherstellen verliert den Schritt nicht still', () => {
    let ok = false;
    let n = 0;
    const m = new UndoManager(
      () => String(n),
      () => ok,
    );
    m.run(() => n++);
    expect(m.undo()).toBe(false);
    ok = true;
    expect(m.redo()).toBe(false);
  });
});

describe('Datei, Vorlagen, Einfügen', () => {
  it('Speichern -> Neu -> Öffnen stellt das Netz wieder her (inkl. Szenarien-Durchreichung)', () => {
    const { svc, p, count } = setup();
    p.loadTemplate('vlan-trunk');
    const n = count();
    expect(n).toBeGreaterThan(5);
    p.scenarios = { schema: 1, active: 0, nextId: 1, scenarios: [] };
    p.name = 'Test';
    const bytes = p.save();
    p.newTopology();
    expect(count()).toBe(0);
    const r = p.open(bytes);
    expect(r.ok).toBe(true);
    expect(count()).toBe(n);
    expect(p.name).toBe('Test');
    expect(p.scenarios).toEqual({ schema: 1, active: 0, nextId: 1, scenarios: [] });
    // Öffnen ist undo-bar
    p.undo();
    expect(count()).toBe(0);
    expect(svc.getView().devices).toHaveLength(0);
  });

  it('lehnt kaputte Dateien ab, ohne den Zustand anzutasten', () => {
    const { p, count } = setup();
    p.loadTemplate('soho');
    const n = count();
    expect(p.open(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(count()).toBe(n);
  });

  it('listet die Vorlagen und lädt sie; unbekannte Vorlage liefert Fehler', () => {
    const { p } = setup();
    expect(p.listTemplates().length).toBeGreaterThanOrEqual(10);
    expect(p.loadTemplate('nope')).toMatchObject({ ok: false });
  });

  it('Einfügen: neue Geräte, Undo entfernt sie wieder', () => {
    const { svc, p, count } = setup();
    const a = svc.addDevice('pc', { x: 0, y: 0 });
    svc.setHostIp(a, '10.0.0.1', '255.255.255.0');
    const r = p.paste([a], { x: 20, y: 20 });
    expect(r.ok).toBe(true);
    expect(count()).toBe(2);
    p.undo();
    expect(count()).toBe(1);
  });
});
