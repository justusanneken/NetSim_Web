import { describe, expect, it } from 'vitest';
import {
  CheckSchema,
  TeachService,
  encodeActivity,
  newScenarioFile,
  parseScenarioFile,
  type Engine,
} from '../src';

function lab(): { s: TeachService; a: string; b: string; r: string; e: Engine } {
  const s = new TeachService(1);
  const e = s.engine;
  const r = e.addDevice('router', { name: 'R1' });
  const a = e.addDevice('pc', { name: 'PC0' });
  const b = e.addDevice('pc', { name: 'PC1' });
  e.connect({ deviceId: a, portId: 'p0' }, { deviceId: r, portId: 'p0' }, 'straight');
  e.connect({ deviceId: b, portId: 'p0' }, { deviceId: r, portId: 'p1' }, 'straight');
  e.setInterfaceIp(r, 'p0', '10.0.1.1', '255.255.255.0');
  e.setInterfaceIp(r, 'p1', '10.0.2.1', '255.255.255.0');
  e.setPortAdmin(r, 'p0', true);
  e.setPortAdmin(r, 'p1', true);
  e.setHostIp(a, '10.0.1.10', '255.255.255.0', '10.0.1.1');
  e.setHostIp(b, '10.0.2.10', '255.255.255.0', '10.0.2.1');
  e.runAll();
  return { s, a, b, r, e };
}

const run = (e: Engine, sec: number): void => {
  e.runUntil(e.state.now + sec * 1_000_000);
};

