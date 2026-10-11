import type { ScriptResult } from '@netsim/cli';
import { api } from './engine/client';
import type { ScriptDone, ScriptJob } from './engine/script.worker';

/** Wanduhr-Limit für einen Lauf; danach wird der Sandbox-Worker hart beendet. */
export const SCRIPT_TIMEOUT_MS = 12_000;

export type ScriptOutcome =
  | { kind: 'done'; result: ScriptResult }
  | { kind: 'stopped' }
  | { kind: 'timeout' }
  | { kind: 'crash'; message: string };

let current: { worker: Worker; stop: () => void } | undefined;
/** Stopp kam, bevor der Worker existierte (während `scriptBegin`); der Lauf bricht sofort danach ab. */
let stopRequested = false;

/** Bricht den laufenden Skriptlauf ab (Worker terminieren, Netz bleibt unverändert). */
export function stopScript(): void {
  if (current) current.stop();
  else stopRequested = true;
}

/**
 * Führt `code` im Sandbox-Worker auf einer Kopie des Netzes aus und übernimmt anschließend das Ergebnis in die
 * Haupt-Engine. Stop/Timeout verwerfen den Lauf.
 */
export async function runUserScript(code: string): Promise<ScriptOutcome> {
  stopRequested = false;
  const { snapshot, wasRunning } = await api.scriptBegin();
  if (stopRequested) {
    stopRequested = false;
    await api.scriptEnd(null, wasRunning);
    return { kind: 'stopped' };
  }
  const worker = new Worker(new URL('./engine/script.worker.ts', import.meta.url), {
    type: 'module',
  });
  const outcome = await new Promise<ScriptOutcome | { kind: 'ok'; done: ScriptDone }>((resolve) => {
    const timer = setTimeout(() => finish({ kind: 'timeout' }), SCRIPT_TIMEOUT_MS);
    const finish = (o: ScriptOutcome | { kind: 'ok'; done: ScriptDone }): void => {
      clearTimeout(timer);
      worker.terminate();
      current = undefined;
      resolve(o);
    };
    current = { worker, stop: () => finish({ kind: 'stopped' }) };
    worker.onmessage = (ev: MessageEvent<ScriptDone>) => finish({ kind: 'ok', done: ev.data });
    worker.onerror = (ev) => finish({ kind: 'crash', message: ev.message || 'worker error' });
    const job: ScriptJob = { code, snapshot };
    worker.postMessage(job);
  });
  if (outcome.kind === 'ok') {
    await api.scriptEnd({ state: outcome.done.state, log: outcome.done.log }, wasRunning);
    return { kind: 'done', result: outcome.done.result };
  }
  await api.scriptEnd(null, wasRunning);
  return outcome;
}
