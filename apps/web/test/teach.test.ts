import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_FAIL_KEYS } from '@netsim/engine';
import de from '../src/i18n/de.teach.json';
import en from '../src/i18n/en.teach.json';
import {
  CHECK_TYPES,
  DEFS,
  ITEMS,
  ITEM_DEFS,
  ROUTE_SOURCES,
  blank,
  build,
  toRaw,
} from '../src/teach/authorDefs';

const deD = de as Record<string, string>;
const enD = en as Record<string, string>;
const engineSrc = (f: string): string =>
  readFileSync(join(__dirname, '../../../packages/engine/src/teach', f), 'utf8');
const has = (k: string): boolean => k in deD && k in enD;

describe('Lehr-Werkzeuge: Übersetzungen', () => {
  it('de und en haben gleiche Schlüssel und Platzhalter', () => {
    expect(Object.keys(enD).sort()).toEqual(Object.keys(deD).sort());
    const ph = (s: string): string[] =>
      [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string).sort();
    for (const k of Object.keys(deD)) expect(ph(enD[k] as string), k).toEqual(ph(deD[k] as string));
  });

  it('alle Prüf-Fehlergründe sind übersetzt', () => {
    expect(CHECK_FAIL_KEYS.length).toBeGreaterThan(40);
    for (const k of CHECK_FAIL_KEYS) expect(has(`check.fail.${k}`), k).toBe(true);
  });

  it('alle Challenge-Texte (Fragen, Optionen, Erklärungen) sind übersetzt', () => {
    const src = engineSrc('challenge.ts');
    const need = new Set<string>();
    for (const m of src.matchAll(/[^a-zA-Z.]q\(\s*'([\w.]+)'/g)) need.add(`challenge.q.${m[1]}`);
    for (const m of src.matchAll(/[^a-zA-Z.]O\(\s*'(\w+)'/g)) need.add(`challenge.o.${m[1]}`);
    for (const m of src.matchAll(/[^a-zA-Z.]e\(\s*'([\w.]+)'/g)) need.add(`challenge.e.${m[1]}`);
    // zusammengesetzte Schlüssel
    for (const a of ['forward', 'flood', 'filter', 'drop']) need.add(`challenge.e.sw.action.${a}`);
    for (const a of ['bcast', 'mcast', 'unknown']) need.add(`challenge.e.sw.floodReason.${a}`);
    for (const a of ['vlanNotAllowed', 'noVlan', 'stpBlocked', 'taggedOnAccess', 'outDown'])
      need.add(`challenge.e.sw.dropReason.${a}`);
    for (const a of ['tcp', 'udp']) need.add(`challenge.e.host.closedPort.${a}`);
    for (const a of ['direct', 'hop']) need.add(`challenge.e.rt.nexthop.${a}`);
    for (const a of ['yes', 'no']) need.add(`challenge.e.rt.arp.${a}`);
    expect(need.size).toBeGreaterThan(100);
    expect([...need].filter((k) => !has(k))).toEqual([]);
  });

  it('Meldungen der Lehr-Module (Fehler/Hinweise) sind übersetzt', () => {
    const keys = new Set<string>();
    for (const f of ['pdu.ts', 'scenario.ts', 'service.ts', 'activity.ts']) {
      for (const m of engineSrc(f).matchAll(/'((?:pdu|scenario|activity)\.err\.\w+)'/g))
        keys.add(m[1] as string);
    }
    expect(keys.size).toBeGreaterThan(10);
    expect([...keys].filter((k) => !has(k))).toEqual([]);
  });

  it('Autorenformular: alle Typen, Punkte und Felder haben Texte', () => {
    const need = new Set<string>();
    for (const t of CHECK_TYPES) {
      need.add(`author.type.${t}`);
      need.add(
        `check.label.${t === 'config' ? 'config.hostname' : t === 'ifaceState' ? 'ifaceUp' : t === 'vlanExists' ? 'vlan' : t}`,
      );
      for (const f of DEFS[t]) need.add(`author.f.${f.name}`);
    }
    for (const i of ITEMS) {
      need.add(`author.item.${i}`);
      need.add(`check.label.config.${i}`);
      for (const f of ITEM_DEFS[i]) need.add(`author.f.${f.name}`);
    }
    for (const s of ROUTE_SOURCES) need.add(`check.source.${s}`);
    for (const k of ['item', 'weight', 'hint', 'label']) need.add(`author.f.${k}`);
    expect([...need].filter((k) => !has(k))).toEqual([]);
  });
});

describe('Autorenformular: Umwandlung', () => {
  it('Eingabetexte werden typgerecht zu Prüfungen', () => {
    const raw = {
      ...blank('trunk'),
      device: 'SW1',
      port: 'Gi0/1',
      native: '99',
      allowed: '10, 20 30',
      weight: '2',
      hint: ' Tipp ',
    };
    expect(build(raw, 'c1')).toEqual({
      id: 'c1',
      type: 'trunk',
      device: 'SW1',
      port: 'Gi0/1',
      native: 99,
      allowed: [10, 20, 30],
      weight: 2,
      hint: 'Tipp',
    });
    const cfg = {
      ...blank('config'),
      device: 'R1',
      spec: { item: 'aclEntry', acl: '101', action: 'deny', dstPort: '80', protocol: '' },
    };
    expect(build(cfg, 'c2')).toEqual({
      id: 'c2',
      type: 'config',
      device: 'R1',
      spec: { item: 'aclEntry', acl: '101', action: 'deny', dstPort: 80 },
    });
    expect(build({ ...blank('ifaceState'), device: 'R1', iface: 'Gi0/0' }, 'c3')).toMatchObject({
      up: true,
    });
    expect(build({ ...blank('ping'), from: 'A', to: 'B' }, 'c4')).toMatchObject({
      expect: 'success',
    });
  });

  it('toRaw macht aus typisierten Prüfungen Eingabetexte (und zurück)', () => {
    const c = {
      id: 'x',
      type: 'trunk',
      device: 'SW',
      port: 'Gi0/1',
      allowed: [10, 20],
      weight: 2,
      hint: { de: 'a', en: 'b' },
    };
    const raw = toRaw(c);
    expect(raw).toMatchObject({ allowed: '10,20', weight: '2', hint: 'a' });
    expect(build(raw, 'x')).toMatchObject({ allowed: [10, 20], weight: 2 });
  });
});
