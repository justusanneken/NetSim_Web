import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import de0 from '../src/i18n/de.json';
import en0 from '../src/i18n/en.json';
import de5 from '../src/i18n/de.phase5.json';
import en5 from '../src/i18n/en.phase5.json';
import deProto from '../src/i18n/de.proto.json';
import enProto from '../src/i18n/en.proto.json';
import deT from '../src/i18n/de.tcp.json';
import enT from '../src/i18n/en.tcp.json';
import deUx from '../src/i18n/de.ux.json';
import enUx from '../src/i18n/en.ux.json';

import deCcna from '../src/i18n/de.ccna.json';
import enCcna from '../src/i18n/en.ccna.json';
import deWan from '../src/i18n/de.wan.json';
import enWan from '../src/i18n/en.wan.json';

const de: Record<string, string> = {
  ...de0,
  ...de5,
  ...deT,
  ...deProto,
  ...deUx,
  ...deCcna,
  ...deWan,
};
const en: Record<string, string> = {
  ...en0,
  ...en5,
  ...enT,
  ...enProto,
  ...enUx,
  ...enCcna,
  ...enWan,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf8');
const keysOf = (o: Record<string, string>): string[] => Object.keys(o).sort();

describe('i18n', () => {
  it('de und en haben identische Schlüssel', () => {
    expect(keysOf(en)).toEqual(keysOf(de));
  });

  it('keine leeren Übersetzungen', () => {
    for (const dict of [de, en] as Record<string, string>[]) {
      for (const [k, v] of Object.entries(dict)) expect(v.trim(), k).not.toBe('');
    }
  });

  it('alle in der UI verwendeten Schlüssel existieren', () => {
    const used = new Set<string>();
    for (const f of walk(join(__dirname, '../src'))) {
      for (const m of read(f).matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1] as string);
      for (const m of read(f).matchAll(
        /(?:key|label)(?:Key)?:\s*'((?:menu|tool|toast|hint)\.[^']+)'/g,
      ))
        used.add(m[1] as string);
      for (const m of read(f).matchAll(/showToast\(\s*'([^']+)'/g)) used.add(m[1] as string);
    }
    // dynamische Schlüssel
    ['pc', 'laptop', 'server', 'router', 'switch-l2', 'switch-l3', 'hub'].forEach((d) =>
      used.add(`device.${d}`),
    );
    ['config', 'cli', 'desktop'].forEach((d) => used.add(`dialog.tab.${d}`));
    ['auto', 'straight', 'crossover'].forEach((c) => used.add(`cable.${c}`));
    ['end', 'network', 'cables'].forEach((c) => used.add(`palette.cat.${c}`));
    ['pending', 'reply', 'timeout', 'unreachable', 'failed'].forEach((s) =>
      used.add(`ping.status.${s}`),
    );
    [1, 2, 3, 4, 5, 6, 7].forEach((n) => used.add(`osi.${n}`));
    ['file', 'edit', 'options', 'view', 'tools', 'help', 'language'].forEach((m) =>
      used.add(`menu.${m}`),
    );
    const missing = [...used].filter((k) => !(k in de));
    expect(missing).toEqual([]);
  });

  it('alle Engine-Nachrichten und Fehlercodes sind übersetzt', () => {
    const root = join(__dirname, '../../../packages/engine/src');
    const keys = new Set<string>();
    for (const f of walk(root)) {
      const src = read(f);
      for (const m of src.matchAll(/\bkey:\s*'([a-z][\w.]*)'/g)) keys.add(m[1] as string);
      for (const m of src.matchAll(/error:\s*'([a-z][\w.]*)'/g)) keys.add(m[1] as string);
      for (const m of src.matchAll(/(?:rejectKey|problemKey|reject|down)\(?\s*'([a-z][\w.]+)'/g))
        keys.add(m[1] as string);
      for (const m of src.matchAll(/'((?:cable|link|ip|ping)\.[\w.]+)'/g)) keys.add(m[1] as string);
    }
    // Schlüssel mit Suffix `.learned` werden dynamisch gebildet
    ['switch.filter', 'switch.unicast', 'switch.flood'].forEach((k) => keys.add(k + '.learned'));
    const missing = [...keys].filter((k) => !(k in de) && !k.endsWith('.'));
    expect(missing).toEqual([]);
  });
});
