import type { Page } from '@playwright/test';

export interface ContrastIssue {
  selector: string;
  text: string;
  ratio: number;
  need: number;
  fg: string;
  bg: string;
}

export interface ContrastScan {
  /** Anzahl geprüfter Textknoten. */
  checked: number;
  /** Kleinstes gemessenes Verhältnis. */
  min: number;
  issues: ContrastIssue[];
}

/**
 * Misst im Browser für jeden sichtbaren Text das WCAG-Kontrastverhältnis aus berechneter Textfarbe
 * und dem zusammengesetzten Hintergrund aller Vorfahren (inkl. Deckkraft). Deaktivierte Elemente
 * sind nach WCAG ausgenommen. Zusätzlich werden SVG-Symbole (`stroke`/`fill` ≠ none) gegen ihren
 * Hintergrund mit 3:1 geprüft (UI-Grafiken).
 */
export async function scanContrast(page: Page): Promise<ContrastScan> {
  return page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    type RGBA = [number, number, number, number];
    const cache = new Map<string, RGBA>();
    const parse = (css: string): RGBA => {
      const hit = cache.get(css);
      if (hit) return hit;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const v: RGBA = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
      cache.set(css, v);
      return v;
    };
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const ch = (i: 0 | 1 | 2): number =>
        (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [ch(0), ch(1), ch(2), a];
    };
    const lum = (c: RGBA): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: RGBA, b: RGBA): number => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const hex = (c: RGBA): string =>
      '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    const backdrop = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const bg = parse(cs.backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 0.999) break;
      }
      let acc: RGBA = parse(getComputedStyle(document.documentElement).backgroundColor);
      if (acc[3] === 0) acc = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i] as RGBA, acc);
      return acc;
    };
    const opacityOf = (el: Element): number => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement)
        o *= Number(getComputedStyle(n).opacity);
      return o;
    };
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const isDisabled = (el: Element): boolean =>
      !!el.closest(':disabled, [aria-disabled="true"]') ||
      (el.closest('label')?.querySelector(':disabled') != null &&
        el.closest('label')?.querySelector('input,select,textarea,button') ===
          el.closest('label')?.querySelector(':disabled'));
    const sel = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && parts.length < 3; n = n.parentElement) {
        const cls = (n.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
        parts.unshift(n.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      }
      return parts.join(' > ');
    };

    const issues: ContrastIssue[] = [];
    let checked = 0;
    let min = 99;
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!text || !el || seen.has(el)) continue;
      if (['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName)) continue;
      if (!visible(el) || isDisabled(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const op = opacityOf(el);
      const bg = backdrop(el);
      let fg = parse(cs.color);
      fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
      const r = ratio(fg, bg);
      const px = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
      checked++;
      min = Math.min(min, r);
      if (r < need)
        issues.push({
          selector: sel(el),
          text: text.slice(0, 40),
          ratio: Math.round(r * 100) / 100,
          need,
          fg: hex(fg),
          bg: hex(bg),
        });
    }
    // UI-Grafiken: SVG-Symbole außerhalb des Canvas
    for (const s of Array.from(document.querySelectorAll('svg:not([aria-hidden="false"]) path'))) {
      if (!visible(s) || isDisabled(s)) continue;
      const cs = getComputedStyle(s);
      const paint = cs.stroke !== 'none' ? cs.stroke : cs.fill;
      if (!paint || paint === 'none') continue;
      const bg = backdrop(s);
      const fg = over(parse(paint), bg);
      const r = ratio(fg, bg);
      checked++;
      if (r < 3)
        issues.push({
          selector: 'svg path ' + sel(s.closest('svg') ?? s),
          text: '(Symbol)',
          ratio: Math.round(r * 100) / 100,
          need: 3,
          fg: hex(fg),
          bg: hex(bg),
        });
    }
    return { checked, min: Math.round(min * 100) / 100, issues };
  });
}

export interface StructureIssue {
  kind: 'unlabeled' | 'overflow' | 'page-overflow';
  selector: string;
  detail: string;
}

/** Findet unbeschriftete Bedienelemente und horizontale Überläufe (Seite, Dialog, Seitenleiste, Panels). */
export async function scanStructure(page: Page): Promise<StructureIssue[]> {
  return page.evaluate(() => {
    const out: StructureIssue[] = [];
    const sel = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && parts.length < 3; n = n.parentElement) {
        const cls = (n.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
        parts.unshift(n.tagName.toLowerCase() + (cls ? '.' + cls : ''));
      }
      return parts.join(' > ');
    };
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const name = (el: Element): string => {
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by)
        return by
          .split(/\s+/)
          .map((i) => document.getElementById(i)?.textContent ?? '')
          .join(' ')
          .trim();
      if (el.getAttribute('title')?.trim()) return el.getAttribute('title') as string;
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0)
        return Array.from(labels)
          .map((l) => l.textContent ?? '')
          .join(' ')
          .trim();
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab')
        return (el.textContent ?? '').trim();
      return '';
    };
    for (const el of Array.from(
      document.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"]'),
    )) {
      if (!shown(el) || el.closest('.xterm')) continue;
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
      if (!name(el))
        out.push({
          kind: 'unlabeled',
          selector: sel(el),
          detail: (el as HTMLElement).outerHTML.slice(0, 120),
        });
    }
    const root = document.scrollingElement as Element;
    if (root.scrollWidth > window.innerWidth + 1)
      out.push({
        kind: 'page-overflow',
        selector: 'html',
        detail: `${root.scrollWidth} > ${window.innerWidth}`,
      });
    const boxes =
      '.dialog, .dialog-body, .sidebar, .bottom, .sim-panel, .palette, .toolbar, .menubar, .desktop, .device-panel';
    for (const el of Array.from(document.querySelectorAll(boxes))) {
      if (!shown(el)) continue;
      const cs = getComputedStyle(el);
      const clipsX = cs.overflowX === 'visible' || cs.overflowX === 'hidden';
      if (clipsX && el.scrollWidth > el.clientWidth + 1)
        out.push({
          kind: 'overflow',
          selector: sel(el),
          detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`,
        });
    }
    return out;
  });
}