describe('Szenarien', () => {
  it('startet mit Scenario 0; anlegen, wechseln, loeschen', () => {
    const { s } = lab();
    expect(s.getScenarios().scenarios.map((x) => x.name)).toEqual(['Scenario 0']);
    expect(s.scenarioAdd()).toBe(1);
    expect(s.getScenarios().active).toBe(1);
    expect(s.getScenarios().scenarios[1]?.name).toBe('Scenario 1');
    expect(s.scenarioSelect(0).ok).toBe(true);
    expect(s.scenarioSelect(7).ok).toBe(false);
    expect(s.scenarioUpdate(1, { name: 'Test', description: 'Beschreibung' }).ok).toBe(true);
    expect(s.scenarioUpdate(9, { name: 'x' }).ok).toBe(false);
    expect(s.getScenarios().scenarios[1]).toMatchObject({
      name: 'Test',
      description: 'Beschreibung',
    });
    expect(s.scenarioDelete(1).ok).toBe(true);
    expect(s.scenarioDelete(0)).toMatchObject({ ok: false, error: 'scenario.err.last' });
    expect(s.scenarioDelete(5).ok).toBe(false);
    expect(s.getScenarios().scenarios).toHaveLength(1);
  });

  it('PDUs gehoeren zum Szenario und bleiben beim Wechsel getrennt', () => {
    const { s, a } = lab();
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' });
    s.scenarioAdd();
    expect(s.getScenarios().scenarios[1]?.pdus).toHaveLength(0);
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' }, false);
    s.scenarioSelect(0);
    expect(s.getScenarios().scenarios[0]?.pdus).toHaveLength(1);
    expect(s.getScenarios().scenarios[1]?.pdus[0]?.status).toBe('unsent');
  });

  it('Simple PDU: pending, dann successful; Rerun und Delete', () => {
    const { s, a, e } = lab();
    const r = s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' });
    expect(r.ok).toBe(true);
    expect(s.getScenarios().scenarios[0]?.pdus[0]?.status).toBe('pending');
    run(e, 5);
    const p = s.getScenarios().scenarios[0]?.pdus[0];
    expect(p).toMatchObject({ status: 'successful', sent: 1, okCount: 1 });
    expect(s.pduRerun(1).ok).toBe(true);
    expect(s.getScenarios().scenarios[0]?.pdus[0]?.status).toBe('pending');
    run(e, 5);
    expect(s.getScenarios().scenarios[0]?.pdus[0]?.status).toBe('successful');
    expect(s.pduRerun(99).ok).toBe(false);
    expect(s.pduDelete(1).ok).toBe(true);
    expect(s.pduDelete(1).ok).toBe(false);
    expect(s.getScenarios().scenarios[0]?.pdus).toHaveLength(0);
  });

  it('Complex PDU: UDP auf geschlossenen Port ist Failed mit Ursache', () => {
    const { s, a, e } = lab();
    s.pduAdd({ protocol: 'udp', src: a, dst: '10.0.2.10', dport: 5000, payload: 'hello' });
    run(e, 5);
    const p = s.getScenarios().scenarios[0]?.pdus[0];
    expect(p?.status).toBe('failed');
    expect(p?.note).toBeTruthy();
    // der Dienst auf dem Ziel macht daraus kein Erfolg; ICMP bleibt erfolgreich
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' });
    run(e, 5);
    expect(s.getScenarios().scenarios[0]?.pdus[1]?.status).toBe('successful');
  });

  it('Komplexe PDU mit Verzoegerung und Wiederholung (Timer, deterministisch)', () => {
    const { s, a, e } = lab();
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10', delaySec: 3, count: 3, intervalSec: 2 });
    const first = () => s.getScenarios().scenarios[0]?.pdus[0];
    run(e, 1);
    expect(first()).toMatchObject({ status: 'pending', sent: 0 });
    run(e, 3); // t = 4 s: erster Versuch bei 3 s
    expect(first()?.sent).toBe(1);
    run(e, 10);
    expect(first()).toMatchObject({ status: 'successful', sent: 3, okCount: 3 });
  });

  it('Ziel nicht erreichbar: Failed; Quelle ohne IP; unbekannte Quelle', () => {
    const { s, a, e } = lab();
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.9.9' });
    run(e, 10);
    expect(s.getScenarios().scenarios[0]?.pdus[0]?.status).toBe('failed');
    expect(s.pduAdd({ protocol: 'icmp', src: 'ghost', dst: '10.0.9.9' }).ok).toBe(true);
    expect(s.getScenarios().scenarios[0]?.pdus[1]?.status).toBe('failed');
    expect(s.pduAdd({ protocol: 'nope' as never, src: a, dst: 'x' })).toMatchObject({
      ok: false,
      error: 'pdu.err.invalid',
    });
  });

  it('Loeschen einer wartenden PDU verwirft ihre Timer', () => {
    const { s, a, e } = lab();
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10', delaySec: 5 });
    s.pduDelete(1);
    const before = e.log.length;
    run(e, 20);
    expect(e.log.length).toBe(before);
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' }, false);
    s.pduClear();
    expect(s.getScenarios().scenarios[0]?.pdus).toHaveLength(0);
  });

  it('Szenariodatei: Roundtrip und Absicherung', () => {
    const { s, a, e } = lab();
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' });
    run(e, 5);
    s.scenarioAdd();
    const json = JSON.parse(JSON.stringify(s.getScenarios()));
    const s2 = new TeachService(1);
    s2.setScenarios(json);
    expect(s2.getScenarios().scenarios).toHaveLength(2);
    expect(s2.getScenarios().scenarios[0]?.pdus[0]).toMatchObject({ status: 'successful' }); // zuletzt bekanntes Ergebnis bleibt
    expect(parseScenarioFile({ schema: 3 })).toEqual(newScenarioFile());
    expect(parseScenarioFile(undefined)).toEqual(newScenarioFile());
    const f = parseScenarioFile({
      schema: 1,
      active: 9,
      scenarios: [
        {
          id: 0,
          name: 'x',
          pdus: [{ id: 1, spec: { protocol: 'icmp', src: 'a', dst: 'b' }, status: 'pending' }],
        },
      ],
    });
    expect(f.active).toBe(0);
    expect(f.scenarios[0]?.pdus[0]?.status).toBe('unsent');
    s2.setScenarios(undefined);
    expect(s2.getScenarios().scenarios).toHaveLength(1);
  });

  it('Determinismus: gleiche Eingaben ergeben gleiches Log', () => {
    const logOf = (): string[] => {
      const { s, a, e } = lab();
      s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10', count: 2, intervalSec: 1 });
      s.pduAdd({ protocol: 'udp', src: a, dst: '10.0.2.10', dport: 7, delaySec: 1 });
      run(e, 10);
      return e.log.map((l) => `${l.t} ${l.atDeviceName} ${l.msg.key}`);
    };
    expect(logOf()).toEqual(logOf());
  });
});

describe('Challenge ueber den Dienst', () => {
  it('liefert Fragen zu einem Log-Eintrag, sonst leer', () => {
    const { s, a, e } = lab();
    e.log.length = 0;
    s.pduAdd({ protocol: 'icmp', src: a, dst: '10.0.2.10' });
    run(e, 5);
    const fw = e.log.find((l) => l.msg.key === 'router.forward');
    expect(fw).toBeDefined();
    const qs = s.challenge(fw?.id as number);
    expect(qs.length).toBeGreaterThan(3);
    expect(qs.every((x) => x.id.startsWith(`${fw?.id}:`))).toBe(true);
    expect(s.challenge(99999)).toEqual([]);
  });
});

