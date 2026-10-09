import { describe, expect, it } from 'vitest';
import { exportVars, Interp, ScriptError } from '../src/p5/script/interp';

const run = (code: string, maxSteps = 2_000_000): Interp => {
  const it = new Interp(code, {}, { maxSteps });
  it.parse();
  it.runTop();
  return it;
};

const BIG = `const s = 'x'.padStart(20000, 'x'); const a = []; for (let i = 0; i < 10000; i++) a.push(s);`;

describe('QA2: Skript-Sandbox – Speicher- und Rechenzeitgrenzen', () => {
  it('padStart kann die String-Grenze nicht umgehen', () => {
    expect(() => run(`const s = 'x'.padStart(100000000);`)).toThrow(/string too long/);
  });

  it('join, JSON.stringify und Array-zu-String bleiben unter der String-Grenze', () => {
    for (const tail of [
      'const j = a.join("");',
      'const j = JSON.stringify(a);',
      'const j = a + "";',
      'const j = `${a}`;',
      'log(a);',
    ])
      expect(() => run(BIG + tail.replace('log(a);', 'const j = String(a);')), tail).toThrow(
        /string too long/,
      );
  });

  it('zyklische Arrays führen zu einem Skriptfehler, nicht zu einem Stacküberlauf', () => {
    expect(() => run(`const a = []; a.push(a); const s = a + '';`)).toThrow(ScriptError);
  });

  it('Array-Wachstum per Index oder unshift ist wie push begrenzt', () => {
    expect(() => run(`const a = []; for (let i = 0; i < 20000; i++) a[i] = i;`)).toThrow(
      /array too large/,
    );
    expect(() => run(`const a = []; for (let i = 0; i < 20000; i++) a.unshift(i);`)).toThrow(
      /array too large/,
    );
  });

  it('Objekte können nicht unbegrenzt viele Schlüssel bekommen', () => {
    expect(() => run(`const o = {}; for (let i = 0; i < 20000; i++) o['k' + i] = i;`)).toThrow(
      /too many/,
    );
  });

  it('der gespeicherte Zustand (exportVars) ist größenbegrenzt', () => {
    const it = new Interp(BIG, {}, { maxSteps: 2_000_000 });
    it.parse();
    it.runTop();
    expect(() => exportVars(it)).toThrow(ScriptError);
  });

  it('Prototyp-/Konstruktor-Ausbrüche bleiben gesperrt', () => {
    for (const code of [
      `const f = 'a'.slice; const c = f['constr' + 'uctor'];`,
      `const c = [].map['constructor'];`,
      `const o = {}; o['__pro' + 'to__'] = { polluted: 1 };`,
      `const c = (1)['construct' + 'or'];`,
      `const m = 'a'.slice; m.recv = 1; const c = m.recv.constructor;`,
    ])
      expect(() => run(code), code).toThrow(ScriptError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
