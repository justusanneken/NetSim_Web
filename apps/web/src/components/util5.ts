import { useCallback } from 'react';
import type { Result } from '@netsim/engine';
import { useStore } from '../store';

/** Führt einen Engine-Aufruf aus und zeigt Fehler als Hinweis; liefert `true` bei Erfolg. */
export function useCall(): <T>(p: Promise<Result<T>>, okToast?: string) => Promise<boolean> {
  const showToast = useStore((s) => s.showToast);
  return useCallback(
    async (p, okToast) => {
      const r = await p;
      if (!r.ok) {
        showToast(r.error, r.params);
        return false;
      }
      if (okToast) showToast(okToast, undefined, 'ok');
      return true;
    },
    [showToast],
  );
}

/** Epoch-ms → `YYYY-MM-DD HH:MM:SS` (UTC). */
export function fmtClock(ms: number | undefined): string {
  if (ms === undefined) return '–';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
