import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig } from '../src';
import { Interp, ScriptError, toStr, type Value } from '../src/p5/script/interp';

const evalExpr = (code: string): Value => {
  const it = new Interp(`const r = ${code};`);
  it.parse();
  it.runTop();
  return it.global.vars.get('r')?.v;
};

describe('Skript-Interpreter', () => {
  it('Arithmetik, Strings, Arrays, Objekte, Funktionen', () => {
    expect(evalExpr('1 + 2 * 3 ** 2')).toBe(19);
    expect(evalExpr("'a' + 1 + 2")).toBe('a12');
    expect(evalExpr('`x=${1 + 1}`')).toBe('x=2');
    expect(evalExpr('[1, 2, 3].map(x => x * 2).join("-")')).toBe('2-4-6');
    expect(evalExpr('{ a: 1, b: [2, 3] }.b[1]')).toBe(3);
    expect(evalExpr('(function f(n) { return n <= 1 ? 1 : n * f(n - 1); })(5)')).toBe(120);
    expect(evalExpr('Math.max(1, 5, 3) + Math.floor(2.7)')).toBe(7);
    expect(evalExpr('null ?? 4')).toBe(4);
    expect(evalExpr('typeof undefinedName')).toBe('undefined');
  });

  it('Schleifen, Closures und Zuweisungsoperatoren', () => {
    const it = new Interp(`
      let sum = 0;
      for (let i = 0; i < 5; i++) { if (i === 3) continue; sum += i; }
      const mk = () => { let c = 0; return () => ++c; };
      const next = mk(); next(); next();
      let k = 0; while (true) { k++; if (k > 3) break; }
      var total = 0; for (const v of [1, 2, 3]) total += v;
    `);
    it.parse();
    it.runTop();
    const g = (n: string): Value => it.global.vars.get(n)?.v;
    expect(g('sum')).toBe(7);
    expect(g('k')).toBe(4);
    expect(g('total')).toBe(6);
    expect(it.call(g('next'), [])).toBe(3);
  });

  it('Schrittgrenze und Aufruftiefe brechen Endlosschleifen/Rekursion ab', () => {
    const loop = new Interp('while (true) {}', {}, { maxSteps: 1000 });
    loop.parse();
    expect(() => loop.runTop()).toThrow(/step limit/);
    const rec = new Interp('function f() { return f(); } f();', {}, { maxDepth: 20 });
    rec.parse();
    expect(() => rec.runTop()).toThrow(/depth/);
  });

  it('kein Zugriff auf Globals, Prototypen oder Konstruktoren (Sandbox)', () => {
    for (const code of [
      'globalThis',
      'window',
      'process',
      'document',
      'fetch("x")',
      'eval("1")',
      'Function("return 1")',
      'this',
      '(() => 1).constructor',
      '({}).__proto__',
      '[].constructor.constructor("return process")()',
      '"abc"["constructor"]',
      'Math.constructor',
    ]) {
      const it = new Interp(`const r = ${code};`);
      it.parse();
      expect(() => it.runTop(), code).toThrow(ScriptError);
    }
  });

  it('Syntaxfehler melden die Zeile', () => {
    const it = new Interp('let a = 1;\nlet b = ;');
    expect(() => it.parse()).toThrow(/line|unexpected/);
    try {
      it.parse();
    } catch (e) {
      expect((e as ScriptError).line).toBe(2);
    }
  });

  it('toStr formatiert Zahlen', () => {
    expect(toStr(1.5)).toBe('1.5');
    expect(toStr(3)).toBe('3');
  });
});

// ------------------------------------------------------------------ Gerät

function sbcLab(code: string, value = 30) {
  const e = new Engine({ seed: 1 });
  const id = e.addDevice('sbc', { name: 'SBC1' });
  e.p5.setIot(id, { value, pattern: 'manual' });
  e.p5.setIotScript(id, code);
  return { e, id };
}

const iotOf = (e: Engine, id: string) => {
  const c = e.getDevice(id)?.config as HostConfig;
  if (!c.iot) throw new Error('iot');
  return c.iot;
};

