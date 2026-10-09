import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_DEVICE_COLORS } from '../src/icons';
import { linkLightShape } from '../src/theme';

/** Liest die Design-Tokens (`--name: #hex`) aus `styles.css`; Dark überschreibt Light. */
function tokens(): { light: Record<string, string>; dark: Record<string, string> } {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const block = (head: string): Record<string, string> => {
    const start = css.indexOf(head);
    const body = css.slice(start, css.indexOf('}', start));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
      out[m[1] as string] = m[2] as string;
    return out;
  };
  const light = block(':root {');
  return { light, dark: { ...light, ...block(":root[data-theme='dark'] {") } };
}

const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
};
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const T = tokens();
const themes = ['light', 'dark'] as const;
const SURFACES = ['bg', 'panel', 'panel-2', 'row-sel'] as const;

describe('Design-Tokens: Kontrast (WCAG AA)', () => {
  for (const th of themes) {
    const t = T[th];
    const c = (n: string): string => t[n] as string;
    it(`${th}: Text ≥ 4.5:1 auf allen Flächen`, () => {
      for (const fg of ['text', 'muted', 'accent', 'ok', 'bad', 'warn'])
        for (const bg of SURFACES) {
          if (bg === 'bg' && fg === 'accent') continue;
          expect(ratio(c(fg), c(bg)), `${fg} auf ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      expect(ratio(c('accent-text'), c('accent-bg')), 'Schaltfläche aktiv').toBeGreaterThanOrEqual(
        4.5,
      );
      expect(ratio(c('on-status'), c('ok')), 'Toast OK').toBeGreaterThanOrEqual(4.5);
      expect(ratio(c('on-status'), c('bad')), 'Toast Fehler').toBeGreaterThanOrEqual(4.5);
      expect(ratio(c('term-fg'), c('term-bg')), 'Terminal').toBeGreaterThanOrEqual(4.5);
    });
    it(`${th}: UI-Grafiken ≥ 3:1 (Linien, Auswahl, Ring der Link-Lichter, Protokollfarben)`, () => {
      for (const g of ['cv-line', 'cv-sel', 'cv-active', 'text'])
        expect(ratio(c(g), c('bg')), `${g} auf Canvas`).toBeGreaterThanOrEqual(3);
      for (const g of ['cv-sel', 'cv-active'])
        expect(ratio(c(g), c('panel')), `${g} auf Karte`).toBeGreaterThanOrEqual(3);
      for (const n of Object.keys(t).filter((k) => k.startsWith('c-')))
        for (const bg of ['bg', 'panel', 'panel-2'])
          expect(ratio(c(n), c(bg)), `${n} auf ${bg}`).toBeGreaterThanOrEqual(3);
    });
    it(`${th}: Umschlag-Symbole (Buchstabe/Klappe) lesbar auf den Protokollfarben`, () => {
      for (const n of ['c-purple', 'c-green', 'c-magenta', 'c-blue'])
        expect(ratio(c('panel'), c(n)), n).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c('panel'), c('link-down')), 'Kreuz auf Fehler-Umschlag').toBeGreaterThanOrEqual(
        3,
      );
    });
    it(`${th}: Gerätesymbole ≥ 3:1 auf Panel, Palette, Canvas, Auswahl`, () => {
      for (const [type, color] of Object.entries(ALL_DEVICE_COLORS[th]))
        for (const bg of SURFACES)
          expect(ratio(color as string, c(bg)), `${type} auf ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }
  it('Farben stehen nur noch als Tokens im Stylesheet (keine rohen Hex-Werte nach den Token-Blöcken)', () => {
    for (const f of ['styles.css', 'phase5.css']) {
      const css = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      const rest = f === 'styles.css' ? css.slice(css.indexOf('\n* {')) : css;
      expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], f).toEqual([]);
    }
  });
});

describe('Farbenblind-Modus: Link-Lichter unterscheiden sich durch die Form', () => {
  it('Kreis = up, Raute = down, Quadrat = STP-blockiert; ohne Modus immer Kreis', () => {
    expect(linkLightShape(true, true, false)).toBe('circle');
    expect(linkLightShape(true, false, false)).toBe('diamond');
    expect(linkLightShape(true, true, true)).toBe('square');
    expect(
      new Set(
        [false, true].flatMap((up) => [false, true].map((b) => linkLightShape(false, up, b))),
      ),
    ).toEqual(new Set(['circle']));
    expect(new Set(['circle', 'diamond', 'square']).size).toBe(3);
  });
});
