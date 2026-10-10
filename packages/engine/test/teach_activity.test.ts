import { strToU8, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  CheckSchema,
  assertSafeJson,
  cloneEngine,
  decodeActivity,
  deriveChecks,
  encodeActivity,
  evaluateChecks,
  parseActivity,
  pickText,
  type Activity,
  type Engine,
} from '../src';
import { chainLab } from './helpers';
import { aclEntry, ANY, eq, hostMatch } from './labs3';

function activityOf(e: Engine, extra: Partial<Activity> = {}): Activity {
  const a = chainLab();
  void a;
  return {
    schema: 1,
    kind: 'netsim-activity',
    meta: { id: 't1', title: { de: 'Titel', en: 'Title' } },
    steps: [{ text: 'Schritt 1' }],
    timeLimitSec: 0,
    passPercent: 100,
    liveProgress: false,
    locks: { hideCli: false, hideGui: false, noAddDevices: false },
    start: structuredClone(e.state),
    checks: [CheckSchema.parse({ id: 'k1', type: 'deviceExists', device: 'x' })],
    ...extra,
  };
}

describe('.nsact Codec', () => {
  it('Roundtrip erhaelt Inhalt', () => {
    const lab = chainLab();
    const act = activityOf(lab.e, { answer: structuredClone(lab.e.state) });
    const bytes = encodeActivity(act);
    expect(bytes.length).toBeGreaterThan(10);
    const r = decodeActivity(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.meta.title).toEqual({ de: 'Titel', en: 'Title' });
    expect(Object.keys(r.value.start.devices)).toHaveLength(
      Object.keys(lab.e.state.devices).length,
    );
    expect(r.value.answer).toBeDefined();
    expect(r.value.checks[0]?.weight).toBe(1);
  });

  it('weist kaputte und fremde Daten ab', () => {
    expect(decodeActivity(new Uint8Array([1, 2, 3])).ok).toBe(false);
    const notJson = zlibSync(strToU8('kein json'));
    expect(decodeActivity(notJson)).toMatchObject({ ok: false, error: 'activity.err.corrupt' });
    const wrong = zlibSync(strToU8(JSON.stringify({ schema: 1, kind: 'other' })));
    expect(decodeActivity(wrong)).toMatchObject({ ok: false, error: 'activity.err.invalid' });
  });

  it('Dekompressionsbombe wird begrenzt', () => {
    const big = zlibSync(new Uint8Array(60 * 1024 * 1024));
    expect(big.length).toBeLessThan(200_000);
    expect(decodeActivity(big)).toMatchObject({ ok: false, error: 'activity.err.corrupt' });
  });

  it('Prototype-Pollution und Tiefe werden abgewiesen', () => {
    expect(assertSafeJson(JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toBe('key:__proto__');
    expect(assertSafeJson({ constructor: 1 })).toBe('key:constructor');
    let deep: unknown = {};
    for (let i = 0; i < 60; i++) deep = { n: deep };
    expect(assertSafeJson(deep)).toBe('depth');
    expect(assertSafeJson({ a: [1, { b: 2 }] })).toBeUndefined();
    const lab = chainLab();
    const act = JSON.parse(JSON.stringify(activityOf(lab.e)));
    act.meta.__proto__ = { polluted: true };
    const o = JSON.parse(JSON.stringify(act).replace('"meta":{', '"meta":{"__proto__":{"p":1},'));
    expect(parseActivity(o)).toMatchObject({ ok: false, error: 'activity.err.unsafe' });
  });

  it('Validierung: doppelte IDs, Leere Pruefliste, kaputter Zustand', () => {
    const lab = chainLab();
    const c1 = CheckSchema.parse({ id: 'same', type: 'deviceExists', device: 'x' });
    expect(parseActivity(activityOf(lab.e, { checks: [c1, c1] }))).toMatchObject({
      ok: false,
      error: 'activity.err.duplicateId',
    });
    expect(parseActivity(activityOf(lab.e, { checks: [] })).ok).toBe(false);
    const a = activityOf(lab.e);
    (a.start as unknown as { devices: unknown }).devices = { d1: { id: 5 } };
    expect(parseActivity(a)).toMatchObject({ ok: false, error: 'activity.err.invalid' });
  });

  it('mehrsprachige Texte', () => {
    expect(pickText('x', 'de')).toBe('x');
    expect(pickText({ de: 'a', en: 'b' }, 'en')).toBe('b');
    expect(pickText({ de: 'a' }, 'en')).toBe('a');
    expect(pickText({ en: 'b' }, 'de')).toBe('b');
    expect(pickText(undefined, 'de')).toBe('');
  });
});

describe('Pruefungen aus dem Antwortnetz ableiten', () => {
  it('liefert genau die fehlenden Schritte (Routen + Erreichbarkeit)', () => {
    const answer = chainLab();
    const start = cloneEngine(answer.e);
    for (const id of [answer.r1, answer.r2 as string]) {
      const d = start.getDevice(id);
      if (d?.config.kind === 'router') d.config.staticRoutes = [];
    }
    const checks = deriveChecks(start, answer.e);
    const types = checks.map((c) => c.type);
    expect(types).toContain('route');
    expect(types).toContain('ping');
    expect(types).not.toContain('deviceExists');
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    // Das Antwortnetz erfuellt alles, das Startnetz nichts davon
    expect(evaluateChecks(answer.e, checks).percent).toBe(100);
    expect(evaluateChecks(start, checks).percent).toBeLessThan(100);
    // Deterministisch
    expect(deriveChecks(start, answer.e)).toEqual(checks);
  });

  it('erkennt gesperrten Verkehr als Erwartung "fail"', () => {
    const start = chainLab();
    const answer = cloneEngine(start.e);
    answer.setService(start.pc1, { http: { enabled: true } });
    start.e.setService(start.pc1, { http: { enabled: true } });
    const r2 = answer.getDevice(start.r2 as string);
    if (r2?.config.kind !== 'router') throw new Error('r2');
    r2.config.acls['101'] = {
      name: '101',
      type: 'extended',
      entries: [
        aclEntry({
          seq: 10,
          action: 'deny',
          proto: 'tcp',
          src: ANY,
          dst: hostMatch('10.0.2.10'),
          dstPort: eq(80),
        }),
        aclEntry({ seq: 20, action: 'permit', proto: 'ip', src: ANY, dst: ANY }),
      ],
    };
    const p = r2.config.ifaces['p1'];
    if (p) p.aclIn = '101';
    const checks = deriveChecks(start.e, answer);
    const blocked = checks.find((c) => c.type === 'service');
    expect(blocked).toMatchObject({ expect: 'fail', protocol: 'http' });
    expect(checks.some((c) => c.type === 'config' && c.spec.item === 'aclEntry')).toBe(true);
    expect(checks.some((c) => c.type === 'config' && c.spec.item === 'ifaceAcl')).toBe(true);
    expect(evaluateChecks(answer, checks).percent).toBe(100);
    expect(evaluateChecks(start.e, checks).percent).toBeLessThan(100);
  });
});
