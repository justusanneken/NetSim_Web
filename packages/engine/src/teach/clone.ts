import { Engine } from '../engine';

type SigHolder = { switchSig: Map<string, string> };

/**
 * Tiefe Kopie einer Engine (Zustand + Log-Position). Dient Pruefungen und Aufgaben: Verkehr wird auf der
 * Kopie simuliert, die laufende Simulation bleibt unberuehrt. Die Kopie ist deterministisch – gleicher
 * Zustand ergibt gleiches Verhalten (der RNG-Zustand ist Teil des Zustands).
 */
export function cloneEngine(src: Engine): Engine {
  const e = new Engine({ seed: src.state.seed, config: src.state.config });
  e.state = structuredClone(src.state);
  e.logOffset = src.logLength;
  // Signaturen der Switch-Konfiguration mitnehmen: sonst loest der naechste Link-Refresh einen
  // STP-Neuaufbau aus und die Kopie verhielte sich anders als das Original.
  const from = (src as unknown as SigHolder).switchSig;
  const to = (e as unknown as SigHolder).switchSig;
  for (const [k, v] of from) to.set(k, v);
  return e;
}

/**
 * Ersetzt den Zustand einer Engine durch einen gespeicherten (Aufgabe laden): Laufzeitzustand wird neu
 * aufgebaut (Zeit 0, leere Tabellen, Hintergrund-Timer). Entspricht `Engine.loadState` der Persistenz.
 */
export function loadStateInto(e: Engine, state: Engine['state']): void {
  e.state = structuredClone(state);
  (e as unknown as SigHolder).switchSig.clear();
  e.resetRuntime();
  e.p5.wirelessSync();
}

/** Frische Engine aus einem gespeicherten Zustand (JSON); der Zustand wird kopiert. */
export function engineFromState(state: Engine['state']): Engine {
  const e = new Engine({ seed: state.seed, config: state.config });
  loadStateInto(e, state);
  return e;
}