describe('Aufgaben im Dienst', () => {
  it('laden, teilweise loesen, Fortschritt, Antwort, Neustart', () => {
    const { s, a, b, r, e } = lab();
    // Startnetz: Router-Schnittstelle zu PC1 aus, kein Hostname
    e.setPortAdmin(r, 'p1', false);
    const startState = structuredClone(e.state);
    const checks = [
      CheckSchema.parse({
        id: 'if',
        type: 'ifaceState',
        device: 'R1',
        iface: 'p1',
        up: true,
        weight: 2,
      }),
      CheckSchema.parse({ id: 'ping', type: 'ping', from: 'PC0', to: 'PC1', weight: 2 }),
      CheckSchema.parse({
        id: 'hn',
        type: 'config',
        device: 'R1',
        spec: { item: 'hostname', value: 'Edge' },
      }),
      CheckSchema.parse({ id: 'ex', type: 'deviceExists', device: 'PC0' }),
    ];
    const answerEngine = new TeachService(1);
    void answerEngine;
    const bytes = encodeActivity({
      schema: 1,
      kind: 'netsim-activity',
      meta: { id: 'x', title: 'T' },
      steps: [],
      timeLimitSec: 0,
      passPercent: 100,
      liveProgress: false,
      locks: { hideCli: false, hideGui: false, noAddDevices: false },
      start: startState,
      answer: startState,
      checks,
    });
    const s2 = new TeachService(1);
    expect(s2.activityCheck()).toMatchObject({ ok: false, error: 'activity.err.none' });
    const loaded = s2.activityLoad(bytes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.hasAnswer).toBe(true);
    expect('start' in loaded.value).toBe(false);
    expect(s2.activityInfo()?.meta.id).toBe('x');
    const c1 = s2.activityCheck();
    expect(c1.ok && c1.value.percent).toBe(17);
    // Teil 1: Schnittstelle einschalten -> Ping geht, 2+2+1 von 6
    s2.setPortAdmin(b, 'p0', true);
    const rid = Object.values(s2.engine.state.devices).find((d) => d.name === 'R1')?.id as string;
    s2.setPortAdmin(rid, 'p1', true);
    run(s2.engine, 3);
    const c2 = s2.activityCheck();
    expect(c2.ok && c2.value.percent).toBe(83);
    expect(c2.ok && c2.value.results.find((x) => x.id === 'hn')?.reason?.key).toBe(
      'check.fail.hostname',
    );
    const evalPrev = s2.evaluate(checks);
    expect(evalPrev.ok).toBe(true);
    expect(s2.evaluate([{ type: 'kaputt' }])).toMatchObject({ ok: false });
    expect(s2.activityRestart().ok).toBe(true);
    const c3 = s2.activityCheck();
    expect(c3.ok && c3.value.percent).toBe(17);
    expect(s2.activityShowAnswer().ok).toBe(true);
    s2.activityClose();
    expect(s2.activityInfo()).toBeUndefined();
    expect(s2.activityShowAnswer().ok).toBe(false);
    expect(s2.activityRestart().ok).toBe(false);
    expect(s2.activityLoad(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(s2.activityLoad({ nope: true }).ok).toBe(false);
  });

  it('Autor: festhalten, ableiten, exportieren, wieder laden', () => {
    const { s, r, e } = lab();
    expect(s.authorDerive()).toMatchObject({ ok: false, error: 'activity.err.needBoth' });
    e.setPortAdmin(r, 'p1', false);
    s.authorCapture('start');
    e.setPortAdmin(r, 'p1', true);
    s.authorCapture('answer');
    expect(s.authorStatus()).toEqual({ start: true, answer: true });
    const derived = s.authorDerive();
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.value.length).toBeGreaterThan(0);
    const out = s.authorExport({
      meta: { id: 'auth', title: { de: 'Titel', en: 'Title' } },
      checks: derived.value,
      includeAnswer: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const s2 = new TeachService(1);
    const l = s2.activityLoad(out.value);
    expect(l.ok && l.value.hasAnswer).toBe(true);
    expect(s2.authorExport({ meta: { id: '', title: '' }, checks: [] })).toMatchObject({
      ok: false,
      error: 'activity.err.invalid',
    });
    s.authorDiscard('answer');
    expect(s.authorStatus().answer).toBe(false);
    const out2 = s.authorExport({ meta: { id: 'a', title: 'a' }, checks: derived.value });
    expect(out2.ok).toBe(true);
    s.authorDiscard('start');
  });
});
