import { describe, expect, it } from 'vitest';
import {
  buildDevices,
  buildLinks,
  Engine,
  exportNsim,
  importNsim,
  parseNsimJson,
  TeachService,
  type NsimDoc,
} from '@netsim/engine';
import { CliSession, exampleActivities } from '../src';
import { fullLab } from './qa3Lab';

/**
 * QA3: feindliche `.nsim`-Dateien. Jeder Konfigurationsknoten der neuen Funktionen wird durch
 * Werte falschen Typs ersetzt. Erwartung: Import lehnt ab – oder die Engine bleibt bedienbar
 * (Ansicht, Simulation, `show`-Befehle werfen nicht; Geräteausnahmen enden höchstens in „crashed“).
 */

/** Je Originaltyp zwei Werte mit falschem Grundtyp (hält die Laufzeit klein). */
function hostile(orig: unknown): unknown[] {
  if (Array.isArray(orig)) return ['x', { a: 1 }];
  if (isObj(orig)) return ['x', [{}]];
  if (typeof orig === 'string') return [1e9, {}];
  if (typeof orig === 'number') return ['x', null];
  return ['x', []];
}

type Plain = Record<string, unknown>;
const isObj = (x: unknown): x is Plain => typeof x === 'object' && x !== null;

/** Pfade aller Knoten (Teilbäume und Blätter) unterhalb von `root`, ohne Port-Wiederholungen. */
function paths(root: unknown, max = 6): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  const walk = (x: unknown, p: string[]): void => {
    if (p.length > max) return;
    // Port-/Schnittstellen-Ids zusammenfassen (p0, p1 … verhalten sich gleich)
    const key = p.map((s) => (/^(p|gi|fa|se)?\d+$/.test(s) ? '#' : s)).join('.');
    if (p.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
    if (!isObj(x)) return;
    for (const k of Object.keys(x)) walk((x as Plain)[k], [...p, k]);
  };
  walk(root, []);
  return out;
}

function get(root: unknown, p: string[]): unknown {
  let cur = root;
  for (const k of p) cur = (cur as Plain)[k];
  return cur;
}

function setAt(doc: Plain, p: string[], v: unknown): void {
  let cur: unknown = doc;
  for (const k of p.slice(0, -1)) cur = (cur as Plain)[k];
  (cur as Plain)[p[p.length - 1] as string] = v;
}

const SHOWS = [
  'show running-config',
  'show cdp neighbors',
  'show cdp neighbors detail',
  'show lldp neighbors',
  'show ip dhcp snooping',
  'show ip dhcp snooping binding',
  'show ip arp inspection',
  'show storm-control',
  'show errdisable recovery',
  'show interfaces serial0/0/0',
  'show controllers serial0/0/0',
  'show ip ospf interface',
  'show ip route',
  'show ip route 10.5.0.1',
  'show logging',
  'show policy-map interface',
  'show ipv6 access-list',
  'show access-lists',
  'show ntp associations',
  'show snmp user',
  'show ip ssh',
  'show interfaces',
];

/** Alles, was die Oberfläche und die CLI mit dem importierten Zustand tun. */
let stage = '';
function exercise(e: Engine): void {
  stage = 'view';
  buildDevices(e);
  buildLinks(e);
  stage = 'run';
  e.runUntil(e.state.now + 40_000_000);
  stage = 'view2';
  buildDevices(e);
  for (const id of Object.keys(e.state.devices)) {
    const d = e.getDevice(id);
    if (d?.config.kind !== 'router' && d?.config.kind !== 'switch') continue;
    const s = new CliSession(e, id);
    s.input('enable');
    for (const c of SHOWS) {
      stage = c;
      s.input(c);
    }
  }
}

describe('QA3: feindliche .nsact-Aufgaben', () => {
  const base = (): Plain =>
    structuredClone(
      exampleActivities().find((a) =>
        Object.values(a.start.devices).some((d) => d.config.kind === 'router'),
      ),
    ) as unknown as Plain;
  const firstRouter = (st: Plain): Plain =>
    Object.values(st.devices as Plain).find(
      (d) => ((d as Plain).config as Plain).kind === 'router',
    ) as Plain;

  it('Konfiguration mit falschen Typen, kaputte Links: Ablehnung, Netz bleibt erhalten', () => {
    const bad: ((a: Plain) => void)[] = [
      (a) => ((firstRouter(a.start as Plain).config as Plain).qos = 'x'),
      (a) => ((firstRouter(a.start as Plain).config as Plain).ifaces = 5),
      (a) => (((firstRouter(a.start as Plain).config as Plain).sys as Plain).mgmt = 'x'),
      (a) => (firstRouter(a.start as Plain).ports = [{}]),
      (a) => {
        const l = Object.values((a.start as Plain).links as Plain)[0] as Plain | undefined;
        if (l) (l.a as Plain).deviceId = 'nope';
        else (a.start as Plain).links = { x: { id: 'x', a: { deviceId: 'nope', portId: 'p0' } } };
      },
    ];
    for (const [i, mutate] of bad.entries()) {
      const a = base();
      mutate(a);
      const svc = new TeachService(1);
      const pc = svc.addDevice('pc', { x: 10, y: 10 });
      let r: ReturnType<TeachService['activityLoad']> | undefined;
      expect(() => (r = svc.activityLoad(a)), `#${i}`).not.toThrow();
      expect(r?.ok, `#${i}`).toBe(false);
      expect(svc.engine.getDevice(pc), `#${i}: Netz verworfen`).toBeDefined();
    }
  });

  it('gültige Aufgabe: bereinigter Startzustand lädt und lässt sich auswerten', () => {
    const svc = new TeachService(1);
    // Laufzeitdaten (Warteschlange) werden verworfen, nicht ausgeführt
    const a = base();
    (a.start as Plain).queue = [{ t: 'x', kind: 1 }];
    const r = svc.activityLoad(a);
    expect(r.ok).toBe(true);
    expect(svc.activityCheck().ok).toBe(true);
    expect(() => svc.engine.runUntil(svc.engine.state.now + 5_000_000)).not.toThrow();
  });
});

describe('QA3: feindliche .nsim-Importe der neuen Konfigurationstypen', () => {
  it('jeder Knoten mit falschem Typ: Ablehnung oder bedienbare Engine', () => {
    const { e } = fullLab();
    e.runUntil(e.state.now + 5_000_000);
    const base = exportNsim(e) as unknown as Plain;
    const failures: string[] = [];
    const states = base.deviceStates as Plain;
    let imported = 0;
    for (const devId of Object.keys(states)) {
      for (const p of paths(states[devId])) {
        for (const v of hostile(get(states[devId], p))) {
          const doc = structuredClone(base);
          setAt(doc, ['deviceStates', devId, ...p], structuredClone(v));
          const parsed = parseNsimJson(JSON.stringify(doc));
          if (!parsed.ok) continue;
          const e2 = new Engine({ seed: 1 });
          stage = 'import';
          try {
            if (!importNsim(e2, parsed.value as NsimDoc).ok) continue;
            imported++;
            exercise(e2);
          } catch (err) {
            failures.push(
              `[${stage}] ${devId}.${p.join('.')} = ${JSON.stringify(v)}: ${String(err)}`,
            );
          }
        }
      }
    }
    expect(imported).toBeGreaterThan(0);
    expect(failures.slice(0, 40)).toEqual([]);
  }, 600_000);
});
