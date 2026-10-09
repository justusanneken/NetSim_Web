import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { runScript } from '@netsim/cli';
import { EXAMPLES } from '../src/scriptExamples';

describe('Skript-Beispiele', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.id} läuft fehlerfrei und deterministisch`, () => {
      const a = runScript(new Engine({ seed: 1 }), ex.code);
      const b = runScript(new Engine({ seed: 1 }), ex.code);
      expect(a.error).toBeUndefined();
      expect(a.output).toEqual(b.output);
      expect(a.output.length).toBeGreaterThan(0);
    });
  }

  it('OSPF-Beispiel konvergiert', () => {
    const r = runScript(new Engine({ seed: 1 }), EXAMPLES[0]?.code ?? '');
    expect(r.output[0]).toMatch(/OSPF konvergiert: true/);
  });

  it('Ping-Sweep findet genau die beiden anderen PCs', () => {
    const r = runScript(new Engine({ seed: 1 }), EXAMPLES[1]?.code ?? '');
    expect(r.output.at(-1)).toBe('Erreichbar: 2 von 5 -> 10.0.0.2, 10.0.0.3');
  });
});
