import type { LogEntry } from '@netsim/engine';

/** Lokale Kopie des Engine-Logs: `log[i].id === base + i` (die Engine trimmt alte Einträge). */
export interface LogWindow {
  log: LogEntry[];
  /** Id des ersten Eintrags in `log`. */
  base: number;
}

export interface LogSyncView {
  logLength: number;
  logStart?: number;
}

/**
 * Bringt die lokale Log-Kopie inkrementell auf den Stand des ViewModels.
 * `reset` (neue Epoche: Step Back, Reset, neues Netz) verwirft die Kopie; vom Engine-Trimmen
 * entfernte Einträge werden ebenfalls verworfen, damit der Speicher auf der UI-Seite begrenzt bleibt.
 */
export async function syncLogWindow(
  cur: LogWindow,
  v: LogSyncView,
  reset: boolean,
  fetchLog: (from: number, limit: number) => Promise<LogEntry[]>,
): Promise<LogWindow> {
  const start = v.logStart ?? 0;
  let { log, base } = cur;
  if (reset || v.logLength < base + log.length) {
    log = [];
    base = start;
  }
  if (start > base) {
    log = log.slice(Math.min(log.length, start - base));
    base = start;
  }
  const end = base + log.length;
  if (v.logLength > end) {
    const more = await fetchLog(end, v.logLength - end);
    const first = more[0];
    if (first && first.id !== end) {
      // zwischenzeitlich getrimmt: lückenlos neu aufsetzen
      log = more;
      base = first.id;
    } else log = log.concat(more);
  }
  return { log, base };
}