describe('IoT-Programm auf dem Gerät', () => {
  const PROG = `
    let ticks = 0;
    log('start');
    every(1000, () => {
      ticks++;
      const t = readSensor('self');
      setActuator('self', t > 25);
      log('tick', ticks, 'temp', t);
    });
  `;

  it('every läuft auf virtueller Zeit, Variablen bleiben zwischen den Aktivierungen erhalten', () => {
    const { e, id } = sbcLab(PROG, 30);
    expect(e.p5.runIotScript(id, true).ok).toBe(true);
    e.runUntil(e.state.now + 3_500_000);
    const iot = iotOf(e, id);
    expect(iot.state).toBe('on');
    expect(iot.script?.vars.ticks).toBe(3);
    expect(iot.script?.out.some((l) => l.includes('tick 3 temp 30'))).toBe(true);
    // Messwert ändern: der nächste Takt schaltet den Aktor ab
    e.p5.setIot(id, { value: 20 });
    e.runUntil(e.state.now + 1_000_000);
    expect(iotOf(e, id).state).toBe('off');
    // Stop hält die Ausführung an
    e.p5.runIotScript(id, false);
    const ticks = iotOf(e, id).script?.vars.ticks;
    e.runUntil(e.state.now + 3_000_000);
    expect(iotOf(e, id).script?.vars.ticks).toBe(ticks);
    expect(iotOf(e, id).script?.running).toBe(false);
  });

  it('ist deterministisch und JSON-serialisierbar (Snapshot/Restore)', () => {
    const a = sbcLab(PROG, 30);
    const b = sbcLab(PROG, 30);
    for (const l of [a, b]) {
      l.e.p5.runIotScript(l.id, true);
      l.e.runUntil(l.e.state.now + 5_000_000);
    }
    expect(JSON.stringify(iotOf(a.e, a.id).script)).toBe(JSON.stringify(iotOf(b.e, b.id).script));
    const snap = a.e.snapshot();
    a.e.runUntil(a.e.state.now + 2_000_000);
    const after = iotOf(a.e, a.id).script?.vars.ticks;
    a.e.restore(snap);
    expect(iotOf(a.e, a.id).script?.vars.ticks).toBe(5);
    a.e.runUntil(a.e.state.now + 2_000_000);
    expect(iotOf(a.e, a.id).script?.vars.ticks).toBe(after);
    expect(() => JSON.stringify(a.e.state)).not.toThrow();
  });

  it('ein Skriptfehler (Endlosschleife) lässt nur dieses Gerät abstürzen und schreibt einen Log-Eintrag', () => {
    const { e, id } = sbcLab('every(500, () => { while (true) {} });');
    const id2 = e.addDevice('sbc', { name: 'SBC2' });
    e.p5.setIotScript(id2, 'every(1000, () => { log("alive"); });');
    e.p5.runIotScript(id, true);
    e.p5.runIotScript(id2, true);
    e.runUntil(e.state.now + 3_000_000);
    const bad = e.getDevice(id);
    expect(bad?.crashed?.message).toContain('step limit');
    expect(iotOf(e, id).script?.running).toBe(false);
    expect(iotOf(e, id).script?.error).toContain('step limit');
    expect(e.log.some((l) => l.msg.key === 'iot.script.error' && l.atDeviceName === 'SBC1')).toBe(
      true,
    );
    expect(e.getDevice(id2)?.crashed).toBeUndefined();
    expect(iotOf(e, id2).script?.out.filter((l) => l.includes('alive')).length).toBeGreaterThan(1);
  });

  it('Syntaxfehler beim Start: Fehlermeldung, Gerät markiert', () => {
    const { e, id } = sbcLab('let = ;');
    e.p5.runIotScript(id, true);
    expect(iotOf(e, id).script?.error).toBeTruthy();
    expect(iotOf(e, id).script?.running).toBe(false);
  });

  it('der Aktor wird per Skript auch auf einem entfernten Aktor geschaltet (IoT-Server-Registry)', () => {
    const e = new Engine({ seed: 1 });
    const sbc = e.addDevice('sbc', { name: 'SBC1' });
    const act = e.addDevice('iot-actuator', { name: 'Lamp' });
    const sw = e.addDevice('switch-l2');
    for (const [i, d] of [sbc, act].entries()) {
      const r = e.connect(
        { deviceId: d, portId: 'p0' },
        { deviceId: sw, portId: `p${i}` },
        'straight',
      );
      if (!r.ok) throw new Error(r.error);
    }
    e.setHostIp(sbc, '10.0.0.1', '255.255.255.0');
    e.setHostIp(act, '10.0.0.2', '255.255.255.0');
    const cfg = e.getDevice(sbc)?.config as HostConfig;
    cfg.services.iot = { enabled: true, devices: {}, rules: [] };
    e.p5.setIot(sbc, { server: '10.0.0.1', value: 30 });
    e.p5.setIot(act, { server: '10.0.0.1' });
    e.runUntil(e.state.now + 40_000_000);
    e.p5.setIotScript(sbc, `every(1000, () => { setActuator('Lamp', readSensor('self') > 25); });`);
    e.p5.runIotScript(sbc, true);
    e.runUntil(e.state.now + 5_000_000);
    expect(iotOf(e, act).state).toBe('on');
  });
});
