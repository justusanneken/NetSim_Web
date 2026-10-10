import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { runScript } from '../src';

const OSPF_LAB = `
const names = ['R1', 'R2', 'R3'];
const r = names.map((n, i) => network.addDevice('router', n, 100 + i * 200, 100));
network.connect('R1', 'Gi0/0', 'R2', 'Gi0/0');
network.connect('R2', 'Gi0/1', 'R3', 'Gi0/0');
const cfg = [
  ['R1', ['10.0.12.1', '1.1.1.1'], null],
  ['R2', ['10.0.12.2', '2.2.2.2'], '10.0.23.2'],
  ['R3', ['10.0.23.3', '3.3.3.3'], null]
];
function setup(name, ip0, ip1, rid) {
  const d = network.getDevice(name);
  d.cli.run('configure terminal');
  d.cli.run('interface gi0/0');
  d.cli.run('ip address ' + ip0 + ' 255.255.255.0');
  d.cli.run('no shutdown');
  if (ip1) {
    d.cli.run('interface gi0/1');
    d.cli.run('ip address ' + ip1 + ' 255.255.255.0');
    d.cli.run('no shutdown');
  }
  d.cli.run('router ospf 1');
  d.cli.run('router-id ' + rid);
  d.cli.run('network 10.0.0.0 0.255.255.255 area 0');
  d.cli.run('end');
}
setup('R1', '10.0.12.1', null, '1.1.1.1');
setup('R2', '10.0.12.2', '10.0.23.2', '2.2.2.2');
setup('R3', '10.0.23.3', null, '3.3.3.3');
const ok = engine.runUntil(() => network.getDevice('R1').cli.run('show ip route').includes('10.0.23.0'), 120000);
log('converged', ok);
log(network.getDevice('R1').cli.run('show ip route'));
`;

describe('Scripting-API', () => {
  it('baut ein OSPF-Labor, wartet auf Konvergenz und verifiziert', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(e, OSPF_LAB);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.output[0]).toBe('converged true');
    expect(r.output[1]).toContain('O        10.0.23.0');
    expect(Object.keys(e.state.devices)).toHaveLength(3);
  });

  it('ist deterministisch: gleicher Seed und gleiches Skript ⇒ identische Ausgabe und identisches Log', () => {
    const run = () => {
      const e = new Engine({ seed: 7 });
      const r = runScript(e, OSPF_LAB);
      return { r, log: e.logSlice(0, 100000).map((l) => `${l.t} ${l.atDeviceName} ${l.msg.key}`) };
    };
    const a = run();
    const b = run();
    expect(a.r.output).toEqual(b.r.output);
    expect(a.r.steps).toBe(b.r.steps);
    expect(a.r.simMs).toBe(b.r.simMs);
    expect(a.log).toEqual(b.log);
    expect(a.log.length).toBeGreaterThan(50);
  });

  it('Ping-Sweep: device.ping liefert Ergebnisobjekte', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(
      e,
      `
const sw = network.addDevice('switch-l2', 'SW1');
for (let i = 1; i <= 3; i++) {
  const pc = network.addDevice('pc', 'PC' + i);
  network.connect(pc, 0, sw, i - 1);
  pc.setIp('10.0.0.' + i, '255.255.255.0');
}
const pc1 = network.getDevice('PC1');
engine.runFor(35000);
const alive = [];
for (let i = 2; i <= 5; i++) {
  const res = pc1.ping('10.0.0.' + i);
  if (res.ok) alive.push(i);
}
log('alive', alive.join(','));
log(network.devices().length, network.links().length);
`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output).toEqual(['alive 2,3', '4 3']);
  });

  it('onPacket und onLinkChange liefern Ereignisse während der Simulation', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(
      e,
      `
let arp = 0, icmp = 0, ups = 0;
onPacket(function (p) { if (p.proto === 'ARP') arp++; if (p.proto === 'ICMP') icmp++; });
onLinkChange(function (l) { if (l.up) ups++; });
const a = network.addDevice('pc', 'A');
const b = network.addDevice('pc', 'B');
network.connect(a, 0, b, 0, 'crossover');
a.setIp('10.0.0.1', '255.255.255.0');
b.setIp('10.0.0.2', '255.255.255.0');
a.ping('10.0.0.2');
log('arp', arp, 'icmp', icmp, 'ups', ups);
`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output).toEqual(['arp 4 icmp 2 ups 2']);
  });

  it('engine.step/now/runFor/runUntil und print()', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(
      e,
      `
const t0 = engine.now();
engine.runFor(1500);
print(engine.now() - t0);
print(engine.step());
network.addDevice('switch-l2', 'S');
print(engine.step());
const never = engine.runUntil(function () { return false; }, 2000);
print(never);
print({ a: 1, b: [1, 2] }, [1, 'x'], null, undefined, true);
`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output.slice(0, 4)).toEqual(['1500', 'false', 'true', 'false']);
    expect(r.output[4]).toBe('{"a":1,"b":[1,2]} [1,"x"] null undefined true');
  });

  it('Fehler im Skript: Meldung mit Zeilennummer', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(e, `log('x');\nnetwork.addDevice('toaster', 'T');`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown device type 'toaster'/);
    expect(r.output).toEqual(['x']);
  });

  it('unbekannte Geräte/Ports werden gemeldet', () => {
    const e = new Engine({ seed: 1 });
    expect(runScript(e, `network.connect('A', 0, 'B', 0)`).error).toMatch(/unknown device/);
    expect(
      runScript(e, `const a = network.addDevice('pc','A'); network.connect(a, 'Nope', a, 0)`).error,
    ).toMatch(/unknown port/);
    expect(runScript(e, `network.addDevice('pc','A')`).error).toMatch(/already in use/);
    expect(runScript(e, `network.getDevice('zzz').name`).error).toBeDefined();
  });

  it('getDevice liefert null für unbekannte Namen; connect meldet Kabelfehler als Ergebnis', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(
      e,
      `
log(network.getDevice('nope'));
const a = network.addDevice('pc', 'A');
const b = network.addDevice('pc', 'B');
const first = network.connect(a, 0, b, 0);
const second = network.connect(a, 0, b, 0);
log(first.ok, second.ok, typeof second.error);
log(a.ports()[0].name, a.ip(), a.routes().length);
network.removeDevice('B');
log(network.devices().length);
`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output[0]).toBe('null');
    expect(r.output[1]).toBe('true false string');
    expect(r.output[3]).toBe('1');
  });
});

