import type { Theme } from './store';

/** Setzt Design und Farbenblind-Modus als Attribute auf `<html>`; alle Farben kommen aus den CSS-Tokens. */
export function applyTheme(theme: Theme, colorblind: boolean): void {
  const el = document.documentElement;
  if (el.dataset.theme !== theme) el.dataset.theme = theme;
  const cb = colorblind ? '1' : '0';
  if (el.dataset.colorblind !== cb) el.dataset.colorblind = cb;
}

/** Farben, die Konva (Canvas) als konkrete Werte braucht – gelesen aus den CSS-Tokens (`styles.css`). */
export interface CanvasColors {
  grid: string;
  text: string;
  card: string;
  line: string;
  sel: string;
  active: string;
  up: string;
  down: string;
  stp: string;
  blink: string;
  ring: string;
  wifi24: string;
  wifi5: string;
  proto: Record<string, string>;
  protoDefault: string;
  bad: string;
  onBad: string;
}

const PROTO_TOKEN: Record<string, string> = {
  ARP: '--c-purple',
  ICMP: '--c-green',
  CSMA: '--c-magenta',
  ETH: '--c-blue',
};

/** Liest die Canvas-Tokens des aktuellen Designs; `applyTheme` muss vorher gelaufen sein. */
export function readCanvasColors(theme: Theme, colorblind: boolean): CanvasColors {
  applyTheme(theme, colorblind);
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    grid: v('--cv-grid'),
    text: v('--text'),
    card: v('--panel'),
    line: v('--cv-line'),
    sel: v('--cv-sel'),
    active: v('--cv-active'),
    up: v('--link-up'),
    down: v('--link-down'),
    stp: v('--link-stp'),
    blink: v('--link-blink'),
    ring: v('--text'),
    wifi24: v('--c-blue'),
    wifi5: v('--c-purple'),
    proto: Object.fromEntries(Object.entries(PROTO_TOKEN).map(([k, t]) => [k, v(t)])),
    protoDefault: v('--accent'),
    bad: v('--bad'),
    onBad: v('--on-status'),
  };
}

export type LightShape = 'circle' | 'diamond' | 'square';

/**
 * Form des Link-Lichts. Ohne Farbenblind-Modus immer Kreis; im Modus: Kreis = up,
 * Raute = down, Quadrat = STP-blockiert (Zustand nie nur über die Farbe).
 */
export function linkLightShape(
  colorblind: boolean,
  operUp: boolean,
  stpBlocked: boolean,
): LightShape {
  if (!colorblind) return 'circle';
  if (!operUp) return 'diamond';
  return stpBlocked ? 'square' : 'circle';
}
