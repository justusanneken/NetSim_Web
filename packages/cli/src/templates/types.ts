import type { Lab } from './lab';

export interface Bilingual {
  de: string;
  en: string;
}

/** Automatisch prüfbare Aussage über das konvergierte Beispielnetz. */
export interface TemplateCheck {
  kind: 'ping' | 'http';
  /** Name des Quellgeräts (Host). */
  from: string;
  /** Ziel-IPv4-Adresse (Ping) bzw. URL (HTTP). */
  to: string;
  expect: 'ok' | 'fail';
  label: Bilingual;
}

export interface Template {
  id: string;
  level: 'basic' | 'intermediate' | 'advanced';
  title: Bilingual;
  summary: Bilingual;
  goals: { de: string[]; en: string[] };
  /** Virtuelle Sekunden, die nach dem Aufbau simuliert werden, bis das Netz konvergiert ist. */
  settleSec: number;
  build(lab: Lab): void;
  checks: TemplateCheck[];
  /** Zusätzliche Zustandsprüfung (z. B. genau ein STP-Port blockiert); liefert eine Fehlermeldung oder `undefined`. */
  verify?(lab: Lab): string | undefined;
}
