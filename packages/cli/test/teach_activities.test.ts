import {
  decodeActivity,
  encodeActivity,
  engineFromState,
  evaluateChecks,
  loadStateInto,
  Engine,
} from '@netsim/engine';
import { describe, expect, it } from 'vitest';
import { exampleActivities } from '../src';
import { rig } from './helpers';

describe('Parser: Schluesselwoerter mit Grossbuchstaben', () => {
  it('encapsulation dot1Q wird in jeder Schreibweise akzeptiert', () => {
    for (const w of ['dot1Q', 'dot1q', 'DOT1Q']) {
      const r = rig();
      const out = r.run(
        'enable',
        'configure terminal',
        'interface gi0/0.10',
        `encapsulation ${w} 10`,
      );
      expect(out).not.toContain('% Invalid');
    }
  });
});

describe('Beispielaufgaben', () => {
  const acts = exampleActivities();

  it('es gibt fuenf, zweisprachig, mit eindeutigen IDs', () => {
    expect(acts).toHaveLength(5);
    expect(new Set(acts.map((a) => a.meta.id)).size).toBe(5);
    for (const a of acts) {
      expect(typeof a.meta.title).toBe('object');
      expect(a.steps.length).toBeGreaterThanOrEqual(3);
      for (const s of a.steps)
        expect(typeof s.text === 'object' && s.text.de && s.text.en).toBeTruthy();
      expect(a.checks.length).toBeGreaterThanOrEqual(5);
    }
  });

  for (const a of exampleActivities()) {
    it(`${a.meta.id}: Startnetz unvollstaendig, Antwortnetz erfuellt alles`, () => {
      const start = engineFromState(a.start);
      const answer = engineFromState(a.answer as NonNullable<typeof a.answer>);
      const s = evaluateChecks(start, a.checks);
      const r = evaluateChecks(answer, a.checks);
      const failed = r.results.filter((x) => !x.passed).map((x) => `${x.id}:${x.reason?.key}`);
      expect(failed).toEqual([]);
      expect(r.percent).toBe(100);
      expect(s.percent).toBeLessThanOrEqual(50);
    });

    it(`${a.meta.id}: Roundtrip als .nsact und deterministische Auswertung`, () => {
      const back = decodeActivity(encodeActivity(a));
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      const e1 = new Engine({ seed: 1 });
      loadStateInto(e1, back.value.start);
      const e2 = engineFromState(a.start);
      expect(evaluateChecks(e1, a.checks)).toEqual(evaluateChecks(e2, a.checks));
    });
  }
});
