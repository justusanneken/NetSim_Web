import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const I18N = join(__dirname, '../src/i18n');
const SRC = join(__dirname, '../src');

const load = (f: string): Record<string, string> =>
  JSON.parse(readFileSync(join(I18N, f), 'utf8')) as Record<string, string>;
const files = readdirSync(I18N).filter((f) => f.endsWith('.json'));
const suffix = (f: string): string => f.replace(/^(de|en)/, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(f)) out.push(p);
  }
  return out;
}

describe('i18n-Vollständigkeit (alle Sprachdateien)', () => {
  const deFiles = files.filter((f) => f.startsWith('de'));
  const enFiles = files.filter((f) => f.startsWith('en'));

  it('zu jeder de-Datei gibt es die en-Datei und umgekehrt', () => {
    expect(enFiles.map(suffix).sort()).toEqual(deFiles.map(suffix).sort());
  });

  for (const d of deFiles) {
    it(`${d}: Schlüssel in de und en identisch`, () => {
      const de = Object.keys(load(d)).sort();
      const en = Object.keys(load('en' + suffix(d))).sort();
      expect(
        en.filter((k) => !de.includes(k)),
        'nur in en',
      ).toEqual([]);
      expect(
        de.filter((k) => !en.includes(k)),
        'nur in de',
      ).toEqual([]);
    });
    it(`${d}: Platzhalter ({{…}}) stimmen in beiden Sprachen überein`, () => {
      const de = load(d);
      const en = load('en' + suffix(d));
      const ph = (s: string): string => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
      for (const k of Object.keys(de)) expect(ph(en[k] ?? ''), k).toBe(ph(de[k] as string));
    });
  }

  it('jede Sprachdatei ist in i18n/index.ts registriert', () => {
    const idx = readFileSync(join(I18N, 'index.ts'), 'utf8');
    for (const f of files) expect(idx, f).toContain(`./${f}`);
  });

  it('kein Schlüssel kommt in zwei Dateien mit unterschiedlichem Text vor', () => {
    const seen = new Map<string, { f: string; v: string }>();
    for (const f of deFiles)
      for (const [k, v] of Object.entries(load(f))) {
        const prev = seen.get(k);
        if (prev && prev.v !== v) throw new Error(`${k} doppelt in ${prev.f} und ${f}`);
        seen.set(k, { f, v });
      }
  });
});

/**
 * Typische deutsche/englische Oberflächenwörter. Technische Literale (IOS-Schlüsselwörter, Protokollnamen,
 * Beispieladressen) sind absichtlich nicht übersetzt und werden nicht gemeldet.
 */
const UI_WORDS = new Set(
  (
    'abbrechen schließen speichern öffnen löschen hinzufügen entfernen übernehmen name status aktiv ' +
    'inaktiv fehler laden bearbeiten gerät geräte kabel adresse einstellungen zurück weiter ja nein ' +
    'cancel close save open delete add remove apply device devices cable address settings error ' +
    'loading edit back next yes no none empty select search filter port ports interface interfaces ' +
    'enable disable enabled disabled power configuration config help about file view tools language ' +
    'konfiguration hilfe datei ansicht extras sprache keine leer auswahl suche aktivieren deaktivieren ' +
    'ein aus an ok'
  ).split(' '),
);
const looksGerman = /[äöüß]/i;

function isUserText(txt: string): boolean {
  if (/[?&=;|]|=>|^\)|^\(/.test(txt)) return false; // JSX-/TS-Fragmente, kein Anzeigetext
  if (looksGerman.test(txt)) return true;
  return txt
    .toLowerCase()
    .split(/[^a-zäöüß]+/)
    .some((w) => UI_WORDS.has(w));
}

describe('keine festen Anzeigetexte in Komponenten', () => {
  const textNode = />\s*([^<>{}\n]*[A-Za-zÄÖÜäöüß]{2,}[^<>{}\n]*?)\s*</g;
  const attr =
    /\b(?:aria-label|title|placeholder|alt|aria-description)="([^"{}]*[A-Za-zÄÖÜäöüß]{2,}[^"{}]*)"/g;
  for (const f of walk(SRC)) {
    const rel = f.slice(SRC.length + 1);
    it(rel, () => {
      const src = readFileSync(f, 'utf8');
      const hits: string[] = [];
      for (const m of src.matchAll(textNode)) {
        const txt = (m[1] as string).trim();
        if (txt && isUserText(txt)) hits.push(txt);
      }
      for (const m of src.matchAll(attr)) if (isUserText(m[1] as string)) hits.push(m[1] as string);
      expect(hits).toEqual([]);
    });
  }
});
