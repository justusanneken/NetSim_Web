/// <reference lib="webworker" />
import { Engine, type EngineSnapshot, type LogEntry } from '@netsim/engine';
import { runScript, type ScriptResult } from '@netsim/cli';

/**
 * Sandbox-Worker des Skript-Konsole: arbeitet auf einer privaten Kopie des Engine-Zustands, hat weder DOM noch
 * Zugriff auf den Haupt-Engine-Worker und kann vom Hauptthread jederzeit mit `terminate()` beendet werden (Stop,
 * CPU-Zeitlimit). Das Skript selbst läuft im Sandbox-Interpreter (kein `eval`).
 */
export interface ScriptJob {
  code: string;
  snapshot: EngineSnapshot;
}
export interface ScriptDone {
  result: ScriptResult;
  state: EngineSnapshot['state'];
  log: LogEntry[];
}

const MAX_LOG = 20_000;

self.onmessage = (ev: MessageEvent<ScriptJob>) => {
  const { code, snapshot } = ev.data;
  const engine = new Engine({ seed: snapshot.state.seed });
  engine.restore(snapshot);
  engine.logOffset = snapshot.logLength;
  const result = runScript(engine, code);
  const done: ScriptDone = { result, state: engine.state, log: engine.log.slice(-MAX_LOG) };
  (self as unknown as Worker).postMessage(done);
};
