import type { Engine } from '@netsim/engine';

/** Simuliert, bis `done()` gilt (CLI-Befehle laufen im Vorlauf der virtuellen Zeit). */
export function waitFor(e: Engine, done: () => boolean, maxEvents = 500_000): void {
  let n = 0;
  while (!done() && e.queueLength > 0 && n++ < maxEvents) e.step();
}