describe('Scripting-API: Sandbox', () => {
  const run = (code: string, opts = {}) => runScript(new Engine({ seed: 1 }), code, opts);

  it('Endlosschleife wird durch das Schrittlimit beendet', () => {
    const r = run('while (true) {}', { maxSteps: 50_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/step limit exceeded/);
  });

  it('Wanduhr-Limit beendet Skripte, die zu lange laufen', () => {
    let t = 0;
    const r = run('let i = 0; while (true) { i++; }', {
      maxWallMs: 100,
      clock: () => (t += 50),
      maxSteps: 100_000_000,
    });
    expect(r.error).toMatch(/time limit exceeded/);
  });

  it('Ereignis- und Simulationszeitlimit', () => {
    expect(run('engine.runFor(100000000)', { maxSimMs: 1000 }).error).toMatch(
      /simulation time limit/,
    );
    expect(run('for (;;) { engine.step(); }', { maxEvents: 500 }).error).toMatch(/event limit/);
    expect(
      run('engine.runUntil(function () { return false; }, 1e12)', { maxSimMs: 5000 }).error,
    ).toMatch(/simulation time limit/);
  });

  it('Ausgabe wird begrenzt', () => {
    const r = run('for (let i = 0; i < 100; i++) log(i);', { maxOutputLines: 10 });
    expect(r.output).toHaveLength(11);
    expect(r.output[10]).toMatch(/truncated/);
  });

  it.each([
    ['eval', `eval('1+1')`],
    ['Function-Konstruktor', `(function(){}).constructor('return 1')()`],
    ['constructor-Kette', `network.constructor`],
    ['__proto__', `({}).__proto__`],
    ['prototype', `network.addDevice.prototype`],
    ['Function', `Function('return this')()`],
    ['globalThis', `globalThis.process`],
    ['process', `process.exit(1)`],
    ['require', `require('fs')`],
    ['import', `import('fs')`],
    ['fetch', `fetch('http://example.com')`],
    ['XMLHttpRequest', `new XMLHttpRequest()`],
    ['WebSocket', `new WebSocket('ws://x')`],
    ['importScripts', `importScripts('x.js')`],
    ['document', `document.cookie`],
    ['window', `window.location`],
    ['self', `self.postMessage(1)`],
    ['setTimeout', `setTimeout(function(){}, 0)`],
    ['Date', `Date.now()`],
    ['Math.random', `Math.random()`],
    ['this', `this.constructor`],
    ['String-Konstruktor', `String.constructor`],
    ['Object-Konstruktor', `Object.keys({}).constructor`],
  ])('Sandbox-Ausbruch scheitert: %s', (_n, code) => {
    const r = run(code);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('Host-Objekte geben keinen Zugriff auf Prototypen oder Engine-Interna', () => {
    const e = new Engine({ seed: 1 });
    const r = runScript(
      e,
      `
const d = network.addDevice('pc', 'A');
const keys = Object.keys(d);
log(keys.join(','));
log(typeof d.state, typeof d.config, typeof network.engine, typeof engine.state, typeof engine.getDevice);
`,
    );
    expect(r.error).toBeUndefined();
    expect(r.output[1]).toBe('undefined undefined undefined undefined undefined');
    expect(r.output[0]).not.toMatch(/state|config/);
  });

  it('Skripte können Host-Funktionen nicht überschreiben und verändern den Prototyp nicht', () => {
    const before = Object.keys(Object.prototype).length;
    const r = run(`const o = {}; o['__proto__'] = { x: 1 };`);
    expect(r.ok).toBe(false);
    expect(Object.keys(Object.prototype).length).toBe(before);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(run(`network = 1`).ok).toBe(false);
  });

  it('Rekursion wird begrenzt (kein Stack-Überlauf)', () => {
    const r = run('function f(n) { return f(n + 1); } f(0);');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/depth|stack/);
  });

  it('riesige Strings und Arrays werden begrenzt', () => {
    expect(run(`let s = 'x'; while (true) { s = s + s; }`).error).toMatch(/too long/);
    expect(run(`const a = []; while (true) { a.push(1); }`).error).toMatch(/too large/);
    expect(run(`'abc'.repeat(1e9)`).error).toMatch(/too long/);
  });

  it('device.cli.run auf Gerät ohne CLI schlägt kontrolliert fehl', () => {
    const r = run(`const c = network.addDevice('cloud', 'C'); c.cli.run('x')`);
    expect(r.error).toMatch(/no command line/);
  });
});
